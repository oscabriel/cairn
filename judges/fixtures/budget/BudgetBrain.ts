// The judge brain of `judges/budget-kill.ts` (J-budget, ADR 0036): Cairn's pi-durable harness behind
// the seam, the spend feed and ledger, the shell store, and the budgets (book, sources, `Budgets`,
// the guard and the `cairn.budgets` gate), over a scratch directory, never the deployed unit's.
//
// One scope thread (thread 1) declares a `stop` budget of `--budget-children` children's worth of
// list price; `--children` subagent threads under it (lineage parent thread 1) each get one input
// and answer from pi-ai's faux provider: `--steps - 1` calls of the `tick` tool, then a final text.
// Only output tokens are priced, so every tool-calling response costs the same.
//
//   node judges/fixtures/budget/BudgetBrain.ts --dir <run> [--final] [--control no-stop|no-boot]
//
// Each life boots in the order the brain's boot repairs must: the ledger's reconcile, the budget
// guard's boot repair (halt a stopped scope before anything can start scheduling; under `--control
// no-boot` earlier lives only read the book and the last life has no repair), then the repairs that retry parked tasks (pi-durable's `retryTask` resumes
// scheduling), the budget declared in the first life only, then the Harness resumes
// and every child's input is submitted (request id `work-<n>`, so a killed life's input lands
// once). A life that boots with the scope past its line prints `exhausted` before the Harness
// resumes. The guard's first stop prints `stopping`; each later stop in that pass waits
// `--stagger-ms` more, so a kill lands while it is stopping. `--control no-stop` stops nothing and
// halts nothing; the gate stays, as in production, and the children here never delegate. Pushes
// are appended to `pushes.log` instead of sent.
//
// `--final` waits for every child to go idle, writes `report.json` (spend, the line, each child's
// responses at boot and at the end, notices, the row's budget word, pushes), then answers the raise
// as the user, sends one child more work (`retry-1`) and writes `raise.json`, then prints `done`.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ApprovalId, ConversationId, ProjectId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import { DEFAULT_BUDGET, Micros, SpendScope } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { ThreadLineage } from "@cairn/protocol/Subagents";
import { NOTICE_ENTRY_KIND } from "@cairn/protocol/Thread";
import { createModels, Type } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { NodeRuntime } from "@effect/platform-node";
import {
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";

import { retryParkedApprovalWaits } from "../../../apps/server/src/Boot.ts";
import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { BrainConfig } from "../../../apps/server/src/brain/BrainConfig.ts";
import { BudgetSources } from "../../../apps/server/src/brain/BudgetSources.ts";
import { ThreadReceipt } from "../../../apps/server/src/brain/CairnDocs.ts";
import { durable } from "../../../apps/server/src/brain/Durable.ts";
import type { CairnExtension } from "../../../apps/server/src/brain/Extensions.ts";
import { ExtensionSet } from "../../../apps/server/src/brain/ExtensionSet.ts";
import { HarnessSeam } from "../../../apps/server/src/brain/HarnessSeam.ts";
import {
  BASE_HARNESS_SETTINGS,
  ModelSource,
} from "../../../apps/server/src/brain/ModelSource.ts";
import { PiDurableHarness } from "../../../apps/server/src/brain/PiDurableHarness.ts";
import { piConversationId } from "../../../apps/server/src/brain/PiIds.ts";
import { SpendFeed } from "../../../apps/server/src/brain/SpendFeed.ts";
import { Database } from "../../../apps/server/src/db/Database.ts";
import { migrations } from "../../../apps/server/src/db/Migrations.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { ModelHealth } from "../../../apps/server/src/models/ModelHealth.ts";
import { PiModelSource } from "../../../apps/server/src/models/PiModelSource.ts";
import { SettingsStore } from "../../../apps/server/src/models/SettingsStore.ts";
import { PiHost } from "../../../apps/server/src/pi-host/PiHost.ts";
import { Notifier } from "../../../apps/server/src/push/Notifier.ts";
import { ReachServicesTest } from "../../../apps/server/src/reach/ReachLayer.ts";
import { EventSink } from "../../../apps/server/src/shell/EventSink.ts";
import { ShellStoreLayer } from "../../../apps/server/src/shell/ShellLayer.ts";
import {
  createProject,
  createThread,
  testThreadId,
} from "../../../apps/server/src/shell/ShellTestKit.ts";
import { ThreadRows } from "../../../apps/server/src/shell/ThreadRows.ts";
import { retryParkedSubagentTasks } from "../../../apps/server/src/subagents/SubagentRepairs.ts";
import { Subagents } from "../../../apps/server/src/subagents/Subagents.ts";
import { BudgetBook } from "../../../apps/server/src/usage/BudgetBook.ts";
import { BudgetGuard } from "../../../apps/server/src/usage/BudgetGuard.ts";
import { Budgets } from "../../../apps/server/src/usage/Budgets.ts";
import { SpendLedger } from "../../../apps/server/src/usage/SpendLedger.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    final: { type: "boolean", default: false },
    control: { type: "string", default: "none" },
    children: { type: "string", default: "10" },
    steps: { type: "string", default: "6" },
    "budget-children": { type: "string", default: "4" },
    "stagger-ms": { type: "string", default: "10" },
    "tokens-per-second": { type: "string", default: "120" },
  },
});

