import { readFileSync } from "node:fs";

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import { MAX_WORKFLOW_NODES } from "@cairn/protocol/Workflows";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { BUILT_IN_RECIPES, recipeReference } from "./recipes/BuiltInRecipes.ts";
import {
  DryRunLimits,
  estimateRun,
  FALLBACK_NODE_TOKENS,
  historyTokens,
  isLargeWorkflow,
  toLaunch,
  WorkflowPlan,
} from "./WorkflowPlan.ts";
import type { NodeHistory, PlanInput } from "./WorkflowPlan.ts";
import { WorkflowRefusal } from "./WorkflowScript.ts";
import type { RefusalReason } from "./WorkflowScript.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}.workflow`, import.meta.url), "utf-8");

const recipe = (name: string) => BUILT_IN_RECIPES.get(name) ?? "";

const COUNCIL_ARGS = {
  question: "Should the brain keep one SQLite file per project?",
  scope: "apps/server/src/brain",
  nonGoals: "the web client",
  evidence: "docs/decisions/0016",
  advisors: [null, "opencode-go/gpt-6-luna"],
  maxPasses: 2,
};

/** The launching thread's model, which every call that names none runs on. */
const THREAD = { provider: "faux", modelId: "kit" };

/** The thread's model at its level, as a call site that names no model shows it. */
const THREAD_SPEC = "faux/kit:medium";

const LUNA = "opencode-go/gpt-6-luna";

const input = (args: Schema.Json): PlanInput => ({
  args,
  budget: DEFAULT_BUDGET,
  sample: Option.none(),
  threadModel: Option.some({
    model: THREAD,
    thinkingLevel: Option.some("medium"),
  }),
});

const META = `export const meta = { name: "probe", description: "A probe" };\n`;

const expectRefusal = (
  source: string,
  reason: RefusalReason,
  mentions?: string,
  args: Schema.Json = {}
) =>
  Effect.gen(function* () {
    const plan = yield* WorkflowPlan;
    const refusal = yield* plan.validate(source, input(args)).pipe(Effect.flip);

    assert.instanceOf(refusal, WorkflowRefusal, refusal.message);

    if (refusal instanceof WorkflowRefusal) {
      assert.strictEqual(refusal.reason, reason, refusal.message);
    }

    if (mentions !== undefined) {
      assert.include(refusal.message, mentions);
    }
  });

