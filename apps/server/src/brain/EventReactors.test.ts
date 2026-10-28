// Durable events and the reactor host over a real pi-durable store (ADR 0033): an event exists
// exactly when the commit that emitted it does; a reactor handles each of its events once, oldest
// first, skipping other kinds; a throwing handler rolls back its writes with its cursor and is
// retried; the log rotates monthly and a reactor follows the marker into the next log; a task a
// handler creates runs once; and the status counts what is pending. The kill -9 half of the judge
// is `judges/events-kill.sh`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConversationId } from "@cairn/protocol/Ids";
import type { JsonValue } from "@earendil-works/chord";
import type { SessionDocToken, Tx } from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineExtension,
  defineTask,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Context, DateTime, Duration, Effect, Layer, Option } from "effect";
import type { Scope } from "effect";

import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { BrainStore } from "./BrainStore.ts";
import { durable } from "./Durable.ts";
import { EventReactors } from "./EventReactors.ts";
import type { EventDraft, EventsState, Reactor } from "./Events.ts";
import { emit, EventsDoc, monthOf, reactor } from "./Events.ts";
import { Extensions } from "./Extensions.ts";
import { ModelSource } from "./ModelSource.ts";
import { Parked } from "./Parked.ts";
import { piConversationId } from "./PiIds.ts";

/** What the test reactors write, through `tx` only. */
interface Seen {
  [key: string]: JsonValue;
  /** Handled event ids per reactor, in handling order. */
  handled: { [reactor: string]: Array<number> };
  /** Handler attempts per reactor and event, rolled back with a failed step. */
  attempts: { [key: string]: number };
  /** Tasks a handler created, by event id, and the times each ran to its end. */
  created: { [eventId: string]: number };
  ran: { [eventId: string]: number };
  /** The conversation the created tasks live in; 0 until the first. */
  home: number;
}