const dir = path.resolve(values.dir ?? ".");

const CHILDREN = Number(values.children);

const STEPS = Number(values.steps);

const STAGGER = Duration.millis(Number(values["stagger-ms"]));

const noStop = values.control === "no-stop";

const noBoot = values.control === "no-boot";

const SCOPE = testThreadId(1);

const childOf = (n: number) => testThreadId(n + 1);

const CHILD_IDS = Array.from({ length: CHILDREN }, (_, n) => childOf(n + 1));

const MODEL: ModelRef = { provider: "judge-priced", modelId: "budget-judge" };

/** Dollars per million output tokens; input is free, so each response costs the same. */
const OUTPUT_RATE = 50;

/** A tool call's padding: about 75 output tokens, priced at 3,750 micros. */
const PAD = "spend ".repeat(50);

/** The `tick` call a child makes `STEPS - 1` times; then it answers. */
const answer = (context: TranscriptContext) => {
  const last = context.messages.findLastIndex(
    (message) => message.role === "user"
  );

  const done = context.messages
    .slice(last + 1)
    .filter((message) => message.role === "assistant").length;

  return done < STEPS - 1
    ? fauxAssistantMessage(
        [fauxToolCall("tick", { pad: PAD }, { id: `tick-${String(done)}` })],
        { stopReason: "toolUse" }
      )
    : fauxAssistantMessage(`done ${PAD}`);
};

