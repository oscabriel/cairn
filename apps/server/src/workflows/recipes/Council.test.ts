// The council recipe on a faux model (plan 5D; workflows note W7): the built-in `council.workflow`
// launched by name (its recipe reference through the gate) on a real pi-durable Harness with the
// code mode, workflows and results extensions, every node on pi-ai's faux provider. Each role
// resolves to a faux model whose id says how it behaves, so one script exercises:
//
// - structure: two advisors, a claim matrix and two cross-examinations are five nodes in three
//   phases; each cross-examination resumes its advisor's report node as a fork of its child, which
//   sees its own report and nothing of the other advisor's, with a receipt of its own;
// - `null` handling: an advisor or the matrix that fails ends the council early with what it has,
//   and a third advisor's failed report leaves its cross-examination `null`;
// - the fallback: an advisor whose resumed node fails answers in a fresh node given its report,
//   labelled "fresh-context fallback, not true cross-exam"; a stopped node is never retried;
// - `resume` itself: a third pass resumes the second pass's node, and a node that is not settled
//   cannot be resumed.
//
// The faux advisors record what each request carried, outside the store, so a check reads what a
// child really saw rather than what the ledger says it saw.

import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";

import { Approvals } from "../../brain/CairnDocs.ts";
import { CodeMode } from "../../brain/CodeMode.ts";
import { messageText } from "../../brain/CommitFeed.ts";
import { RESULT_TOOL_NAME, ResultTool } from "../../models/ResultTool.ts";
import { taskOf } from "../../subagents/Delivery.ts";
import { ledgerProblems, WorkflowsDoc } from "../WorkflowDocs.ts";
import type {
  NodeItemState,
  WorkflowItemState,
  WorkflowsState,
} from "../WorkflowDocs.ts";
import {
  codemodeResultText,
  KIT_MODEL,
  KitLayer,
  openKit,
  pause,
  plant,
  plantDefaults,
  respond as kitRespond,
  runScript,
} from "../WorkflowTestKit.ts";
import type { KitBrain, PlantInput } from "../WorkflowTestKit.ts";
import {
  NO_HOLD,
  NO_WORKFLOW_FAULTS,
  workflowExtension,
} from "../WorkflowTools.ts";
import type { RoleResolver } from "../WorkflowTools.ts";
import { BUILT_IN_RECIPES, recipeReference } from "./BuiltInRecipes.ts";

const context = BACKGROUND_CONTEXT;

const WF = "wf-council";

const COUNCIL = BUILT_IN_RECIPES.get("council") ?? "";

/**
 * The faux models, by id: `advisor` answers every pass; `advisor-forkfail` reports, but fails any
 * run that continues an earlier one (so its resumed node fails); `advisor-fail` fails its report;
 * `judge` disputes one claim of each of advisors 1 and 2; `judge-fail` fails; `judge-settle` also
 * says evidence can settle the disputes (a third pass runs); `advisor-slow` takes 3 s over any
 * run that continues an earlier one, so a stop lands while it works.
 */
const NODE_MODELS = [
  "advisor",
  "advisor-forkfail",
  "advisor-fail",
  "judge",
  "judge-fail",
  "judge-settle",
  "advisor-slow",
] as const;

/** A role resolves to the faux model of the same name: `@advisor` runs on `advisor`. */
const resolveRole: RoleResolver = async (spec) => {
  const name = spec.replace(/^@/u, "").replace(/-\d+$/u, "");

  return await Promise.resolve(
    NODE_MODELS.some((model) => model === name)
      ? Result.succeed({
          provider: KIT_MODEL.provider,
          modelId: name,
          thinkingLevel: Option.none(),
        })
      : Result.fail(`no model is bound to ${spec}`)
  );
};

/** One request a council node's model was sent. */
interface Seen {
  readonly model: string;
  /** The kind of input the request answers. */
  readonly pass: "report" | "matrix" | "resumed" | "fresh";
  /** The user inputs the request carried, in order. */
  readonly inputs: ReadonlyArray<string>;
}