const SeenDoc = defineDoc<Seen>({
  kind: "cairn.test-events-seen",
  version: 1,
  scope: "session",
  initial: () => ({ handled: {}, attempts: {}, created: {}, ran: {}, home: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** A task a handler creates: it records that it ran, once, in its terminal commit. */
const RecordRun = defineTask<
  { readonly eventId: number },
  { readonly phase: "run" },
  number
>({
  name: "cairn.test-record-run",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const seen = await tx.doc(SeenDoc);
        const key = String(task.input.eventId);

        seen.ran[key] = (seen.ran[key] ?? 0) + 1;

        return {
          status: "terminal",
          outcome: { status: "completed", result: task.input.eventId },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context
    );
  },
});

const TestTasks = defineExtension({
  name: "cairn.test-events",
  tasks: [RecordRun],
});

const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const OCTOBER = epoch("2999-10-31T23:00:00Z");

const NOVEMBER = epoch("2999-11-01T00:30:00Z");

const record = async (tx: Tx, name: string, id: number) => {
  const seen = await tx.doc(SeenDoc);

  const handled = seen.handled[name] ?? [];

  handled.push(id);
  seen.handled[name] = handled;
};

/** Events the flaky reactor lets through; it throws on every other one after writing. */
const passing = new Set<number>();

/** Counts its attempt and records the event, then throws unless let through: both writes roll back. */
const flaky = (name: string) =>
  reactor(name, ["workflow.node.settled"], async (tx, event) => {
    const seen = await tx.doc(SeenDoc);
    const key = `${name}:${event.id}`;
    const attempts = (seen.attempts[key] ?? 0) + 1;

    seen.attempts[key] = attempts;
    await record(tx, name, event.id);

    if (!passing.has(event.id)) {
      throw new Error(`injected fault on ${event.id}`);
    }
  });

const brainLayer = (dataDir: string, reactors: ReadonlyArray<Reactor>) =>
  EventReactors.fromSources(reactors.map((each) => Effect.succeed(each))).pipe(
    Layer.provideMerge(
      Brain.layerNoDeps.pipe(
        Layer.provide(BrainStore.layer),
        Layer.provide(Arms.layer)
      )
    ),
    Layer.provide(Parked.layer),
    Layer.provide(
      Extensions.fromSources([
        Effect.succeed({ order: 900, extension: TestTasks }),
      ])
    ),
    Layer.provide(
      ModelSource.layerFaux({ tokensPerSecond: 2000, settings: {} })
    ),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

const withBrain = <A, E>(
  reactors: ReadonlyArray<Reactor>,
  use: (
    context: Context.Context<EventReactors | Brain>
  ) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-events-test-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.flatMap(Layer.build(brainLayer(dataDir, reactors)), use)
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

const commit = <A>(brain: Brain["Service"], change: (tx: Tx) => Promise<A>) =>
  Effect.flatMap(brain.session, (session) =>
    durable(
      "test.commit",
      async (context) => await session.harness.commit(change, context)
    )
  );

const emitOne = (brain: Brain["Service"], draft: EventDraft) =>
  commit(brain, async (tx) => {
    const event = await emit(tx, draft);

    return event.id;
  });

const settled = (at: number, n: number): EventDraft => ({
  name: "workflow.node.settled",
  data: { n },
  at,
});

const snapshot = <T extends Seen | EventsState>(
  brain: Brain["Service"],
  token: SessionDocToken<T>,
  initial: T
) =>
  Effect.flatMap(brain.session, (session) =>
    durable(
      "test.snapshot",
      async (context) =>
        (await session.harness.snapshot(token, context)) ?? initial
    )
  );

const readSeen = (brain: Brain["Service"]) =>
  snapshot(brain, SeenDoc, {
    handled: {},
    attempts: {},
    created: {},
    ran: {},
    home: 0,
  });

const readEvents = (brain: Brain["Service"]) =>
  snapshot(brain, EventsDoc, {
    logConversationId: null,
    logMonth: null,
    cursors: {},
  });

/** Polls until `done` holds, for up to ten seconds. */
const eventually = <E, R>(done: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* done) {
        return true;
      }

      yield* Effect.sleep(Duration.millis(50));
    }

    return false;
  });

/** True once every reactor has nothing pending. */
const caughtUp = (reactors: EventReactors["Service"]) =>
  Effect.map(reactors.status, (status) =>
    status.reactors.every((each) => each.lag === 0)
  );

describe("durable events", () => {
  it("monthOf is the UTC month", () => {
    assert.strictEqual(monthOf(OCTOBER), "2999-10");
    assert.strictEqual(monthOf(NOVEMBER), "2999-11");
  });

  it.live(
    "a reactor handles each of its events once, oldest first, and skips other kinds",
    () =>
      withBrain(
        [
          reactor("settled", ["workflow.node.settled"], async (tx, event) => {
            await record(tx, "settled", event.id);
          }),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            const first = yield* emitOne(brain, settled(OCTOBER, 1));

            yield* emitOne(brain, {
              name: "workflow.node.refused",
              data: { n: 2 },
              at: OCTOBER,
            });

            const third = yield* emitOne(brain, settled(OCTOBER, 3));

            const before = yield* reactors.status;

            assert.strictEqual(before.reactors[0]?.lag, 2, "lag before start");

            yield* reactors.start;
            assert.isTrue(yield* eventually(caughtUp(reactors)));

            const fourth = yield* emitOne(brain, settled(OCTOBER, 4));

            assert.isTrue(
              yield* eventually(
                Effect.map(
                  readSeen(brain),
                  (seen) => (seen.handled.settled ?? []).length === 3
                )
              )
            );

            const seen = yield* readSeen(brain);

            assert.deepStrictEqual(seen.handled.settled, [
              first,
              third,
              fourth,
            ]);

            const after = yield* reactors.status;

            assert.strictEqual(after.reactors[0]?.lag, 0);
            assert.isTrue(
              Option.isSome(after.reactors[0]?.lastHandledAt ?? Option.none())
            );
          })
      ),
    20_000
  );

  it.live("an event exists only when the commit that emitted it does", () =>
    withBrain([], (context) =>
      Effect.gen(function* () {
        const brain = Context.get(context, Brain);

        const failed = yield* Effect.flip(
          commit(brain, async (tx) => {
            await emit(tx, settled(OCTOBER, 1));

            throw new Error("the change failed");
          })
        );

        assert.include(failed.message, "the change failed");

        const state = yield* readEvents(brain);

        assert.strictEqual(state.logConversationId, null);
      })
    )
  );

  it.live(
    "a throwing handler rolls back its writes with its cursor and is retried until it passes",
    () =>
      withBrain([flaky("flaky")], (context) =>
        Effect.gen(function* () {
          const brain = Context.get(context, Brain);
          const reactors = Context.get(context, EventReactors);

          yield* reactors.start;

          const ids: Array<number> = [];

          for (let n = 1; n <= 3; n += 1) {
            ids.push(yield* emitOne(brain, settled(OCTOBER, n)));
          }

          // Every attempt throws after writing, and the rollback takes the writes and the cursor
          // with it: nothing recorded, no attempt counted, every event still pending.
          yield* Effect.sleep(Duration.millis(400));

          const stuck = yield* readSeen(brain);
          const status = yield* reactors.status;

          assert.deepStrictEqual(stuck.handled.flaky ?? [], []);
          assert.deepStrictEqual(stuck.attempts, {});
          assert.strictEqual(status.reactors[0]?.lag, 3);
          assert.isAbove(status.reactors[0]?.failuresInARow ?? 0, 0);
          assert.include(
            Option.getOrThrow(status.reactors[0]?.lastFailure ?? Option.none())
              .message,
            `injected fault on ${ids[0]}`
          );

          // Let every event pass: the next retry handles each once, in order.
          for (const id of ids) {
            passing.add(id);
          }

          assert.isTrue(yield* eventually(caughtUp(reactors)));

          const seen = yield* readSeen(brain);
          const after = yield* reactors.status;

          assert.deepStrictEqual(seen.handled.flaky, ids);
          assert.strictEqual(after.reactors[0]?.failuresInARow, 0);
        })
      ),
    20_000
  );

  it.live(
    "the log rotates at a new month and a reactor follows the marker into the next log",
    () =>
      withBrain(
        [
          reactor("settled", ["workflow.node.settled"], async (tx, event) => {
            await record(tx, "settled", event.id);
          }),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            // Registered and stopped before any event: its cursor waits at the start of the first
            // log, opened in the current month. The test months lie far ahead, so the October event
            // rotates once and November once more, whenever the test runs.
            yield* reactors.start;
            yield* reactors.stop;

            const october = yield* emitOne(brain, settled(OCTOBER, 1));
            const first = yield* readEvents(brain);
            const november = yield* emitOne(brain, settled(NOVEMBER, 2));
            // A late clock never rotates back.
            const late = yield* emitOne(brain, settled(OCTOBER, 3));
            const second = yield* readEvents(brain);

            assert.strictEqual(first.logMonth, "2999-10");
            assert.strictEqual(second.logMonth, "2999-11");
            assert.notStrictEqual(
              second.logConversationId,
              first.logConversationId
            );

            yield* reactors.start;
            assert.isTrue(yield* eventually(caughtUp(reactors)));

            const seen = yield* readSeen(brain);
            const state = yield* readEvents(brain);

            assert.deepStrictEqual(seen.handled.settled, [
              october,
              november,
              late,
            ]);
            assert.deepStrictEqual(state.cursors.settled, {
              logConversationId: second.logConversationId ?? 0,
              entryId: late,
            });
          })
      ),
    20_000
  );

  it.live(
    "a task a handler creates is created once and runs once",
    () =>
      withBrain(
        [
          reactor("spawn", ["workflow.node.settled"], async (tx, event) => {
            const seen = await tx.doc(SeenDoc);
            let { home } = seen;

            if (home === 0) {
              const created = await tx.createConversation({
                ownership: { kind: "ownerless" },
              });

              home = created.id;
              seen.home = home;
            }

            const key = String(event.id);

            seen.created[key] = (seen.created[key] ?? 0) + 1;
            await tx.createTask(
              RecordRun,
              { eventId: event.id },
              {
                ownership: { kind: "conversation" },
                conversationId: piConversationId(ConversationId.make(home)),
                background: true,
              }
            );
          }),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            yield* reactors.start;
            yield* brain.resume;

            const ids: Array<number> = [];

            for (let n = 1; n <= 4; n += 1) {
              ids.push(yield* emitOne(brain, settled(OCTOBER, n)));
            }

            assert.isTrue(
              yield* eventually(
                Effect.map(
                  readSeen(brain),
                  (seen) => Object.keys(seen.ran).length === ids.length
                )
              )
            );

            const seen = yield* readSeen(brain);

            for (const id of ids) {
              assert.strictEqual(seen.created[String(id)], 1, `created ${id}`);
              assert.strictEqual(seen.ran[String(id)], 1, `ran ${id}`);
            }
          })
      ),
    20_000
  );
});