layer(WorkflowPlan.layer)("WorkflowPlan dry run", (test) => {
  test.effect(
    "the council recipe is five nodes on two providers, one call-site row per model and pass",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const run = yield* plan.validate(
          recipe("council"),
          input(COUNCIL_ARGS)
        );

        assert.deepStrictEqual(run.nodes, { count: 5, unbounded: false });
        assert.deepStrictEqual(
          run.callSites.map((site) => ({
            spec: String(site.spec),
            label: site.label,
            phase: site.phase,
            schemaName: site.schemaName,
            readonly: site.readonly,
            maxCount: site.maxCount,
          })),
          [
            {
              spec: THREAD_SPEC,
              label: "Advisor 1 report",
              phase: "Reports",
              schemaName: "advisor-report",
              readonly: true,
              maxCount: 1,
            },
            {
              spec: "opencode-go/gpt-6-luna",
              label: "Advisor 2 report",
              phase: "Reports",
              schemaName: "advisor-report",
              readonly: true,
              maxCount: 1,
            },
            {
              spec: THREAD_SPEC,
              label: "Claim matrix",
              phase: "Matrix",
              schemaName: "claim-matrix",
              readonly: true,
              maxCount: 1,
            },
            {
              spec: THREAD_SPEC,
              label: "Advisor 1 pass 2",
              phase: "Cross-examination",
              schemaName: "cross-examination",
              readonly: true,
              maxCount: 1,
            },
            {
              spec: "opencode-go/gpt-6-luna",
              label: "Advisor 2 pass 2",
              phase: "Cross-examination",
              schemaName: "cross-examination",
              readonly: true,
              maxCount: 1,
            },
          ]
        );
        assert.deepStrictEqual(run.undeclaredPhases, []);
        assert.deepStrictEqual(
          run.byModel.map((entry) => [
            `${entry.model.provider}/${entry.model.modelId}`,
            entry.count,
          ]),
          [
            ["faux/kit", 3],
            [LUNA, 2],
          ]
        );
      })
  );

  test.effect(
    "a recipe reference dry-runs the recipe it names, under the recipe's own hash",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const byName = yield* plan.validate(
          recipeReference("council"),
          input(COUNCIL_ARGS)
        );

        const written = yield* plan.validate(
          recipe("council"),
          input(COUNCIL_ARGS)
        );

        assert.strictEqual(byName.script.hash, written.script.hash);
        assert.strictEqual(byName.script.source, recipe("council"));
        assert.deepStrictEqual(byName.nodes, { count: 5, unbounded: false });
      })
  );

  test.effect(
    "a reference to no recipe is refused with the recipes' names",
    () =>
      expectRefusal(
        `export const meta = { name: "no-such-recipe" };`,
        "unknown_recipe",
        "Built-ins: `council`"
      )
  );

  test.effect(
    "the council with no advisors or judge named runs two advisors and the judge on the thread's model",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const run = yield* plan.validate(
          recipe("council"),
          input({ question: COUNCIL_ARGS.question })
        );

        assert.deepStrictEqual(run.nodes, { count: 5, unbounded: false });
        assert.deepStrictEqual(
          [...new Set(run.callSites.map((site) => String(site.spec)))],
          [THREAD_SPEC]
        );
      })
  );

  test.effect("the council refuses a roster outside two to four advisors", () =>
    expectRefusal(recipe("council"), "script_failed", "two to four models", {
      ...COUNCIL_ARGS,
      advisors: [LUNA],
    })
  );

  test.effect(
    "a loop-free script counts exactly the nodes a run dispatches",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;
        const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
        const run = yield* plan.validate(fixture("review"), input({ files }));

        // Two nodes per file (read, verify) and the summary.
        assert.deepStrictEqual(run.nodes, {
          count: 2 * files.length + 1,
          unbounded: false,
        });
        assert.deepStrictEqual(
          run.callSites.map((site) => [
            String(site.spec),
            site.readonly,
            site.maxCount,
          ]),
          [
            [THREAD_SPEC, true, 4],
            [THREAD_SPEC, true, 4],
            [THREAD_SPEC, false, 1],
          ]
        );

        const sampled = yield* plan.validate(fixture("review"), {
          ...input({ files }),
          sample: Option.some(1),
        });

        assert.deepStrictEqual(sampled.nodes, { count: 3, unbounded: false });
        assert.isTrue(
          sampled.output.some((line) => line.includes("took 1 of 4 items"))
        );
      })
  );

  test.effect("a looped script stops at the node cap and says at least", () =>
    Effect.gen(function* () {
      const plan = yield* WorkflowPlan;

      const run = yield* plan.validate(
        fixture("looped"),
        input({ scope: "apps/server" })
      );

      assert.isTrue(run.nodes.unbounded);
      assert.strictEqual(run.nodes.count, MAX_WORKFLOW_NODES);
      assert.deepStrictEqual(
        run.callSites.map((site) => [String(site.spec), site.maxCount]),
        [
          [THREAD_SPEC, null],
          [THREAD_SPEC, null],
        ]
      );

      const estimate = estimateRun(run, []);

      assert.match(estimate.basis, /^At least 1000 nodes/u);
      assert.isTrue(isLargeWorkflow(run, estimate, DEFAULT_BUDGET));
    })
  );

  test.effect("refuses a script that throws, naming the line", () =>
    expectRefusal(
      `${META}const x = null;\nreturn x.field;`,
      "script_failed",
      "(line 3)"
    )
  );

  test.effect(
    "an error the prelude throws names the script's line that called it",
    () =>
      Effect.gen(function* () {
        yield* expectRefusal(
          `${META}const x = 1;\nawait agent("");`,
          "script_failed",
          "(line 3)"
        );

        const plan = yield* WorkflowPlan;

        const refusal = yield* plan
          .validate(
            `${META}const items = Array.from({ length: 5000 }, (_, i) => i);\nawait parallel(items.map((n) => () => agent("n" + n)));`,
            input({})
          )
          .pipe(Effect.flip);

        assert.include(refusal.message, "(line 3)");
        assert.include(refusal.message, "split the list. Every node");
      })
  );

  test.effect(
    "a script that parses a schema-less answer is told to give a schema",
    () =>
      expectRefusal(
        `${META}const plan = JSON.parse(await agent("plan"));\nreturn plan;`,
        "script_failed",
        "give agent() a `schema`"
      )
  );

  test.effect("refuses agent options a launch would refuse", () =>
    Effect.gen(function* () {
      yield* expectRefusal(
        `${META}await agent("x", { model: "opus" });`,
        "agent_options_invalid",
        "model `opus` is not `provider/modelId[:level]`"
      );
      yield* expectRefusal(
        `${META}await agent("x", { isolation: "worktree" });`,
        "agent_options_invalid",
        "does not take `isolation`"
      );
      yield* expectRefusal(
        `${META}await agent("x", { schema: { type: "array" } });`,
        "agent_options_invalid",
        "object"
      );
      yield* expectRefusal(
        `${META}await agent("x", { effort: "huge" });`,
        "agent_options_invalid",
        "huge"
      );
      yield* expectRefusal(
        `${META}await agent("x", { resume: "n-99" });`,
        "agent_options_invalid",
        "n-99"
      );
      // Inside parallel the bad call would have been a silent null; the dry run still sees it.
      yield* expectRefusal(
        `${META}await parallel([() => agent("x", { model: "not a model" })]);`,
        "agent_options_invalid"
      );
    })
  );

  test.effect(
    "a call runs on the model it names, else on the launching thread's model and level",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const run = yield* plan.validate(
          `${META}await agent("a");\nawait agent("b", { model: "${LUNA}:high" });\nawait verify("c", { claim: "c" });\nawait verify("d", { model: "${LUNA}" });`,
          input({})
        );

        assert.deepStrictEqual(
          run.callSites.map((site) => String(site.spec)),
          [THREAD_SPEC, `${LUNA}:high`, THREAD_SPEC, LUNA]
        );
      })
  );

  test.effect(
    "refuses a role name, as an option or as a model: it is no option and no model",
    () =>
      Effect.gen(function* () {
        yield* expectRefusal(
          `${META}await agent("x", { role: "@scout" });`,
          "agent_options_invalid",
          "agent() does not take `role`"
        );
        yield* expectRefusal(
          `${META}await agent("x", { model: "@worker" });`,
          "agent_options_invalid",
          "model `@worker` is not `provider/modelId[:level]`"
        );
      })
  );

  test.effect(
    "refuses a call that names no model on a thread that runs on none",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const refusal = yield* plan
          .validate(`${META}await agent("x");`, {
            ...input({}),
            threadModel: Option.none(),
          })
          .pipe(Effect.flip);

        assert.include(refusal.message, "this thread runs on none");
      })
  );

  test.effect(
    "refuses too many items, a script with no node, and arguments too large to show",
    () =>
      Effect.gen(function* () {
        yield* expectRefusal(
          `${META}await pipeline(Array.from({ length: 5000 }, (_, i) => i), (n) => agent("n" + n));`,
          "too_many_items"
        );
        yield* expectRefusal(
          `${META}log("nothing to do");\nreturn 1;`,
          "no_nodes"
        );
        yield* expectRefusal(
          `${META}await agent("x");`,
          "args_invalid",
          "byte limit",
          {
            blob: "x".repeat(40_000),
          }
        );
      })
  );

  test.effect(
    "refuses, never dies on, values the launch card cannot carry",
    () =>
      Effect.gen(function* () {
        yield* expectRefusal(
          `${META}await agent("x", { phase: "p".repeat(5000) });`,
          "agent_options_invalid",
          "a phase title is at most 120"
        );
        yield* expectRefusal(
          `${META}phase("p".repeat(5000));\nawait agent("x");`,
          "agent_options_invalid",
          "phase()"
        );
        yield* expectRefusal(
          `${META}phase("p".repeat(200));\nawait verify({});`,
          "agent_options_invalid",
          "a phase title is at most 120"
        );
      })
  );

  test.effect("a blank or padded schema title is trimmed, not refused", () =>
    Effect.gen(function* () {
      const plan = yield* WorkflowPlan;

      const run = yield* plan.validate(
        `${META}await agent("a", { schema: { type: "object", title: "Findings " } });\nawait agent("b", { schema: { type: "object", title: "" } });\nawait agent("c", { schema: { type: "object", title: "  " } });`,
        input({})
      );

      assert.deepStrictEqual(
        run.callSites.map((site) => site.schemaName),
        ["Findings", null, null]
      );
    })
  );

  test.effect("records phases the meta does not declare", () =>
    Effect.gen(function* () {
      const plan = yield* WorkflowPlan;

      const run = yield* plan.validate(
        `export const meta = { name: "p", description: "d", phases: [{ title: "A" }] };\nphase("A");\nawait agent("x");\nphase("B");\nawait agent("y", { phase: "C" });`,
        input({})
      );

      assert.deepStrictEqual(run.undeclaredPhases, ["B", "C"]);
    })
  );
});

