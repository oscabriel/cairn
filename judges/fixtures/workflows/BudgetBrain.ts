// The judge brain of `judges/workflow-budget.ts` (workflows note judge 4, plan 5B): Cairn's `Brain`
// over a scratch directory (BrainStore, Parked, the reactor host), never the deployed unit's, with
// the code mode, workflows and results extensions and the kit's `work` tool, over pi-ai's faux
// provider answering as the workflow kit's model does (apps/server/src/workflows/WorkflowTestKit.ts).
// The reactor host runs the workflow budget reactor (`cairn.workflow-budget`) as the production
// list will once the integrator adds it.
//
//   node judges/fixtures/workflows/BudgetBrain.ts --dir <run> --script <file> --max-tokens <n>
//     [--control no-admission|no-stopper] [--hold-submit <label>]
//     [--hold-reserve-until-spent <label>]
//
// - The first life plants an approved launch of the script with a token budget of `--max-tokens`
//   (as 5A's answer path will); every life submits the run under one request id, so it is admitted
//   once. Each life boots as the brain does: the reactor host starts, then the Harness resumes.
// - Each node's child calls `work`, which appends `{node, what, at}` to `effects.log` (outside the
//   store): `start` once per child, then `done` or `aborted`.
// - `--control no-admission` plants the `ignoreBudget` fault: the reserve commit never refuses at
//   the line. `--control no-stopper` runs no budget reactor: the lines fire, nothing stops.
//
// - `--hold-submit <label>` holds that node after its child took its input, before its row is
//   marked submitted, printing `holding after-submit <label>`, until the judge kills the brain.
//   `--hold-reserve-until-spent <label>` holds that node after its reserve (or a rerun's) until the
//   run reaches its line. `--reactors-after <ms>` starts the reactor host that long after the
//   Harness resumes, as a slow host would, so a node tool's rerun acts before the stopper exists.
//
// It prints `node <label> <state>`, `soft`, `spent` and `workflow <state>` as they happen, and
// `done` once the workflow ended, the stopper is gone and the reactors have caught up, after
// writing `report.json`.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Layer, Option, Result } from "effect";

import { Arms } from "../../../apps/server/src/brain/Arms.ts";
import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { BrainConfig } from "../../../apps/server/src/brain/BrainConfig.ts";
import { BrainStore } from "../../../apps/server/src/brain/BrainStore.ts";
import { Approvals } from "../../../apps/server/src/brain/CairnDocs.ts";
import { CodeMode } from "../../../apps/server/src/brain/CodeMode.ts";
import { EventReactors } from "../../../apps/server/src/brain/EventReactors.ts";
import type { Reactor } from "../../../apps/server/src/brain/Events.ts";
import {
  ExtensionOrder,
  Extensions,
} from "../../../apps/server/src/brain/Extensions.ts";
import type { CairnExtension } from "../../../apps/server/src/brain/Extensions.ts";
import { FauxModels } from "../../../apps/server/src/brain/FauxModels.ts";
import {
  FAUX_MODEL,
  ModelSource,
} from "../../../apps/server/src/brain/ModelSource.ts";
import { Parked } from "../../../apps/server/src/brain/Parked.ts";
import { ResultTool } from "../../../apps/server/src/models/ResultTool.ts";
import { ChildDoc } from "../../../apps/server/src/subagents/SubagentDocs.ts";
import {
  STOPPER_TASK,
  workflowBudgetReactor,
} from "../../../apps/server/src/workflows/WorkflowBudget.ts";
import {
  isWorkflowEnded,
  ledgerProblems,
  WorkflowsDoc,
} from "../../../apps/server/src/workflows/WorkflowDocs.ts";
import type { WorkflowItemState } from "../../../apps/server/src/workflows/WorkflowDocs.ts";
import type { PlanAccess } from "../../../apps/server/src/workflows/WorkflowPlanTool.ts";
import {
  codemodeResultText,
  eventsOf,
  KIT_CWD,
  KitLayer,
  plant,
  plantDefaults,
  respond,
  runScript,
  workExtension,
} from "../../../apps/server/src/workflows/WorkflowTestKit.ts";
import type {
  KitBrain,
  WorkEffect,
} from "../../../apps/server/src/workflows/WorkflowTestKit.ts";
import {
  NO_HOLD,
  workflowExtension,
} from "../../../apps/server/src/workflows/WorkflowTools.ts";
import type { HoldPoint } from "../../../apps/server/src/workflows/WorkflowTools.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    script: { type: "string" },
    "max-tokens": { type: "string" },
    control: { type: "string" },
    "hold-submit": { type: "string" },
    "hold-reserve-until-spent": { type: "string" },
    "reactors-after": { type: "string" },
  },
});

const dir = path.resolve(values.dir ?? ".");

const scriptFile = path.resolve(values.script ?? "");

const maxTokens = Number(values["max-tokens"] ?? "0");

