// Fixtures for the budget tests: the real spend ledger over the scripted feed and a migrated
// in-memory `cairn.sqlite`, the real book and `Budgets`, and budget sources held in memory that keep
// the documents' contract (a scope as raised, a notice and a raise written once per id, `halt`
// recorded); plus a harness seam that records stops and plays events, and a notifier that records
// pushes, for the guard.

import type { ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { ThreadLineage } from "@cairn/protocol/Subagents";
import type { NoticeEntryData } from "@cairn/protocol/Thread";
import {
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import { BudgetSources } from "../brain/BudgetSources.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { HarnessEvent, StopOptions } from "../brain/HarnessSeam.ts";
import { ModelSource } from "../brain/ModelSource.ts";
import { spendCatalog, SpendFeedScripted } from "../brain/SpendTestKit.ts";
import { Database } from "../db/Database.ts";
import { Spend0009 } from "../db/migrations/0009Spend.ts";
import { Notifier } from "../push/Notifier.ts";
import type { PushMessage } from "../push/Notifier.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ShellStoreLayer } from "../shell/ShellLayer.ts";
import {
  createProject,
  createThread,
  shellMigrations,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetBook } from "./BudgetBook.ts";
import type { BudgetMode, ScopeLimit } from "./BudgetBook.ts";
import { BudgetGuard } from "./BudgetGuard.ts";
import { Budgets } from "./Budgets.ts";
import { SpendLedger } from "./SpendLedger.ts";

/** A budget of `tokens` tokens, warning at 80 percent. */
export const tokenBudget = (tokens: number): Budget => ({
  ...DEFAULT_BUDGET,
  maxTokens: tokens,
});

/** What the in-memory sources were asked to write. */
export interface SourcesRecord {
  readonly scopes: Ref.Ref<ReadonlyMap<ThreadId, ScopeLimit>>;
  /** Notices by `<thread> <request id>`. */
  readonly notices: Ref.Ref<ReadonlyMap<string, NoticeEntryData>>;
  /** Raises by `<thread> <epoch>`, with the budget proposed. */
  readonly raises: Ref.Ref<ReadonlyMap<string, Budget>>;
  /** Every `halt` call's threads. */
  readonly halted: Ref.Ref<ReadonlyArray<ReadonlyArray<ThreadId>>>;
}

/** The in-memory sources' record. */
export class SourcesScript extends Context.Service<
  SourcesScript,
  SourcesRecord
>()("cairn/server/usage/BudgetTestKit/SourcesScript") {}

/** Sets `key` once: true when this call set it. */
const once = <A>(ref: Ref.Ref<ReadonlyMap<string, A>>, key: string, value: A) =>
  Ref.modify(ref, (current) =>
    current.has(key)
      ? [false, current]
      : [true, new Map(current).set(key, value)]
  );

/** `BudgetSources` in memory, and its `SourcesScript`. */
export const SourcesMemory = Layer.effectContext(
  Effect.gen(function* () {
    const record: SourcesRecord = {
      scopes: yield* Ref.make<ReadonlyMap<ThreadId, ScopeLimit>>(new Map()),
      notices: yield* Ref.make<ReadonlyMap<string, NoticeEntryData>>(new Map()),
      raises: yield* Ref.make<ReadonlyMap<string, Budget>>(new Map()),
      halted: yield* Ref.make<ReadonlyArray<ReadonlyArray<ThreadId>>>([]),
    };

    const sources = BudgetSources.of({
      scopes: Effect.map(Ref.get(record.scopes), (map) => [...map.values()]),
      scopeOf: (threadId) =>
        Effect.map(Ref.get(record.scopes), (map) =>
          Option.fromUndefinedOr(map.get(threadId))
        ),
      declare: (threadId: ThreadId, budget: Budget, mode: BudgetMode) =>
        Ref.update(record.scopes, (map) =>
          new Map(map).set(threadId, { threadId, budget, mode, epoch: 0 })
        ),
      askRaise: (limit, to) =>
        once(record.raises, `${limit.threadId} ${limit.epoch}`, to),
      notice: (threadId, requestId, data) =>
        once(record.notices, `${threadId} ${requestId}`, data),
      samples: Effect.succeed([]),
      halt: (threads) =>
        Ref.update(record.halted, (calls) => [...calls, threads]).pipe(
          Effect.as(threads.length)
        ),
    });

    return Context.make(BudgetSources, sources).pipe(
      Context.add(SourcesScript, SourcesScript.of(record))
    );
  })
);

const catalog = spendCatalog();

const Models = Layer.mock(ModelSource)({
  models: () => catalog,
  settings: () => ({}),
});

/**
 * `Budgets` over the real book and ledger (scripted feed, in-memory database, shell store) and the
 * in-memory sources. The book is given to the ledger too, as in the app.
 */
export const BudgetsWorld = Budgets.layerNoDeps.pipe(
  Layer.provideMerge(SourcesMemory),
  Layer.provideMerge(SpendLedger.layerNoDeps),
  Layer.provideMerge(BudgetBook.layer),
  Layer.provideMerge(SpendFeedScripted),
  Layer.provideMerge(ShellStoreLayer),
  Layer.provideMerge(Models),
  Layer.provideMerge(
    Database.layerTest({ ...shellMigrations, "0009_Spend": Spend0009 })
  )
);

/** What the guard's fakes recorded. */
export interface GuardRecord {
  readonly stops: Ref.Ref<
    ReadonlyArray<{ threadId: ThreadId; options: StopOptions }>
  >;
  readonly pushes: Ref.Ref<ReadonlyArray<PushMessage>>;
  readonly events: PubSub.PubSub<HarnessEvent>;
}

/** The guard's fakes' record. */
export class GuardScript extends Context.Service<GuardScript, GuardRecord>()(
  "cairn/server/usage/BudgetTestKit/GuardScript"
) {}

const GuardRecordLayer = Layer.effect(
  GuardScript,
  Effect.gen(function* () {
    return GuardScript.of({
      stops: yield* Ref.make<
        ReadonlyArray<{ threadId: ThreadId; options: StopOptions }>
      >([]),
      pushes: yield* Ref.make<ReadonlyArray<PushMessage>>([]),
      events: yield* PubSub.unbounded<HarnessEvent>(),
    });
  })
);

/** A seam that records stops and plays `events`, and a notifier that records pushes. */
const GuardFakes = Layer.unwrap(
  Effect.gen(function* () {
    const record = yield* GuardScript;

    return Layer.mergeAll(
      Layer.mock(HarnessSeam)({
        stop: (threadId, options) =>
          Ref.update(record.stops, (stops) => [
            ...stops,
            { threadId, options },
          ]),
        events: Stream.fromPubSub(record.events),
        capabilities: { durable: false, live: false },
      }),
      Layer.mock(Notifier)({
        sendToAll: (message) =>
          Ref.update(record.pushes, (pushes) => [...pushes, message]).pipe(
            Effect.as(["delivered" as const])
          ),
      })
    );
  })
).pipe(Layer.provideMerge(GuardRecordLayer));

/** The guard over `BudgetsWorld` and the fakes. */
export const GuardWorld = BudgetGuard.layerNoDeps.pipe(
  Layer.provideMerge(GuardFakes),
  Layer.provideMerge(BudgetsWorld)
);

const decodeLineage = Schema.decodeEffect(ThreadLineage);

/**
 * A project with thread 1 and, for each `[child, parent]` pair, a thread whose lineage names its
 * parent. Returns the thread ids by number.
 */
export const withThreads = (tree: ReadonlyArray<readonly [number, number]>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const rows = yield* ThreadRows;
    const sql = yield* SqlClient.SqlClient;
    const project = createProject(1);

    yield* sink.commitCommand(project.command);
    yield* sink.commitCommand(createThread(project.projectId, 1));

    for (const [child, parent] of tree) {
      yield* sink.commitCommand(createThread(project.projectId, child));

      const row = yield* rows.get(testThreadId(child));

      if (Option.isSome(row)) {
        const lineage = yield* decodeLineage({
          parentThreadId: testThreadId(parent),
          relationshipToParent: "subagent",
          rootThreadId: testThreadId(1),
        });

        yield* sql.withTransaction(
          rows.write({
            ...row.value,
            shell: { ...row.value.shell, lineage: Option.some(lineage) },
          })
        );
      }
    }
  });

/** Lets the ledger take every reading offered so far, then commits pending row figures. */
export const settle = Effect.gen(function* () {
  yield* Effect.sleep("20 millis");
  yield* (yield* SpendLedger).flush;
});