const REPORT = (n: string) => ({
  recommendation: `Recommendation ${n}`,
  evidence: [{ claim: `claim-${n}`, sources: [`src-${n}`] }],
  assumptions: [{ assumption: `assumption-${n}`, status: "checked" }],
  risks: [`risk-${n}`],
  confidence: { level: "medium", reason: "faux" },
  challengeClaims: [],
  ownerDecisions: [`decide-${n}`],
  changeMyMind: "evidence",
});

const MATRIX = (settle: boolean) => ({
  agreements: ["both care"],
  disputed: [
    { claimId: "c1", claim: "claim-1", madeBy: 1, challenge: "weak" },
    { claimId: "c2", claim: "claim-2", madeBy: 2, challenge: "untested" },
  ],
  evidenceCanSettle: settle,
});

const RESPONSES = (packet: string) => ({
  responses: [
    {
      claimId: /"claimId":"(?<id>c\d)"/u.exec(packet)?.groups?.id ?? "none",
      disposition: "owner-decision",
      reason: "faux",
      sources: [],
    },
  ],
  recommendationChanged: false,
  outOfScopeFindings: [],
});

const submit = (result: { [key: string]: JsonValue }, id: string) =>
  fauxAssistantMessage(
    fauxToolCall(RESULT_TOOL_NAME, { result, divergence: "None" }, { id }),
    { stopReason: "toolUse" }
  );

const failed = () =>
  fauxAssistantMessage(fauxText(""), {
    stopReason: "error",
    errorMessage: "faux: the provider refused the request",
  });

/** The kind of input `text` is, from the recipe's own words. */
const passOf = (text: string): Seen["pass"] => {
  if (text.includes("Your earlier report")) {
    return "fresh";
  }

  if (/^Pass \d/u.test(text)) {
    return "resumed";
  }

  return text.includes("independent advisor reports") ? "matrix" : "report";
};

/** The council's faux nodes, and the root thread on the kit's own model. */
const councilModel =
  (seen: Array<Seen>): FauxResponseFactory =>
  async (transcript, _options, _state, model) => {
    if (model.id === KIT_MODEL.modelId) {
      return kitRespond(transcript);
    }

    const messages: ReadonlyArray<Message> = transcript.messages;
    const lastInput = messages.findLastIndex((m) => m.role === "user");
    const last = messages[lastInput];
    const input = last === undefined ? "" : messageText(last);
    const pass = passOf(input);
    const sinceInput = messages.slice(lastInput + 1);

    if (sinceInput.some((m) => m.role === "toolResult")) {
      return fauxAssistantMessage(fauxText("submitted"));
    }

    const inputs = messages.flatMap((m) =>
      m.role === "user" ? [messageText(m)] : []
    );

    seen.push({ model: model.id, pass, inputs });

    const continues = inputs.length > 1;

    if (model.id === "advisor-slow" && continues) {
      await pause(3000);
    }

    if (
      model.id === "advisor-fail" ||
      model.id === "judge-fail" ||
      (model.id === "advisor-forkfail" && continues)
    ) {
      return failed();
    }

    const id = `${pass}-${String(lastInput)}`;

    const advisor = /You are advisor (?<n>\d)/u.exec(input)?.groups?.n ?? "?";

    if (pass === "report") {
      return submit(REPORT(advisor), id);
    }

    return pass === "matrix"
      ? submit(MATRIX(model.id === "judge-settle"), id)
      : submit(RESPONSES(input), id);
  };

/** What the council returns, as far as these checks read it. */
const CouncilResult = Schema.Struct({
  pass1: Schema.Array(Schema.NullOr(Schema.Json)),
  matrix: Schema.NullOr(Schema.Json),
  pass2: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        advisor: Schema.Finite,
        fallback: Schema.NullOr(Schema.String),
        answer: Schema.Json,
      })
    )
  ),
  pass3: Schema.NullOr(Schema.Array(Schema.Json)),
  ownerDecisions: Schema.Array(Schema.String),
  roster: Schema.Array(
    Schema.Struct({
      advisor: Schema.Finite,
      role: Schema.String,
      report: Schema.Boolean,
      crossExam: Schema.Array(Schema.String),
    })
  ),
});