const control = values.control ?? "none";

const WF = "wf-1";

const context = BACKGROUND_CONTEXT;

const say = (line: string) => {
  process.stdout.write(`${line}\n`);
};

/** The brain this life runs, once it is up: the reserve hold reads the run's line from it. */
let running: KitBrain | undefined;

/** Whether the run has reached its line. */
const spent = async (): Promise<boolean> => {
  if (running === undefined) {
    return false;
  }

  const ledger = await running.harness.snapshot(
    WorkflowsDoc,
    running.root,
    context
  );

  return (ledger?.items[WF]?.spentAt ?? null) !== null;
};

const hold = async (point: HoldPoint, label: string) => {
  if (point === "after-submit" && label === values["hold-submit"]) {
    say(`holding after-submit ${label}`);
    // Held until the judge's kill.
    await sleep(3_600_000);
  }

  if (
    point === "after-reserve" &&
    label === values["hold-reserve-until-spent"]
  ) {
    // oxlint-disable-next-line no-await-in-loop -- polls the line
    while (!(await spent())) {
      // oxlint-disable-next-line no-await-in-loop
      await sleep(5);
    }

    say(`released ${label} at the line`);
  }
};

const effect = (line: WorkEffect) => {
  appendFileSync(
    path.join(dir, "effects.log"),
    `${JSON.stringify({ ...line, at: Date.now() })}\n`
  );
};

/** Every node's child resolves to the faux model this brain runs. */
const resolveRole = async () =>
  await Promise.resolve(
    Result.succeed({
      provider: FAUX_MODEL.provider,
      modelId: FAUX_MODEL.modelId,
      thinkingLevel: Option.none(),
    })
  );

/** This brain plants its launch, so its model never proposes one. */
const plan: PlanAccess = {
  dryRun: async () =>
    await Promise.resolve(Result.fail("the budget judge plants its launch")),
};

const workflows = workflowExtension({
  resolveRole,
  plan,
  faults: {
    freshDispatch: false,
    grantAll: false,
    ignoreBudget: control === "no-admission",
  },
  hold,
  holdRetryMillis: 1000,
});

const work = workExtension({
  faults: { freshDispatch: false, grantAll: false, ignoreBudget: false },
  hold: NO_HOLD,
  effect,
  tokensPerSecond: 50_000,
});

/** What this brain installs: code mode, the result tool, the workflows and the kit's work tool. */
const extensionSources: ReadonlyArray<
  Effect.Effect<CairnExtension, never, CodeMode | ResultTool>
> = [
  CodeMode.useSync((codemode) => codemode.extension),
  ResultTool.useSync((results) => results.extension),
  Effect.succeed(workflows),
  Effect.succeed({ order: ExtensionOrder.judge, extension: work }),
];

/** The reactors the host runs: the budget reactor, or none under `--control no-stopper`. */
const reactorSources: ReadonlyArray<Effect.Effect<Reactor>> =
  control === "no-stopper" ? [] : [Effect.succeed(workflowBudgetReactor)];

const JudgeLayer = EventReactors.fromSources(reactorSources).pipe(
  Layer.provideMerge(
    Brain.layerNoDeps.pipe(
      Layer.provide(BrainStore.layer),
      Layer.provide(Arms.layer)
    )
  ),
  Layer.provide(Parked.layer),
  Layer.provide(Extensions.fromSources(extensionSources)),
  Layer.provideMerge(
    ModelSource.layerFaux({
      tokensPerSecond: 50_000,
      settings: { retry: { enabled: false } },
    })
  ),
  Layer.provide(BrainConfig.layerFrom(dir)),
  Layer.provideMerge(KitLayer)
);

/** Prints `line` once per life under `key`, when it changed since it was last printed. */
const sayOnce = (seen: Map<string, string>, key: string, line: string) => {
  if (seen.get(key) !== line) {
    seen.set(key, line);
    say(line);
  }
};

/** Prints what one look at the row shows that this life has not printed yet. */
const show = (seen: Map<string, string>, row: Readonly<WorkflowItemState>) => {
  for (const node of Object.values(row.nodes)) {
    sayOnce(seen, node.label, `node ${node.label} ${node.state}`);
  }

  if (row.softAt !== null) {
    sayOnce(seen, "<soft>", "soft");
  }

  if (row.spentAt !== null) {
    sayOnce(seen, "<spent>", "spent");
  }

  sayOnce(seen, "<workflow>", `workflow ${row.state}`);
};

/** Prints each node's new state once, and each line once, until the run ends. */
const follow = async (kit: KitBrain) => {
  const seen = new Map<string, string>();

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const ledger = await kit.harness.snapshot(WorkflowsDoc, kit.root, context);
    const row = ledger?.items[WF];

    if (row !== undefined) {
      show(seen, row);

      if (isWorkflowEnded(row.state)) {
        return;
      }
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(15);
  }
};

