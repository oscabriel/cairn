import { readFileSync } from "node:fs";

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import { MAX_WORKFLOW_NODES } from "@cairn/protocol/Workflows";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { BUILT_IN_RECIPES, recipeReference } from "./recipes/BuiltInRecipes.ts";
import {
  DryRunLimits,
  estimateRun,
  FALLBACK_NODE_TOKENS,
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
  advisors: ["@worker", "opencode-go/gpt-6-luna"],
  maxPasses: 2,
};

const input = (args: Schema.Json): PlanInput => ({
  args,
  budget: DEFAULT_BUDGET,
  sample: Option.none(),
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
    "the council recipe is five nodes on two providers, one call-site row per role and pass",
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
              spec: "@worker",
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
              spec: "@judge",
              label: "Claim matrix",
              phase: "Matrix",
              schemaName: "claim-matrix",
              readonly: true,
              maxCount: 1,
            },
            {
              spec: "@worker",
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
          run.byRole.map((entry) => [String(entry.spec), entry.count]),
          [
            ["@worker", 2],
            ["opencode-go/gpt-6-luna", 2],
            ["@judge", 1],
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

  test.effect("the council refuses a roster outside two to four advisors", () =>
    expectRefusal(recipe("council"), "script_failed", "two to four roles", {
      ...COUNCIL_ARGS,
      advisors: ["@worker"],
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
            ["@scout", true, 4],
            ["@verifier", true, 4],
            ["@worker", false, 1],
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
          ["@scout", null],
          ["@verifier", null],
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
        `${META}await agent("x", { role: "opus" });`,
        "agent_options_invalid",
        "`opus`"
      );
      yield* expectRefusal(
        `${META}await agent("x", { model: "opus", isolation: "worktree" });`,
        "agent_options_invalid",
        "`model`, `isolation`"
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
        `${META}await parallel([() => agent("x", { role: "not a role" })]);`,
        "agent_options_invalid"
      );
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
          `${META}await agent("first");\nfor (let i = 0; i < 30; i += 1) {\n  await agent("item " + i, { role: "@scout" });\n}\nawait agent("summary", { role: "@writer" });`,
          input({})
        );

        assert.deepStrictEqual(run.nodes, { count: 10, unbounded: true });
        assert.isTrue(run.sitesComplete);
        assert.deepStrictEqual(
          run.callSites.map((site) => [String(site.spec), site.maxCount]),
          [
            ["@worker", 1],
            ["@scout", null],
            ["@writer", null],
          ]
        );
        assert.deepStrictEqual(
          run.byRole.map((entry) => [String(entry.spec), entry.count]),
          [
            ["@worker", 1],
            ["@scout", 9],
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
          `${META}for (;;) {\n  await agent("again");\n}\nawait agent("never", { role: "@writer" });`,
          input({})
        );

        assert.deepStrictEqual(run.nodes, { count: 10, unbounded: true });
        assert.isFalse(run.sitesComplete);
        assert.deepStrictEqual(
          run.callSites.map((site) => [String(site.spec), site.maxCount]),
          [["@worker", null]]
        );
      })
  );
});

/** Priced history for `spec`, three micros a token. */
const priced = (
  spec: string,
  tokens: ReadonlyArray<number>
): Array<NodeHistory> =>
  tokens.map((totalTokens) => ({
    spec: RoleSpec.make(spec),
    totalTokens,
    listMicros: Option.some(totalTokens * 3),
  }));

describe(estimateRun, () => {
  const councilRun = Effect.gen(function* () {
    const plan = yield* WorkflowPlan;

    return yield* plan.validate(recipe("council"), input(COUNCIL_ARGS));
  }).pipe(Effect.provide(WorkflowPlan.layer));

  it.effect(
    "falls back to the labelled constant for roles with no history",
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
          "@judge: no history, 20k to 100k tokens a node assumed"
        );
      })
  );

  it.effect(
    "uses each role's quartiles from its last nodes, and dollars only when all are priced",
    () =>
      Effect.gen(function* () {
        const run = yield* councilRun;

        const history = [
          ...priced("@worker", [10_000, 20_000, 30_000, 40_000]),
          ...priced("opencode-go/gpt-6-luna", [8000]),
          ...priced("@judge", [5000, 6000]),
        ];

        const estimate = estimateRun(run, history);

        // @worker: q1 10k, q3 30k, two nodes; luna: 8k both, two nodes; judge: q1 5k, q3 6k.
        assert.strictEqual(estimate.tokensLow, 2 * 10_000 + 2 * 8000 + 5000);
        assert.strictEqual(estimate.tokensHigh, 2 * 30_000 + 2 * 8000 + 6000);
        assert.strictEqual(estimate.listMicrosLow, 3 * estimate.tokensLow);
        assert.strictEqual(estimate.listMicrosHigh, 3 * estimate.tokensHigh);
        assert.include(estimate.basis, "@worker: from its last 4 nodes");

        const unpriced = estimateRun(run, [
          ...history,
          {
            spec: RoleSpec.make("@judge"),
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
          roleOverrides: {},
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
          roundTrip.envelope.roles.map((role) => [
            String(role.spec),
            role.readonly,
          ]),
          [
            ["@worker", true],
            ["opencode-go/gpt-6-luna", true],
            ["@judge", true],
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
          ...priced("@worker", [10_000, 20_000]),
          ...priced("opencode-go/gpt-6-luna", [8000]),
          ...priced("@judge", [5000]),
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