type CouncilResult = typeof CouncilResult.Type;

const decodeCouncil = Schema.decodeUnknownOption(
  Schema.fromJsonString(CouncilResult)
);

/** What one council run leaves behind. */
interface Run {
  readonly row: WorkflowItemState;
  readonly nodes: ReadonlyArray<NodeItemState>;
  /** The script's return value, read from the code mode result; none when it is no council result. */
  readonly council: Option.Option<CouncilResult>;
  readonly resultText: string;
  readonly seen: ReadonlyArray<Seen>;
  readonly problems: ReadonlyArray<string>;
}

/** The script's return value in a code mode result: the JSON from its first `{` to its last `}`. */
const councilOf = (text: string): Option.Option<CouncilResult> =>
  decodeCouncil(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

/** The decoded council result of `run`, failing the test when there is none. */
const resultOf = (run: Run): CouncilResult =>
  Option.getOrThrowWith(
    run.council,
    () => new Error(`not a council result: ${run.resultText}`)
  );

/** Waits until the row has ended (its watcher wrote it), at most `ms`. */
const endedRow = async (
  brain: KitBrain,
  ms: number
): Promise<Readonly<WorkflowsState> | undefined> => {
  const until = performance.now() + ms;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const ledger = await brain.harness.snapshot(
      WorkflowsDoc,
      brain.root,
      context
    );

    const state = ledger?.items[WF]?.state;

    if (
      performance.now() > until ||
      state === "finished" ||
      state === "failed" ||
      state === "stopped"
    ) {
      return ledger;
    }

    // oxlint-disable-next-line no-await-in-loop
    await pause(20);
  }
};

/**
 * Plants an approved launch of the council with `args` and runs it by name: the root thread's
 * model sends `codemode` the recipe reference, which the gate resolves to the recipe.
 */
const council = (
  args: { [key: string]: JsonValue },
  options: {
    readonly plant?: Partial<PlantInput>;
    readonly source?: string;
    /** Stops the node with this label once it runs. */
    readonly stop?: string;
  } = {}
) =>
  Effect.gen(function* () {
    const codemode = yield* CodeMode;
    const results = yield* ResultTool;
    const seen: Array<Seen> = [];

    const faux = fauxProvider({
      provider: KIT_MODEL.provider,
      models: [{ id: KIT_MODEL.modelId }, ...NODE_MODELS.map((id) => ({ id }))],
      tokensPerSecond: 50_000,
    });

    faux.setResponses(Array.from({ length: 500 }, () => councilModel(seen)));

    const models = createModels();

    models.setProvider(faux.provider);

    const registry = createRegistry();

    registry.install(codemode.extension.extension);
    registry.install(
      workflowExtension({
        resolveRole,
        faults: NO_WORKFLOW_FAULTS,
        hold: NO_HOLD,
      }).extension
    );
    registry.install(results.extension.extension);

    const brain = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await openKit(new MemoryStorage(), { models, registry }, context)
      ),
      (open) =>
        Effect.promise(async () => {
          await open.harness.close(context);
        })
    );

    yield* plant(
      brain,
      options.source ?? COUNCIL,
      { ...plantDefaults(WF), args, budget: DEFAULT_BUDGET, ...options.plant },
      context
    );

    return yield* Effect.promise(async (): Promise<Run> => {
      const stopping = { running: options.stop !== undefined };

      const stopper = (async () => {
        while (stopping.running) {
          // oxlint-disable-next-line no-await-in-loop
          const ledger = await brain.harness.snapshot(
            WorkflowsDoc,
            brain.root,
            context
          );

          const node = Object.values(ledger?.items[WF]?.nodes ?? {}).find(
            (each) =>
              each.label === options.stop &&
              each.state === "running" &&
              each.nestedTaskId !== null
          );

          if (node?.nestedTaskId !== undefined && node.nestedTaskId !== null) {
            // oxlint-disable-next-line no-await-in-loop
            await brain.harness.abortTask(taskOf(node.nestedTaskId), context);
            stopping.running = false;
          }

          // oxlint-disable-next-line no-await-in-loop
          await pause(5);
        }
      })();

      await runScript(
        brain,
        options.source ?? recipeReference("council"),
        "run-1",
        context
      );

      await brain.harness.waitForIdle(context);
      stopping.running = false;
      await stopper;

      const ledger: Readonly<WorkflowsState> = (await endedRow(
        brain,
        5000
      )) ?? { items: {} };

      const row = ledger.items[WF];

      if (row === undefined) {
        throw new Error("the council's row is gone");
      }

      const approvals = await brain.harness.snapshot(
        Approvals,
        brain.root,
        context
      );

      const resultText = await codemodeResultText(brain, context);

      return {
        row,
        nodes: Object.values(row.nodes).toSorted((a, b) => a.index - b.index),
        council: councilOf(resultText),
        resultText,
        seen,
        problems: ledgerProblems(ledger, approvals?.items ?? {}).map(
          (problem) => `${problem.nodeId}: ${problem.problem}`
        ),
      };
    });
  }).pipe(Effect.scoped, Effect.provide(KitLayer));

