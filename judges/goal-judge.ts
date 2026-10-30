// The `model` judge on a real model (plan 5F: "a model judge must be from another family"). The
// goals extension is built by production's `Goals.layer`, over the brain's real model runtime
// (`PiModelSource.layer`, reading `~/.pi/agent` read-only) and `RoleAliases`; the goal thread's own
// model is pi-ai's faux provider under the `anthropic` name, so its family is Anthropic and it only
// calls `goal_check`. The judge is the cheapest OpenCode Go model of another family.
//
//   node judges/goal-judge.ts [--judge opencode-go/<model>] [--keep]
//
// Cases:
// - met: the user's message carries a test run with no failures; the judge must say MET.
// - not-met: the model claims success while the user's message shows three failures; the judge
//   must say NOT MET, so a false claim does not meet the criterion.
// - same-family: a criterion judged by `opencode-go/claude-haiku-5-5` (Anthropic, as the thread
//   is) is refused by `goal_check` and asks no model ($0).
//
// Each answered call's cost is read from the spend ledger's `recordCall` (a stand-in ledger that
// sums `usage.cost`), the path production meters judge calls on. Prints one JSON line per case and
// a summary with the cost; exits 0 when every case passes.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { RoleSpec } from "@cairn/protocol/Roles";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Logger } from "effect";

import { ServerConfig } from "../apps/server/src/Config.ts";
import { ModelHealth } from "../apps/server/src/models/ModelHealth.ts";
import { PiModelSource } from "../apps/server/src/models/PiModelSource.ts";
import { RoleAliases } from "../apps/server/src/models/RoleAliases.ts";
import { SettingsStore } from "../apps/server/src/models/SettingsStore.ts";
import { SpendLedger } from "../apps/server/src/usage/SpendLedger.ts";
import { Goals } from "../apps/server/src/verdicts/Goals.ts";
import {
  callTool,
  createGoalThread,
  memoryStore,
  openKitWith,
  readGoal,
  send,
  toolResults,
  verdictNotes,
  waitForJudges,
} from "../apps/server/src/verdicts/GoalTestKit.ts";

const context = BACKGROUND_CONTEXT;

const { values } = parseArgs({
  options: {
    judge: { type: "string", default: "opencode-go/qwen3.8-flash" },
    keep: { type: "boolean", default: false },
  },
});

const THREAD_MODEL = { provider: "anthropic", modelId: "claude-faux" };

const RUBRIC =
  "Met only if the transcript shows the test command's own output with zero failed tests. A claim without that output is not met.";

/** What each answered judge call cost, summed. */
const spent = { usd: 0, calls: 0 };

/** A ledger that only sums each recorded call's cost. */
const CostLedger = Layer.mock(SpendLedger)({
  recordCall: (_call, message) =>
    Effect.sync(() => {
      spent.usd += message.usage.cost.total;
      spent.calls += 1;
    }),
});

interface Case {
  readonly name: string;
  readonly spec: string;
  /** The user's message: the evidence the judge reads. */
  readonly evidence: string;
  /** The thread model's claim after its check. */
  readonly claim: string;
  readonly expect: "met" | "failed" | "refused";
}

const CASES: ReadonlyArray<Case> = [
  {
    name: "met",
    spec: values.judge,
    evidence:
      "I ran `npm test` myself. Its output:\n\n> parser@1.0.0 test\n> vitest run\n\n ✓ src/parser.test.ts (12 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)\n\nCheck the criterion.",
    claim: "The tests pass.",
    expect: "met",
  },
  {
    name: "not-met",
    spec: values.judge,
    evidence:
      "I ran `npm test` myself. Its output:\n\n> parser@1.0.0 test\n> vitest run\n\n ❯ src/parser.test.ts (12 tests | 3 failed) 44ms\n\n Test Files  1 failed (1)\n      Tests  3 failed | 9 passed (12)\n\nCheck the criterion.",
    claim: "All tests pass now; the criterion is met.",
    expect: "failed",
  },
  {
    name: "same-family",
    spec: "opencode-go/claude-haiku-5-5",
    evidence: "Check the criterion.",
    claim: "Done.",
    expect: "refused",
  },
];