/** Every stopper task the store holds, live or ended. */
const stoppersOf = async (harness: Harness) =>
  await harness.commit(async (tx) => {
    const page = await tx.scanTasks({ kind: STOPPER_TASK }, 1000);

    return page.items.map((task) => ({
      id: task.id,
      terminal: task.state.status === "terminal",
    }));
  }, context);

/** Every conversation a node created, by its link's node id. */
const childrenOf = async (kit: KitBrain) =>
  await kit.harness.commit(async (tx) => {
    const found: Record<string, number> = {};
    const page = await tx.scanConversations({}, 1000);

    for (const conversation of page.items) {
      if (conversation.id !== kit.root) {
        // oxlint-disable-next-line no-await-in-loop
        const link = await tx.doc(ChildDoc, conversation.id);

        if (link.parentConversationId === kit.root) {
          found[link.key] = (found[link.key] ?? 0) + 1;
        }
      }
    }

    return found;
  }, context);

const program = Effect.gen(function* () {
  const brain = yield* Brain;
  const reactors = yield* EventReactors;
  const { faux } = yield* FauxModels;
  const session = yield* brain.session;
  const source = readFileSync(scriptFile, "utf-8");

  faux.setResponses(Array.from({ length: 20_000 }, () => respond));

  const root = yield* Effect.promise(
    async () =>
      await session.harness.root(context, {
        agent: { model: { ...FAUX_MODEL }, cwd: KIT_CWD },
      })
  );

  const kit: KitBrain = { harness: session.harness, root: root.id };

  running = kit;

  const ledger = yield* Effect.promise(
    async () => await kit.harness.snapshot(WorkflowsDoc, kit.root, context)
  );

  if (ledger?.items[WF] === undefined) {
    yield* plant(
      kit,
      source,
      {
        ...plantDefaults(WF),
        budget: { ...DEFAULT_BUDGET, maxTokens },
      },
      context
    );
    say("planted");
  }

  // Where this life found the run: whether the line was reached and a stopper still running, so
  // the judge can say which kills landed inside the stop.
  yield* Effect.promise(async () => {
    const found = await kit.harness.snapshot(WorkflowsDoc, kit.root, context);
    const stoppers = await stoppersOf(kit.harness);

    appendFileSync(
      path.join(dir, "boots.log"),
      `${JSON.stringify({
        spent: (found?.items[WF]?.spentAt ?? null) !== null,
        stoppers: stoppers.length,
        stopping: stoppers.some((task) => !task.terminal),
      })}\n`
    );
  });

  // Boot: the reactors start after the repairs, then the Harness resumes; or late, as asked.
  const reactorsAfter = Number(values["reactors-after"] ?? "0");

  if (reactorsAfter > 0) {
    yield* brain.resume;
    yield* Effect.forkScoped(
      Effect.sleep(Duration.millis(reactorsAfter)).pipe(
        Effect.andThen(reactors.start)
      )
    );
  } else {
    yield* reactors.start;
    yield* brain.resume;
  }

  yield* Effect.promise(async () => {
    await runScript(kit, source, "run-1", context);
    say("producing");
    await follow(kit);
    await kit.harness.waitForIdle(context);
  });

  // The stopper and the reactors are background work: wait for both.
  for (;;) {
    const stoppers = yield* Effect.promise(
      async () => await stoppersOf(kit.harness)
    );

    const status = yield* reactors.status.pipe(
      Effect.orElseSucceed(() => ({ reactors: [] }))
    );

    if (
      stoppers.every((task) => task.terminal) &&
      status.reactors.every((reactor) => reactor.lag === 0)
    ) {
      break;
    }

    yield* Effect.sleep("50 millis");
  }

  return yield* Effect.promise(async () => {
    const after = await kit.harness.snapshot(WorkflowsDoc, kit.root, context);
    const approvals = await kit.harness.snapshot(Approvals, kit.root, context);
    const events = await eventsOf(kit, context);
    const stoppers = await stoppersOf(kit.harness);

    const report = {
      maxTokens,
      control,
      boots: readFileSync(path.join(dir, "boots.log"), "utf-8")
        .split("\n")
        .filter((line) => line !== ""),
      result: await codemodeResultText(kit, context),
      workflow: after?.items[WF] ?? null,
      events: events.map((event) => event.name),
      stoppers: stoppers.length,
      raises: Object.values(approvals?.items ?? {})
        .filter((record) => record.tool === "budget_raise")
        .map((record) => ({ id: record.id, status: record.status })),
      children: await childrenOf(kit),
      problems: ledgerProblems(after ?? { items: {} }, approvals?.items ?? {}),
    };

    writeFileSync(
      path.join(dir, "report.json"),
      JSON.stringify(report, null, 2)
    );
    say("done");
    process.exit(0);
  });
}).pipe(Effect.scoped, Effect.provide(JudgeLayer));

NodeRuntime.runMain(program);