const ARGS = {
  question: "Should the brain keep one SQLite file per project?",
  scope: "apps/server/src/brain",
  advisors: ["@advisor-1", "@advisor-2"],
  judge: "@judge",
};

const labelsOf = (run: Run) =>
  run.nodes.map((node) => [node.label, node.state, node.phase]);

const nodeOf = (run: Run, label: string): NodeItemState => {
  const found = run.nodes.find((node) => node.label === label);

  assert.isDefined(found, `no node ${label}`);

  return found ?? run.nodes[0];
};

describe("the council recipe on a faux model", () => {
  it.live(
    "launched by name, is five nodes: two reports, a claim matrix and two resumed cross-examinations",
    () =>
      Effect.gen(function* () {
        const run = yield* council(ARGS);

        assert.deepStrictEqual(run.problems, []);
        assert.strictEqual(run.row.state, "finished", run.resultText);
        assert.deepStrictEqual(labelsOf(run), [
          ["Advisor 1 report", "settled", "Reports"],
          ["Advisor 2 report", "settled", "Reports"],
          ["Claim matrix", "settled", "Matrix"],
          ["Advisor 1 pass 2", "settled", "Cross-examination"],
          ["Advisor 2 pass 2", "settled", "Cross-examination"],
        ]);
        assert.deepStrictEqual(
          run.row.phases.map((phase) => phase.title),
          ["Reports", "Matrix", "Cross-examination"]
        );

        // Every typed node took one attempt (judge 9's count on the faux model).
        assert.deepStrictEqual(
          run.nodes.map((node) => node.schemaAttempts),
          [1, 1, 1, 1, 1]
        );

        const result = resultOf(run);

        assert.deepStrictEqual(result.roster, [
          {
            advisor: 1,
            role: "@advisor-1",
            report: true,
            crossExam: ["resumed"],
          },
          {
            advisor: 2,
            role: "@advisor-2",
            report: true,
            crossExam: ["resumed"],
          },
        ]);
        assert.deepStrictEqual(
          result.pass2,
          [1, 2].map((advisor) => ({
            advisor,
            fallback: null,
            answer: RESPONSES(`"claimId":"c${String(advisor)}"`),
          }))
        );
        assert.deepStrictEqual(result.ownerDecisions, [
          "decide-1",
          "decide-2",
          "c1",
          "c2",
        ]);
        assert.isNull(result.pass3);
      })
  );

  it.live(
    "resumes each advisor in a fork of its own report's child, with a receipt of its own",
    () =>
      Effect.gen(function* () {
        const run = yield* council(ARGS);

        for (const advisor of [1, 2]) {
          const report = nodeOf(run, `Advisor ${String(advisor)} report`);
          const resumed = nodeOf(run, `Advisor ${String(advisor)} pass 2`);

          // A child of its own, on the role the report ran as.
          assert.notStrictEqual(resumed.conversationId, report.conversationId);
          assert.strictEqual(resumed.role, report.role);

          // Its own receipt: one tool call (its submit_result), not the report's too.
          assert.strictEqual(resumed.receipt?.toolCalls, 1);
          assert.strictEqual(report.receipt?.toolCalls, 1);
        }

        const resumedRequests = run.seen.filter(
          (request) => request.pass === "resumed"
        );

        assert.strictEqual(resumedRequests.length, 2);

        // True cross-examination: each resumed child saw its own report's prompt first, then the
        // challenge packet, and nothing of the other advisor's report prompt.
        for (const request of resumedRequests) {
          assert.strictEqual(request.inputs.length, 2);

          const own = /You are advisor (?<n>\d)/u.exec(request.inputs[0] ?? "")
            ?.groups?.n;

          assert.isDefined(own);
          assert.include(request.inputs[1], `"claimId":"c${own ?? ""}"`);
          assert.include(request.inputs[1], "Another advisor: ");
          assert.isFalse(
            request.inputs.some((text) =>
              text.includes(`You are advisor ${own === "1" ? "2" : "1"}`)
            )
          );
        }
      })
  );

  it.live("a third pass resumes the second pass's node", () =>
    Effect.gen(function* () {
      // The dry run's stub matrix settles nothing, so the plan counts five nodes; the launch
      // grants seven.
      const run = yield* council(
        { ...ARGS, judge: "@judge-settle", maxPasses: 3 },
        { plant: { maxNodes: Option.some(7) } }
      );

      assert.strictEqual(run.row.state, "finished", run.resultText);
      assert.deepStrictEqual(
        run.nodes.map((node) => node.state),
        Array.from({ length: 7 }, () => "settled")
      );

      const third = run.seen.filter(
        (request) =>
          request.pass === "resumed" &&
          request.inputs.at(-1)?.startsWith("Pass 3") === true
      );

      assert.strictEqual(third.length, 2);

      // Report prompt, pass 2's packet, pass 3's: the chain, not a second fork of the report.
      for (const request of third) {
        assert.strictEqual(request.inputs.length, 3);
        assert.isTrue(request.inputs[1]?.startsWith("Pass 2"));
      }

      assert.deepStrictEqual(
        resultOf(run).roster.map((entry) => entry.crossExam),
        [
          ["resumed", "resumed"],
          ["resumed", "resumed"],
        ]
      );
    })
  );

  it.live(
    "with an advisor's report failed, stops after the first pass and returns what it has",
    () =>
      Effect.gen(function* () {
        const run = yield* council({
          ...ARGS,
          advisors: ["@advisor-1", "@advisor-fail"],
        });

        assert.deepStrictEqual(run.problems, []);
        assert.strictEqual(run.row.state, "finished", run.resultText);
        assert.deepStrictEqual(labelsOf(run), [
          ["Advisor 1 report", "settled", "Reports"],
          ["Advisor 2 report", "failed", "Reports"],
        ]);
        assert.deepStrictEqual(resultOf(run).pass1, [REPORT("1"), null]);
        assert.isNull(resultOf(run).matrix);
        assert.deepStrictEqual(resultOf(run).pass2, []);
        assert.include(
          Object.values(run.row.log).map((line) => line.text),
          "Fewer than two advisors reported; the council stops after its first pass."
        );
      })
  );

  it.live("with the claim matrix failed, returns the first pass only", () =>
    Effect.gen(function* () {
      const run = yield* council({ ...ARGS, judge: "@judge-fail" });

      assert.strictEqual(run.row.state, "finished", run.resultText);
      assert.deepStrictEqual(labelsOf(run), [
        ["Advisor 1 report", "settled", "Reports"],
        ["Advisor 2 report", "settled", "Reports"],
        ["Claim matrix", "failed", "Matrix"],
      ]);
      assert.deepStrictEqual(resultOf(run).pass1, [REPORT("1"), REPORT("2")]);
      assert.isNull(resultOf(run).matrix);
      assert.deepStrictEqual(resultOf(run).pass2, []);
    })
  );

  it.live(
    "with a third advisor's report failed, cross-examines the two that reported and leaves it null",
    () =>
      Effect.gen(function* () {
        const run = yield* council(
          { ...ARGS, advisors: ["@advisor-1", "@advisor-2", "@advisor-fail"] },
          { plant: { maxNodes: Option.some(7) } }
        );

        assert.strictEqual(run.row.state, "finished", run.resultText);
        assert.strictEqual(nodeOf(run, "Advisor 3 report").state, "failed");
        assert.isFalse(
          run.nodes.some((node) => node.label.startsWith("Advisor 3 pass"))
        );

        const { pass2, roster } = resultOf(run);

        assert.strictEqual(pass2.length, 3);
        assert.isNull(pass2[2]);
        assert.deepStrictEqual(
          roster.map((entry) => entry.crossExam),
          [["resumed"], ["resumed"], []]
        );
      })
  );

  it.live(
    "falls back to a fresh node, labelled, when an advisor's resumed node fails",
    () =>
      Effect.gen(function* () {
        const run = yield* council(
          { ...ARGS, advisors: ["@advisor-1", "@advisor-forkfail"] },
          { plant: { maxNodes: Option.some(7) } }
        );

        assert.deepStrictEqual(run.problems, []);
        assert.strictEqual(run.row.state, "finished", run.resultText);
        assert.deepStrictEqual(labelsOf(run), [
          ["Advisor 1 report", "settled", "Reports"],
          ["Advisor 2 report", "settled", "Reports"],
          ["Claim matrix", "settled", "Matrix"],
          ["Advisor 1 pass 2", "settled", "Cross-examination"],
          ["Advisor 2 pass 2", "failed", "Cross-examination"],
          ["Advisor 2 pass 2 (fresh)", "settled", "Cross-examination"],
        ]);

        assert.deepStrictEqual(
          resultOf(run).pass2.map((entry) =>
            entry === null ? "no entry" : entry.fallback
          ),
          [null, "fresh-context fallback, not true cross-exam"]
        );

        // The fresh node starts from nothing but its own report, given in its prompt.
        const fresh = run.seen.filter((request) => request.pass === "fresh");

        assert.strictEqual(fresh.length, 1);
        assert.strictEqual(fresh[0]?.inputs.length, 1);
        assert.include(fresh[0]?.inputs[0], JSON.stringify(REPORT("2")));
      })
  );

  it.live("a stopped cross-examination is null, with no fallback node", () =>
    Effect.gen(function* () {
      const run = yield* council(
        { ...ARGS, advisors: ["@advisor-slow", "@advisor-2"] },
        { plant: { maxNodes: Option.some(7) }, stop: "Advisor 1 pass 2" }
      );

      assert.strictEqual(run.row.state, "finished", run.resultText);
      assert.strictEqual(nodeOf(run, "Advisor 1 pass 2").state, "stopped");
      assert.isFalse(
        run.nodes.some((node) => node.label === "Advisor 1 pass 2 (fresh)")
      );

      assert.deepStrictEqual(resultOf(run).pass2[0], {
        advisor: 1,
        fallback: null,
        answer: null,
      });
    })
  );
});

/** A small workflow script around `body`, for the resume checks. */
const script = (body: string) =>
  `export const meta = {\n  name: "resume-check",\n  description: "Resume checks",\n};\n${body}`;

describe("agent's resume option", () => {
  it.live(
    "refuses a node that is not settled, so the script sees a failure",
    () =>
      Effect.gen(function* () {
        const run = yield* council(
          { advisors: ["@advisor-fail"] },
          {
            plant: { maxNodes: Option.some(3) },
            source:
              script(`const first = await agent.full("You are advisor 1 of 1.", { role: args.advisors[0], label: "first" });
const second = await agent.full("Pass 2. again", { resume: first.nodeId, label: "second" });
return { first: first.status, second };`),
          }
        );

        assert.strictEqual(run.row.state, "finished", run.resultText);
        assert.deepStrictEqual(labelsOf(run), [["first", "failed", null]]);
        assert.include(run.resultText, "cannot resume node");
        assert.include(
          run.resultText,
          "it is failed, and only a settled node can be resumed"
        );
      })
  );
});
