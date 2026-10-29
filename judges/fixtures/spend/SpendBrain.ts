// The judge brain of `judges/spend-kill.ts` (J-spend, ADR 0036): Cairn's own `Brain`, the spend
// feed and ledger, and the shell store, over a scratch directory (its own `brain.sqlite` and
// `cairn.sqlite`, never the deployed unit's). Four threads talk to pi-ai's faux provider: three on
// the Claude bridge's id (zero recorded cost, priced as the `anthropic` twin, whose tier starts at
// 2,000 input tokens so a long thread crosses it) and one on an unpriced model. The orchestrator
// `kill -9`s it again and again; the last life runs every turn, waits for the ledger, then writes
// `report.json` and exits.
//
//   node judges/fixtures/spend/SpendBrain.ts --dir <run> --turns N [--control] [--retry-parked]
//
// - Boot: the ledger's reconcile (the boot repair), then the Harness resumes.
// - Producer: turn n goes to thread n % 4 with request id `turn-<n>`, so a turn a killed life
//   already admitted is not admitted twice; each round waits for its four threads.
// - Truth, computed here and not by the ledger: each conversation's `pi.usage` tokens, and each of
//   its own assistant responses priced alone with pi-ai's `calculateCost` at the twin's catalog.
// - `--retry-parked` (the last life): retries every task the crash-loop guard parked before the
//   Harness resumes, so five kills that land on one request do not leave its turn parked.
// - `--control`: the broken control, a ledger that adds each response it reads and, at boot,
//   catches up by adding every response again (its cursor lived in memory), so each life counts
//   what earlier lives counted once more.
//
// Prints `producing` once the producer runs and `done` after the report.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ConversationId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import type { SpendSummary } from "@cairn/protocol/Spend";
import {
  calculateCost,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { configure, UsageDoc } from "@earendil-works/pi-durable";
import { NodeRuntime } from "@effect/platform-node";
import {
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import { Arms } from "../../../apps/server/src/brain/Arms.ts";
import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { BrainConfig } from "../../../apps/server/src/brain/BrainConfig.ts";
import { BrainStore } from "../../../apps/server/src/brain/BrainStore.ts";
import {
  ThreadMeta,
  ThreadReceipt,
} from "../../../apps/server/src/brain/CairnDocs.ts";
import { durable } from "../../../apps/server/src/brain/Durable.ts";
import { Extensions } from "../../../apps/server/src/brain/Extensions.ts";
import {
  BASE_HARNESS_SETTINGS,
  ModelSource,
} from "../../../apps/server/src/brain/ModelSource.ts";
import { Parked } from "../../../apps/server/src/brain/Parked.ts";
import { piConversationId } from "../../../apps/server/src/brain/PiIds.ts";
import { SpendFeed } from "../../../apps/server/src/brain/SpendFeed.ts";
import type { RecordedUsage } from "../../../apps/server/src/brain/SpendFeed.ts";
import {
  piUsageOf,
  TWIN_RATES,
} from "../../../apps/server/src/brain/SpendTestKit.ts";
import { Database } from "../../../apps/server/src/db/Database.ts";
import { migrations } from "../../../apps/server/src/db/Migrations.ts";
import { Spend0009 } from "../../../apps/server/src/db/migrations/0009Spend.ts";
import { EventSink } from "../../../apps/server/src/shell/EventSink.ts";
import { ShellStoreLayer } from "../../../apps/server/src/shell/ShellLayer.ts";
import {
  createProject,
  createThread,
  testThreadId,
} from "../../../apps/server/src/shell/ShellTestKit.ts";
import { ThreadRows } from "../../../apps/server/src/shell/ThreadRows.ts";
import { SpendLedger } from "../../../apps/server/src/usage/SpendLedger.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    turns: { type: "string", default: "48" },
    control: { type: "boolean", default: false },
    "retry-parked": { type: "boolean", default: false },
  },
});

const dir = path.resolve(values.dir ?? ".");

const turns = Number(values.turns);

const THREADS = 4;

const BRIDGE: ModelRef = {
  provider: "claude-bridge",
  modelId: "claude-haiku-5-5",
};

const FREE: ModelRef = { provider: "opencode-go", modelId: "beam-free" };

/** Thread 4 runs on the unpriced model; the others on the bridge. */
const modelOf = (thread: number) => (thread === THREADS ? FREE : BRIDGE);

const keyOf = (model: ModelRef) => `${model.provider}/${model.modelId}`;