const faux = fauxProvider({
  provider: MODEL.provider,
  models: [
    {
      id: MODEL.modelId,
      cost: { input: 0, output: OUTPUT_RATE, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  tokensPerSecond: Number(values["tokens-per-second"]),
});

faux.setResponses(Array.from({ length: 100_000 }, () => answer));

const models = createModels();

models.setProvider(faux.provider);

const Models = Layer.succeed(
  ModelSource,
  ModelSource.of({
    models: () => models,
    settings: () => ({ ...BASE_HARNESS_SETTINGS, retry: { enabled: false } }),
    completeSimple: () => Effect.die("the budget judge makes no direct calls"),
  })
);

const text = (value: string) => [{ type: "text" as const, text: value }];

const tick = defineTool({
  name: "tick",
  description: "Counts one step of work.",
  parameters: Type.Object({ pad: Type.String() }),
  replay: "safe",
  execute: async () => await Promise.resolve({ output: text("ticked") }),
});

const tickExtension: CairnExtension = {
  order: 905,
  extension: defineExtension({ name: "judge.budget-tick", tools: [tick] }),
};

/**
 * The extension set: production, which carries the budget gate over the judge's `BudgetBook` (one
 * book, by reference, as in `AppLayer`), and `tick`.
 */
const Extensions = ExtensionSet.withExtra([tickExtension]).pipe(
  Layer.provide(ExecutorLink.layerDisabled),
  Layer.provide(PiHost.layerEmpty),
  Layer.provide(ModelHealth.layerTest),
  Layer.provide(SettingsStore.layerTest),
  Layer.provide(ReachServicesTest),
  Layer.provide(Subagents.layerTest),
  Layer.provide(PiModelSource.layerFromModelSource)
);

const DatabaseLive = Database.layer({
  filename: path.join(dir, "cairn.sqlite"),
  migrations,
});

const pushLog = path.join(dir, "pushes.log");

const NotifierToFile = Layer.mock(Notifier)({
  sendToAll: (message) =>
    Effect.sync(() => {
      appendFileSync(pushLog, `${JSON.stringify(message)}\n`);

      return ["delivered" as const];
    }),
});

/** The guard's seam: its first stop says `stopping`, each later one waits a stagger more. */
const GuardSeam = Layer.effect(
  HarnessSeam,
  Effect.gen(function* () {
    const real = yield* HarnessSeam;
    const order = yield* Ref.make(0);

    return HarnessSeam.of({
      ...real,
      stop: (threadId, options) =>
        Effect.gen(function* () {
          const n = yield* Ref.getAndUpdate(order, (count) => count + 1);

          if (n === 0) {
            yield* Console.log("stopping");
          }

          yield* Effect.sleep(Duration.times(STAGGER, n));

          return noStop ? [] : yield* real.stop(threadId, options);
        }),
    });
  })
);

/** The control's sources halt nothing. */
const ControlSources = Layer.effect(
  BudgetSources,
  Effect.gen(function* () {
    const real = yield* BudgetSources;

    return BudgetSources.of({ ...real, halt: () => Effect.succeed(0) });
  })
);

const Guard = BudgetGuard.layerNoDeps.pipe(
  Layer.provide(GuardSeam),
  Layer.provide(noStop ? ControlSources : Layer.empty),
  Layer.provide(NotifierToFile)
);

const BrainLayer = PiDurableHarness.layer.pipe(
  Layer.provide(Extensions),
  Layer.provideMerge(Models),
  Layer.provide(BrainConfig.layerFrom(dir))
);

const JudgeLayer = Guard.pipe(
  Layer.provideMerge(Budgets.layerNoDeps),
  Layer.provideMerge(BudgetSources.layer),
  Layer.provideMerge(SpendLedger.layerNoDeps),
  Layer.provideMerge(SpendFeed.layer),
  Layer.provideMerge(BrainLayer),
  Layer.provideMerge(BudgetBook.layer),
  Layer.provideMerge(ShellStoreLayer),
  Layer.provideMerge(DatabaseLive)
);

const decodeLineage = Schema.decodeEffect(ThreadLineage);

/** The project, the scope thread and its children: rows with lineage, and conversations. */
const ensureThreads = Effect.gen(function* () {
  const sink = yield* EventSink;
  const rows = yield* ThreadRows;
  const seam = yield* HarnessSeam;
  const sql = yield* SqlClient.SqlClient;
  const project = createProject(1);

  yield* sink.commitCommand(project.command);

  for (const n of [0, ...CHILD_IDS.map((_, index) => index + 1)]) {
    yield* sink.commitCommand(createThread(project.projectId, n + 1));

    const threadId = testThreadId(n + 1);
    const row = yield* rows.get(threadId);

    if (n > 0 && Option.isSome(row) && Option.isNone(row.value.shell.lineage)) {
      const lineage = yield* decodeLineage({
        parentThreadId: SCOPE,
        relationshipToParent: "subagent",
        rootThreadId: SCOPE,
      });

      yield* sql.withTransaction(
        rows.write({
          ...row.value,
          shell: { ...row.value.shell, lineage: Option.some(lineage) },
        })
      );
    }

    yield* seam.ensureThread({
      threadId,
      projectId: ProjectId.make(project.projectId),
      model: MODEL,
      thinkingLevel: "off",
      cwd: dir,
      instructions: Option.none(),
      runtimeMode: "full-access",
    });
  }
});

/**
 * About what one response costs, in micros: faux counts a quarter token per character of the call
 * (its name, id and arguments). The line is set from it; the judge measures the real prices.
 */
const RESPONSE_MICROS = Math.ceil((PAD.length + 40) / 4) * OUTPUT_RATE;

/** The conversation a thread lives in, from its receipt. */
const conversationOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const brain = yield* Brain;
    const session = yield* brain.session;

    const receipt = yield* durable(
      "receipt.read",
      async (context) =>
        await session.harness.snapshot(ThreadReceipt, threadId, context)
    );

    return receipt === undefined || receipt.conversationId < 1
      ? Option.none()
      : Option.some(ConversationId.make(receipt.conversationId));
  });

/** A thread's transcript, oldest first (the judge's threads stay short). */
const entriesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const brain = yield* Brain;
    const session = yield* brain.session;
    const conversation = yield* conversationOf(threadId);

    if (Option.isNone(conversation)) {
      return [];
    }

    return yield* durable("entries", async (context) => {
      const found = await session.harness.conversation(
        piConversationId(conversation.value),
        context
      );

      if (found === undefined) {
        return [];
      }

      const page = await found.entries(
        { order: "ascending" },
        1000,
        undefined,
        context
      );

      return page.items;
    });
  });