const tight = WorkflowPlan.layer.pipe(
  Layer.provide(
    Layer.succeed(DryRunLimits, {
      nodeCap: 10,
      callCap: 100,
      timeoutMs: 500,
      memoryLimitBytes: 64 * 1024 * 1024,
    })
  )
);

layer(tight)("WorkflowPlan under tight limits", (test) => {
  test.effect(
    "a script that computes forever is refused when the dry run's time is up",
    () =>
      expectRefusal(
        `${META}await agent("x");\nfor (;;) {}`,
        "dry_run_timeout",
        "0.5 s"
      )
  );

  test.effect(
    "an unbounded loop that dispatches no node ends at the call cap",
    () =>
      expectRefusal(
        `${META}for (;;) { await log("again"); }`,
        "dry_run_timeout",
        "over 100 tool calls"
      )
  );

  test.effect("the cap is the configured one", () =>
    Effect.gen(function* () {
      const plan = yield* WorkflowPlan;

      const run = yield* plan.validate(
        fixture("looped"),
        input({ scope: "x" })
      );

      assert.deepStrictEqual(run.nodes, { count: 10, unbounded: true });
      assert.isTrue(run.sitesComplete);
    })
  );

  test.effect(
    "past the cap the run goes on with refused nodes, so sites after the loop reach the table",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const run = yield* plan.validate(
          `${META}await agent("first");\nfor (let i = 0; i < 30; i += 1) {\n  await agent("item " + i, { model: "${LUNA}" });\n}\nawait agent("summary", { model: "opencode-go/beam" });`,
          input({})
        );

        assert.deepStrictEqual(run.nodes, { count: 10, unbounded: true });
        assert.isTrue(run.sitesComplete);
        assert.deepStrictEqual(
          run.callSites.map((site) => [String(site.spec), site.maxCount]),
          [
            [THREAD_SPEC, 1],
            [LUNA, null],
            ["opencode-go/beam", null],
          ]
        );
        assert.deepStrictEqual(
          run.byModel.map((entry) => [
            `${entry.model.provider}/${entry.model.modelId}`,
            entry.count,
          ]),
          [
            ["faux/kit", 1],
            [LUNA, 9],
          ]
        );
      })
  );

  test.effect("a node refused past the cap answers a null value", () =>
    Effect.gen(function* () {
      const plan = yield* WorkflowPlan;

      const run = yield* plan.validate(
        `${META}for (let i = 0; i < 10; i += 1) {\n  await agent("item " + i);\n}\nconst late = await agent.full("late", { schema: { type: "object" } });\nif (late.status !== "refused" || late.value !== null) throw new Error("a value past the cap");`,
        input({})
      );

      assert.deepStrictEqual(run.nodes, { count: 10, unbounded: true });
      assert.isTrue(run.sitesComplete);
    })
  );

  test.effect(
    "a run past the cap that never ends is unbounded and says its table may be incomplete",
    () =>
      Effect.gen(function* () {
        const plan = yield* WorkflowPlan;

        const run = yield* plan.validate(
          `${META}for (;;) {\n  await agent("again");\n}\nawait agent("never", { model: "opencode-go/beam" });`,
          input({})
        );

        assert.deepStrictEqual(run.nodes, { count: 10, unbounded: true });
        assert.isFalse(run.sitesComplete);
        assert.deepStrictEqual(
          run.callSites.map((site) => [String(site.spec), site.maxCount]),
          [[THREAD_SPEC, null]]
        );
      })
  );
});