// The catalog: the twin with its tier, and the two answering providers.
const twin = fauxProvider({
  provider: "anthropic",
  models: [
    {
      id: BRIDGE.modelId,
      cost: {
        input: TWIN_RATES.input,
        output: TWIN_RATES.output,
        cacheRead: TWIN_RATES.cacheRead,
        cacheWrite: TWIN_RATES.cacheWrite,
      },
    },
  ],
});

for (const model of twin.models) {
  model.cost.tiers = [TWIN_RATES.tier];
}

const answers = Array.from({ length: turns * 2 + 10 }, (_, n) =>
  fauxAssistantMessage(
    `Answer ${n}: ${"the ledger counts every response once ".repeat(48)}`
  )
);

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const bridge = fauxProvider({
  provider: BRIDGE.provider,
  models: [{ id: BRIDGE.modelId, cost: zero }],
  tokensPerSecond: 600,
});

bridge.setResponses(answers);

const free = fauxProvider({
  provider: FREE.provider,
  models: [{ id: FREE.modelId, cost: zero }],
  tokensPerSecond: 600,
});

free.setResponses(answers);

const models = createModels();

for (const provider of [twin.provider, bridge.provider, free.provider]) {
  models.setProvider(provider);
}

const twinModel = models.getModel("anthropic", BRIDGE.modelId);

/** pi-ai's price of one bridge response at the twin's list price, in micros. */
const twinMicros = (usage: RecordedUsage) =>
  twinModel === undefined
    ? Number.NaN
    : Math.round(calculateCost(twinModel, piUsageOf(usage)).total * 1_000_000);

const Models = Layer.succeed(
  ModelSource,
  ModelSource.of({
    models: () => models,
    settings: () => ({ ...BASE_HARNESS_SETTINGS, retry: { enabled: false } }),
    completeSimple: () => Effect.die("the spend judge makes no direct calls"),
  })
);

const BrainLayer = Brain.layerNoDeps.pipe(
  Layer.provide(BrainStore.layer),
  Layer.provide(Arms.layer),
  Layer.provide(Parked.layer),
  Layer.provide(Extensions.fromSources<never, never>([])),
  Layer.provide(Models),
  Layer.provide(BrainConfig.layerFrom(dir))
);

const DatabaseLive = Database.layer({
  filename: path.join(dir, "cairn.sqlite"),
  migrations: { ...migrations, "0009_Spend": Spend0009 },
});

/** One ledger row as the report carries it. */
const LedgerRow = Schema.Struct({
  conversation_id: Schema.Int,
  model_key: Schema.String,
  input: Schema.Int,
  output: Schema.Int,
  list_micros: Schema.NullOr(Schema.Int),
  unpriced_tokens: Schema.Int,
});

const decodeLedger = Schema.decodeUnknownEffect(Schema.Array(LedgerRow));

/** What the judge brain computed itself for one conversation. */
interface Truth {
  readonly thread: number;
  readonly key: string;
  readonly responses: number;
  readonly input: number;
  readonly output: number;
  readonly tokens: number;
  /** None for the unpriced model. */
  readonly listMicros: number | null;
  /** The wrong figure: the whole `pi.usage` sum priced as one request (it crosses the tier). */
  readonly sumPricedMicros: number | null;
}

// The broken control: adds what it reads, and at boot adds every response again.
const CONTROL_TABLE = "control_totals";

const controlAdd = (
  conversationId: number,
  key: string,
  usage: RecordedUsage
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const listed = key === keyOf(BRIDGE) ? twinMicros(usage) : null;

    yield* sql`
      INSERT INTO ${sql(CONTROL_TABLE)} (conversation_id, model_key, input, output, list_micros)
      VALUES (${conversationId}, ${key}, ${usage.input}, ${usage.output}, ${listed})
      ON CONFLICT (conversation_id, model_key) DO UPDATE SET
        input = input + excluded.input,
        output = output + excluded.output,
        list_micros = list_micros + excluded.list_micros
    `;
  });

const SpendLayer = values.control
  ? Layer.mergeAll(
      SpendFeed.layer,
      ShellStoreLayer,
      // The control keeps its own table; the real ledger is not built.
      Layer.succeed(
        SpendLedger,
        SpendLedger.of({
          reconcile: Effect.die("the control has no reconcile"),
          recordCall: () => Effect.die("the control records no calls"),
          rollup: () => Effect.die("the control has no roll-up"),
          flush: Effect.void,
          changes: Stream.empty,
          touch: () => Effect.void,
          parents: Effect.succeed(new Map()),
        })
      )
    )
  : SpendLedger.layerNoDeps.pipe(
      Layer.provideMerge(SpendFeed.layer),
      Layer.provideMerge(ShellStoreLayer),
      Layer.provide(Models)
    );