/**
 * Every child's answered responses, by thread. A response an abort cut off is recorded too, with
 * the usage it had; it is the end of the run it belonged to, not a new one, so it is not counted.
 */
const responseCounts = Effect.gen(function* () {
  const counts: Record<string, number> = {};

  for (const threadId of CHILD_IDS) {
    counts[threadId] = (yield* entriesOf(threadId)).filter(
      (entry) =>
        entry.kind === "pi.assistant" &&
        !(entry.model ?? []).some(
          (message) =>
            Predicate.hasProperty(message, "stopReason") &&
            message.stopReason === "aborted"
        )
    ).length;
  }

  return counts;
});

/** The largest single response price any child paid, in micros. */
const maxResponseMicros = Effect.gen(function* () {
  const feed = yield* SpendFeed;
  let max = 0;

  for (const threadId of CHILD_IDS) {
    const conversation = yield* conversationOf(threadId);

    for (const id of Option.toArray(conversation)) {
      for (const response of yield* feed.responses(id, Option.none())) {
        // Dollars per million tokens times tokens is micros.
        max = Math.max(max, response.usage.output * OUTPUT_RATE);
      }
    }
  }

  return max;
});

/** The scope's notices of `reason`, read from its transcript. */
const noticesOf = (reason: string) =>
  Effect.map(
    entriesOf(SCOPE),
    (entries) =>
      entries.filter(
        (entry) =>
          entry.kind === NOTICE_ENTRY_KIND &&
          Predicate.hasProperty(entry.data, "reason") &&
          entry.data.reason === reason
      ).length
  );

const budgetOf = (children: number): Budget => ({
  ...DEFAULT_BUDGET,
  maxListMicros: Micros.make(children * STEPS * RESPONSE_MICROS),
  warnAt: 0.8,
});

/** The pushes this run sent whose tag is `tag` and whose body says `words`. */
const pushesOf = (tag: string, words: string) => {
  const lines = existsSync(pushLog)
    ? readFileSync(pushLog, "utf-8").split("\n")
    : [];

  return lines.filter(
    (line) => line.includes(`"tag":"${tag}"`) && line.includes(words)
  ).length;
};

const rowBudget = Effect.gen(function* () {
  yield* (yield* SpendLedger).flush;
  yield* Effect.sleep(Duration.millis(200));
  yield* (yield* SpendLedger).flush;

  const row = yield* (yield* ThreadRows).get(SCOPE);

  return Option.getOrNull(
    Option.map(
      Option.flatMap(row, (found) => found.shell.spend),
      (spend) => spend.budget
    )
  );
});

const scopeSpend = Effect.gen(function* () {
  const ledger = yield* SpendLedger;

  yield* ledger.flush;

  const spend = yield* ledger.rollup(
    SpendScope.members[0].make({ threadId: SCOPE })
  );

  return spend.listMicros;
});

const submitWork = (threadId: ThreadId, requestId: string) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;

    yield* seam.submit(threadId, {
      requestId,
      content: text("work"),
      entry: Option.none(),
      whenBusy: "followUp",
    });
  });