/** Priced history on `provider/modelId`, three micros a token. */
const priced = (
  model: string,
  tokens: ReadonlyArray<number>
): Array<NodeHistory> =>
  tokens.map((totalTokens) => ({
    model: {
      provider: model.slice(0, model.indexOf("/")),
      modelId: model.slice(model.indexOf("/") + 1),
    },
    totalTokens,
    listMicros: Option.some(totalTokens * 3),
  }));

describe(estimateRun, () => {
  const councilRun = Effect.gen(function* () {
    const plan = yield* WorkflowPlan;

    return yield* plan.validate(recipe("council"), input(COUNCIL_ARGS));
  }).pipe(Effect.provide(WorkflowPlan.layer));

  it.effect(
    "falls back to the labelled constant for models with no history",
    () =>
      Effect.gen(function* () {
        const run = yield* councilRun;
        const estimate = estimateRun(run, []);

        assert.strictEqual(estimate.nodes, 5);
        assert.strictEqual(estimate.tokensLow, 5 * FALLBACK_NODE_TOKENS.low);
        assert.strictEqual(estimate.tokensHigh, 5 * FALLBACK_NODE_TOKENS.high);
        assert.isNull(estimate.listMicrosLow);
        assert.include(
          estimate.basis,
          "faux/kit: no history, 100k to 1M tokens a node assumed, cache reads included"
        );
      })
  );

  it.effect(
    "assumes enough for a no-history council: its 2026-10-30 run used about 2.74M tokens",
    () =>
      Effect.gen(function* () {
        const run = yield* councilRun;
        const estimate = estimateRun(run, []);

        assert.strictEqual(estimate.nodes, 5);
        assert.isAtLeast(estimate.tokensHigh, 2_500_000);
        assert.isAtMost(estimate.tokensLow, 2_740_000 / 5);
      })
  );

  it("counts a past node's cache reads in its history", () => {
    // A total that leaves cache reads out, as a provider's own count may.
    assert.strictEqual(
      historyTokens({
        input: 2000,
        output: 1000,
        cacheRead: 280_000,
        cacheWrite: 17_000,
        totalTokens: 3000,
      }),
      300_000
    );
    assert.strictEqual(
      historyTokens({
        input: 2000,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 4000,
      }),
      4000
    );
  });

  it.effect(
    "uses each model's quartiles from its last nodes on it, and dollars only when all are priced",
    () =>
      Effect.gen(function* () {
        const run = yield* councilRun;

        const history = [
          ...priced("faux/kit", [10_000, 20_000, 30_000, 40_000]),
          ...priced(LUNA, [8000]),
          // Another model's nodes feed no call site's estimate.
          ...priced("opencode-go/beam", [900_000]),
        ];

        const estimate = estimateRun(run, history);

        // faux/kit: q1 10k, q3 30k, three nodes; luna: 8k both, two nodes.
        assert.strictEqual(estimate.tokensLow, 3 * 10_000 + 2 * 8000);
        assert.strictEqual(estimate.tokensHigh, 3 * 30_000 + 2 * 8000);
        assert.strictEqual(estimate.listMicrosLow, 3 * estimate.tokensLow);
        assert.strictEqual(estimate.listMicrosHigh, 3 * estimate.tokensHigh);
        assert.include(estimate.basis, "faux/kit: from its last 4 nodes");

        const unpriced = estimateRun(run, [
          ...history,
          {
            model: THREAD,
            totalTokens: 5500,
            listMicros: Option.none(),
          },
        ]);

        assert.isNull(unpriced.listMicrosHigh);
      })
  );

  it.effect(
    "builds a launch payload the protocol accepts, with the envelope from the call sites",
    () =>
      Effect.gen(function* () {
        const run = yield* councilRun;
        const estimate = estimateRun(run, []);

        const launch = toLaunch(run, {
          workflowId: "wf-12",
          scriptRef: "entry-4",
          args: COUNCIL_ARGS,
          budget: DEFAULT_BUDGET,
          estimate: Option.some(estimate),
          maxNodes: Option.none(),
          modes: ["approval-required"],
          writes: [],
        });

        const roundTrip = yield* Schema.decodeEffect(WorkflowLaunch)(
          yield* Schema.encodeEffect(WorkflowLaunch)(launch)
        );

        assert.strictEqual(roundTrip.envelope.maxNodes, 5);
        assert.strictEqual(roundTrip.envelope.scriptHash, run.script.hash);
        assert.deepStrictEqual(
          roundTrip.envelope.models.map((entry) => [
            String(entry.spec),
            entry.readonly,
          ]),
          [
            [THREAD_SPEC, true],
            [LUNA, true],
          ]
        );
        assert.isFalse(isLargeWorkflow(run, estimate, DEFAULT_BUDGET));
        assert.isTrue(
          isLargeWorkflow(run, estimate, {
            ...DEFAULT_BUDGET,
            maxTokens: 100_000,
          })
        );
      })
  );

  it.effect(
    "says Large workflow when a dollar budget is under the priced estimate's high end",
    () =>
      Effect.gen(function* () {
        const run = yield* councilRun;

        const estimate = estimateRun(run, [
          ...priced("faux/kit", [10_000, 20_000]),
          ...priced(LUNA, [8000]),
        ]);

        const high = estimate.listMicrosHigh ?? 0;

        assert.isAbove(high, 0);
        assert.isFalse(
          isLargeWorkflow(run, estimate, {
            ...DEFAULT_BUDGET,
            maxListMicros: Micros.make(high),
          })
        );
        assert.isTrue(
          isLargeWorkflow(run, estimate, {
            ...DEFAULT_BUDGET,
            maxListMicros: Micros.make(high - 1),
          })
        );
      })
  );
});