const runCase = (goals: Goals["Service"], spec: Case) =>
  Effect.gen(function* () {
    const kit = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await openKitWith(
            {
              storage: memoryStore(),
              model: THREAD_MODEL,
              responses: [callTool("goal_check", { criterion: "c1" }, "check")],
            },
            goals.extension,
            context
          )
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close();
        })
    );

    const cwd = mkdtempSync(path.join(tmpdir(), "cairn-goal-judge-"));

    const conversation = yield* Effect.promise(
      async () =>
        await createGoalThread(
          kit,
          {
            threadId: `goal-judge-${spec.name}`,
            cwd,
            model: THREAD_MODEL,
            objective: "Ship the parser with its tests passing",
            criteria: [
              {
                text: "The parser's unit tests pass",
                judge: {
                  kind: "model",
                  spec: RoleSpec.make(spec.spec),
                  rubric: RUBRIC,
                },
              },
            ],
            now: 1,
          },
          context
        )
    );

    yield* Effect.promise(async () => {
      await send(conversation, spec.evidence, "evidence", context);
    });

    // A refused check queues no run, so there is nothing to wait for.
    const settled =
      spec.expect === "refused" ||
      (yield* Effect.promise(
        async () => await waitForJudges(kit, conversation, 180_000, context)
      ));

    const goal = yield* Effect.promise(
      async () => await readGoal(kit, conversation, context)
    );

    const results = yield* Effect.promise(
      async () => await toolResults(conversation, context)
    );

    // What the run told the thread's model, as the note's text says it.
    const notes = yield* Effect.promise(
      async () => await verdictNotes(conversation, context)
    );

    const noted = JSON.stringify(notes.at(-1)?.model ?? null).slice(0, 600);

    rmSync(cwd, { recursive: true, force: true });

    const criterion = goal?.criteria[0];
    const checkText = results.get("check") ?? "";

    const refused =
      checkText.includes("same family") && criterion?.verdict === null;

    let got = String(criterion?.state);

    if (spec.expect === "refused") {
      got = refused ? "refused" : `not refused: ${checkText}`;
    }

    return {
      case: spec.name,
      judge: spec.spec,
      pass: got === spec.expect && (spec.expect === "refused" || settled),
      expected: spec.expect,
      got,
      model: criterion?.verdict?.evidence.model ?? null,
      reply: criterion?.verdict?.evidence.note ?? null,
      check: checkText.slice(0, 600),
      note: noted,
    };
  }).pipe(Effect.scoped);

const program = Effect.gen(function* () {
  const goals = yield* Goals;
  const results = [];

  for (const spec of CASES) {
    const result = yield* runCase(goals, spec);

    results.push(result);
    yield* Console.log(JSON.stringify(result));
  }

  const passed = results.filter((result) => result.pass).length;

  yield* Console.log(
    JSON.stringify({
      summary: "goal-judge",
      passed: `${passed} of ${results.length}`,
      judgeCalls: spent.calls,
      costUsd: Math.round(spent.usd * 1_000_000) / 1_000_000,
    })
  );

  if (passed !== results.length) {
    process.exitCode = 1;
  }
});

const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-goal-judge-data-"));

// The brain's real model runtime, with no extra providers (the bridge is never a model judge).
const models = PiModelSource.layer.pipe(
  Layer.provide(ServerConfig.layerWith({ dataDir })),
  Layer.orDie
);

const live = Goals.layer.pipe(
  Layer.provide(RoleAliases.layerNoDeps),
  Layer.provide(CostLedger),
  Layer.provide(SettingsStore.layerTest),
  Layer.provide(ModelHealth.layerTest),
  Layer.provide(models)
);

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(
      live.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(
          Logger.layer([Logger.withConsoleError(Logger.formatSimple)])
        )
      )
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!values.keep) {
          rmSync(dataDir, { recursive: true, force: true });
        }
      })
    )
  )
);