const waitIdle = Effect.gen(function* () {
  const brain = yield* Brain;
  const session = yield* brain.session;

  yield* durable("idle", async (context) => {
    await session.harness.waitForIdle(context);
  });
});

const program = Effect.gen(function* () {
  const brain = yield* Brain;
  const budgets = yield* Budgets;
  const ledger = yield* SpendLedger;

  yield* ensureThreads;
  yield* ledger.reconcile;

  if (noBoot) {
    // The control: the last life boots with no budget repair at all, so its book is empty (only the
    // repair reads it), as a brain whose boot repairs left it out would. Earlier lives read the book
    // without halting, so the line is crossed and the stop pass starts.
    if (!values.final) {
      yield* budgets.load;
    }
  } else {
    yield* (yield* BudgetGuard).boot;
  }

  // After the budget repair, as in the brain's boot: these may resume scheduling.
  yield* retryParkedApprovalWaits.repair;
  yield* retryParkedSubagentTasks.pipe(Effect.orDie);

  // Declared once, in the first life; later lives read it from the documents through the guard's
  // boot repair, as the brain does, so a brain without the repair has an empty book after a restart.
  if (Option.isNone(yield* (yield* BudgetSources).scopeOf(SCOPE))) {
    yield* budgets.declare(
      SCOPE,
      budgetOf(Number(values["budget-children"])),
      "stop"
    );
  }

  const atBoot = yield* responseCounts;

  // The line was crossed in an earlier life and the boot repair halted the scope.
  if (Result.isFailure(yield* Effect.result(budgets.admit(SCOPE)))) {
    yield* Console.log("exhausted");
  }

  yield* brain.resume;

  for (const [index, threadId] of CHILD_IDS.entries()) {
    yield* submitWork(threadId, `work-${String(index + 1)}`);
  }

  yield* Console.log("producing");

  if (!values.final) {
    return yield* Effect.never;
  }

  yield* waitIdle;
  yield* Effect.sleep(Duration.seconds(1));
  yield* waitIdle;

  const atEnd = yield* responseCounts;

  const report = {
    limitMicros: budgetOf(Number(values["budget-children"])).maxListMicros,
    spentMicros: yield* scopeSpend,
    maxResponseMicros: yield* maxResponseMicros,
    children: CHILDREN,
    atBoot,
    atEnd,
    stoppedNotices: yield* noticesOf("budget_stopped"),
    rowBudget: yield* rowBudget,
    stoppedPushes: pushesOf(`budget:${SCOPE}`, "Budget reached"),
  };

  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report));

  // The raise, answered after the restart, then one child sent more work.
  const seam = yield* HarnessSeam;

  // A guard that never reached the line asked no raise: the report says so through `admitted`.
  yield* seam
    .respond(SCOPE, ApprovalId.make("budget-raise-0"), {
      decision: "accept",
      reason: Option.none(),
      answers: Option.none(),
      launch: Option.none(),
    })
    .pipe(
      Effect.catchTag("HarnessError", (failure) =>
        Console.error(JSON.stringify({ raise: failure.message }))
      )
    );

  let admitted = false;

  for (let tries = 0; tries < 50 && !admitted; tries += 1) {
    admitted = Result.isSuccess(yield* Effect.result(budgets.admit(SCOPE)));

    if (!admitted) {
      yield* Effect.sleep(Duration.millis(100));
    }
  }

  const raisedRow = yield* rowBudget;
  const retried = CHILD_IDS[CHILDREN - 1] ?? SCOPE;
  const before = (yield* responseCounts)[retried] ?? 0;

  yield* submitWork(retried, "retry-1");
  yield* Effect.sleep(Duration.millis(300));
  yield* waitIdle;

  const after = (yield* responseCounts)[retried] ?? 0;

  writeFileSync(
    path.join(dir, "raise.json"),
    JSON.stringify({
      admitted,
      rowBudget: raisedRow,
      retriedResponses: after - before,
    })
  );

  return yield* Console.log("done");
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(JudgeLayer), Effect.orDie)
);