const JudgeLayer = SpendLayer.pipe(
  Layer.provideMerge(BrainLayer),
  Layer.provideMerge(DatabaseLive)
);

/** Every conversation's own responses, read from the store. */
const responsesOf = (conversationId: number) =>
  Effect.gen(function* () {
    const feed = yield* SpendFeed;

    return yield* feed.responses(
      ConversationId.make(conversationId),
      Option.none()
    );
  });

/** A shell row and a conversation per thread, both idempotent across lives. */
const ensureThreads = Effect.gen(function* () {
  const brain = yield* Brain;
  const sink = yield* EventSink;
  const project = createProject(1);
  const conversations = new Map<number, number>();

  yield* sink.commitCommand(project.command);

  for (let thread = 1; thread <= THREADS; thread += 1) {
    const threadId: ThreadId = testThreadId(thread);
    const model = modelOf(thread);

    yield* sink.commitCommand(createThread(project.projectId, thread));

    const session = yield* brain.session;

    const id = yield* durable(
      "judge.ensure",
      async (context) =>
        await session.harness.commit(async (tx) => {
          const receipt = await tx.doc(ThreadReceipt, threadId, {
            conversationId: 0,
          });

          if (receipt.conversationId > 0) {
            return receipt.conversationId;
          }

          const record = await tx.createConversation({
            ownership: { kind: "ownerless" },
          });

          await configure(tx, record.id, { model, thinkingLevel: "off" });

          const meta = await tx.doc(ThreadMeta, record.id);

          meta.threadId = threadId;
          meta.projectId = project.projectId;
          receipt.conversationId = record.id;

          return record.id;
        }, context)
    );

    conversations.set(thread, id);
  }

  return conversations;
});

/** The control's boot: add every response again, then add each reading's as it comes. */
const bootControl = Effect.fnUntraced(function* (
  conversations: ReadonlyMap<number, number>
) {
  const sql = yield* SqlClient.SqlClient;
  const feed = yield* SpendFeed;

  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(CONTROL_TABLE)} (
      conversation_id INTEGER NOT NULL,
      model_key TEXT NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      list_micros INTEGER,
      PRIMARY KEY (conversation_id, model_key)
    )
  `;

  for (const id of conversations.values()) {
    for (const response of yield* responsesOf(id)) {
      yield* controlAdd(id, response.modelKey, response.usage);
    }
  }

  yield* feed.readings.pipe(
    Stream.runForEach((reading) =>
      Effect.forEach(
        reading.responses,
        (response) =>
          controlAdd(reading.conversationId, response.modelKey, response.usage),
        { discard: true }
      )
    ),
    Effect.forkScoped
  );
});

/**
 * The last life's boot: runs again every task the crash-loop guard parked. Five kills that land
 * while a thread waits on its request park its generation (`restart_limit`), and nothing else in
 * this brain retries it, so without this the last life would wait for a turn that never runs.
 */
const retryParked = Effect.gen(function* () {
  const brain = yield* Brain;
  const session = yield* brain.session;

  const inspection = yield* durable(
    "judge.inspect",
    async (context) => await session.harness.inspect(context)
  );

  let retried = 0;

  for (const { record, state } of inspection.tasks) {
    if (state.kind === "blocked" && state.reason === "restart_limit") {
      yield* durable("judge.retry", async (context) => {
        await session.harness.retryTask(record.id, context);
      });
      retried += 1;
    }
  }

  return retried;
});

/** Every turn, a round of four at a time; an admitted turn is not admitted again. */
const produce = Effect.fnUntraced(function* (
  conversations: ReadonlyMap<number, number>
) {
  const brain = yield* Brain;

  for (let round = 0; round * THREADS < turns; round += 1) {
    const session = yield* brain.session;

    for (const [thread, id] of conversations) {
      const turn = round * THREADS + thread;

      if (turn <= turns) {
        yield* durable("judge.turn", async (context) => {
          const conversation = await session.harness.conversation(
            piConversationId(ConversationId.make(id)),
            context
          );

          if (conversation === undefined) {
            return;
          }

          await conversation.submit(
            {
              type: "input",
              content: `turn ${turn}`,
              requestId: `turn-${turn}`,
            },
            context
          );
        });
      }
    }

    yield* durable("judge.idle", async (context) => {
      await session.harness.waitForIdle(context);
    });
  }
});

/** The sum of a usage's tokens. */
const tokensIn = (usage: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

/** Tokens from each `pi.usage`, list price per response from pi-ai's own arithmetic. */
const computeTruth = Effect.fnUntraced(function* (
  conversations: ReadonlyMap<number, number>
) {
  const brain = yield* Brain;
  const session = yield* brain.session;
  const truth = new Map<number, Truth>();

  for (const [thread, id] of conversations) {
    const usage = yield* durable(
      "judge.usage",
      async (context) =>
        await session.harness.snapshot(
          UsageDoc,
          piConversationId(ConversationId.make(id)),
          context
        )
    );

    const responses = yield* responsesOf(id);
    const key = keyOf(modelOf(thread));
    const totals = Option.fromUndefinedOr(usage?.models[key]);
    const priced = key === keyOf(BRIDGE);

    truth.set(id, {
      thread,
      key,
      responses: responses.length,
      input: Option.match(totals, { onNone: () => 0, onSome: (t) => t.input }),
      output: Option.match(totals, {
        onNone: () => 0,
        onSome: (t) => t.output,
      }),
      tokens: Option.match(totals, { onNone: () => 0, onSome: tokensIn }),
      listMicros: priced
        ? responses.reduce((sum, each) => sum + twinMicros(each.usage), 0)
        : null,
      sumPricedMicros: priced
        ? Option.match(totals, {
            onNone: () => 0,
            onSome: (t) =>
              twinMicros({
                input: t.input,
                output: t.output,
                cacheRead: t.cacheRead,
                cacheWrite: t.cacheWrite,
                cacheWrite1h: t.cacheWrite1h ?? 0,
                reasoning: Option.none(),
                costTotal: 0,
              }),
          })
        : null,
    });
  }

  return truth;
});

/** Flushes the real ledger; the control has nothing to flush. */
const flushLedger = values.control
  ? Effect.void
  : SpendLedger.use((ledger) => ledger.flush);

/** The ledger's rows once they caught up with the truth, or after ten seconds. */
const readLedger = Effect.fnUntraced(function* (
  truth: ReadonlyMap<number, Truth>
) {
  const sql = yield* SqlClient.SqlClient;

  const read = values.control
    ? sql`SELECT conversation_id, model_key, input, output, list_micros, 0 AS unpriced_tokens FROM ${sql(CONTROL_TABLE)}`
    : sql`SELECT conversation_id, model_key, input, output, list_micros, unpriced_tokens FROM spend_totals`;

  let ledger: ReadonlyArray<typeof LedgerRow.Type> = [];

  for (let tries = 0; tries < 50; tries += 1) {
    yield* flushLedger;

    const rows = yield* read.pipe(Effect.flatMap(decodeLedger));

    ledger = rows;

    const caughtUp = [...truth].every(([id, expected]) =>
      rows.some(
        (row) => row.conversation_id === id && row.input === expected.input
      )
    );

    if (caughtUp) {
      return ledger;
    }

    yield* Effect.sleep(Duration.millis(200));
  }

  return ledger;
});

/** Each thread row's spend figure, after the ledger's last commit. */
const readShell = Effect.gen(function* () {
  const rows = yield* ThreadRows;
  const shell: Record<string, SpendSummary | null> = {};

  yield* Effect.sleep(Duration.millis(200));
  yield* flushLedger;

  for (let thread = 1; thread <= THREADS; thread += 1) {
    const row = yield* rows.get(testThreadId(thread));

    shell[String(thread)] = Option.getOrNull(
      Option.flatMap(row, (found) => found.shell.spend)
    );
  }

  return shell;
});

const program = Effect.gen(function* () {
  const brain = yield* Brain;
  const conversations = yield* ensureThreads;

  // Boot: the reconcile (the control's catch-up), then the Harness resumes.
  if (values.control) {
    yield* bootControl(conversations);
  } else {
    const report = yield* SpendLedger.use((ledger) => ledger.reconcile);

    yield* Console.error(JSON.stringify({ reconcile: report }));
  }

  if (values["retry-parked"]) {
    writeFileSync(
      path.join(dir, "retried.json"),
      JSON.stringify(yield* retryParked)
    );
  }

  yield* brain.resume;
  yield* Console.log("producing");
  yield* produce(conversations);

  const truth = yield* computeTruth(conversations);
  const ledger = yield* readLedger(truth);
  const shell = values.control ? {} : yield* readShell;

  writeFileSync(
    path.join(dir, "report.json"),
    JSON.stringify({
      truth: Object.fromEntries(truth),
      ledger,
      shell,
      conversations: [...conversations],
    })
  );

  yield* Console.log("done");
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(JudgeLayer), Effect.orDie)
);
