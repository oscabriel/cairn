import type { ThinkingLevel } from "@cairn/protocol/Models";
import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import type { ModelCheck, ModelCheckFailure } from "@cairn/protocol/ModelSpecs";
import type { Brief, JudgeRef, WorkflowLaunch } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  goBlockOf,
  judgeModelText,
  modelQuestionOf,
  Resolution,
  runsOnLine,
  runsOnText,
  takesRunOnOne,
  takesSendBack,
} from "./BriefGo.ts";
import { judgeChip } from "./GoalProgress.ts";
import { judgeText } from "./PendingCard.ts";
import { RequestBody } from "./PendingRequests.ts";

const brief: Brief = {
  type: "brief",
  title: "Count the files",
  task: "Count the TypeScript files under src.",
  why: "To size the port.",
  avoid: [],
  doneWhen: [
    { text: "The parent accepts the result.", judge: { kind: "user" } },
  ],
  workspace: "shared",
  base: null,
  writes: [],
  role: ModelSpec.make("opencode-go/gpt-6-luna:high"),
  model: null,
  thinking: null,
  mode: "full-access",
  mayCommit: false,
  budget: DEFAULT_BUDGET,
  resultSchema: null,
  wake: "answer",
  decisions: [],
};

const site = (spec: string) => ({
  spec: ModelSpec.make(spec),
  label: "review",
  phase: null,
  schemaName: null,
  readonly: true,
  arms: "host" as const,
  maxCount: null,
});

const launch = (
  count: number,
  unbounded: boolean,
  specs: ReadonlyArray<string> = [
    "faux/scripted:medium",
    "opencode-go/gpt-6-luna",
    "faux/scripted:medium",
  ]
): WorkflowLaunch => ({
  type: "workflow",
  workflowId: "wf-1",
  name: "Council",
  description: "Five reviewers, one verdict.",
  phases: [],
  scriptHash: "abc",
  scriptRef: "entry-1",
  args: null,
  callSites: specs.map(site),
  nodes: { count, unbounded },
  estimate: null,
  envelope: {
    scriptHash: "abc",
    maxNodes: 5,
    maxConcurrent: 2,
    roles: [
      {
        spec: ModelSpec.make("opencode-go/gpt-6-luna"),
        readonly: true,
        arms: "host",
      },
      {
        spec: ModelSpec.make("opencode-go/kimi-k2"),
        readonly: true,
        arms: "host",
      },
    ],
    modes: [],
    writes: [],
    budget: DEFAULT_BUDGET,
  },
});

const resolvedCheck = (
  spec: string,
  thinkingLevel: ThinkingLevel | null
): ModelCheck => ({
  spec,
  resolution: Resolution.cases.Resolved.make({
    resolved: {
      spec: ModelSpec.make(spec),
      model: { provider: "opencode-go", modelId: "gpt-6-luna" },
      thinkingLevel,
      priced: true,
    },
  }),
});

const spawn = { tool: "subagent_spawn" };

const unresolvedCheck = (
  spec: string,
  reason: ModelCheckFailure
): ModelCheck => ({
  spec,
  resolution: Resolution.cases.Unresolved.make({ reason }),
});

describe("what the brief card asks about models", () => {
  it("asks about the model a brief names, else nothing: it runs on its parent's", () => {
    assert.deepStrictEqual(
      modelQuestionOf(spawn, RequestBody.Brief({ payload: brief })),
      Option.some({ specs: ["opencode-go/gpt-6-luna:high"] })
    );
    assert.deepStrictEqual(
      modelQuestionOf(
        spawn,
        RequestBody.Brief({
          payload: {
            ...brief,
            role: null,
            model: { provider: "opencode-go", modelId: "gpt-6-luna" },
          },
        })
      ),
      Option.some({ specs: ["opencode-go/gpt-6-luna"] })
    );
    assert.isTrue(
      Option.isNone(
        modelQuestionOf(
          spawn,
          RequestBody.Brief({ payload: { ...brief, role: null } })
        )
      )
    );
    assert.isTrue(
      Option.isNone(
        modelQuestionOf(
          spawn,
          RequestBody.Approval({
            summary: "Open the gate",
            payload: Option.none(),
          })
        )
      )
    );
  });

  it("asks nothing about a role a brief recorded before roles were removed", () => {
    for (const role of ["@worker", "@scout:high"]) {
      for (const tool of ["subagent_spawn", "agent", "verify"]) {
        assert.isTrue(
          Option.isNone(
            modelQuestionOf(
              { tool },
              RequestBody.Brief({
                payload: { ...brief, role: ModelSpec.make(role) },
              })
            )
          ),
          `${tool} ${role}`
        );
      }
    }
  });

  it("asks about a workflow node's own brief, and not another tool's", () => {
    for (const tool of ["agent", "verify"]) {
      assert.deepStrictEqual(
        modelQuestionOf({ tool }, RequestBody.Brief({ payload: brief })),
        Option.some({ specs: ["opencode-go/gpt-6-luna:high"] })
      );
    }

    assert.isTrue(
      Option.isNone(
        modelQuestionOf(
          { tool: "other" },
          RequestBody.Brief({ payload: brief })
        )
      )
    );
  });

  it("asks about every model a launch names once, leaving out recorded roles", () => {
    assert.deepStrictEqual(
      modelQuestionOf(spawn, RequestBody.Brief({ payload: launch(5, false) })),
      Option.some({
        specs: [
          "faux/scripted:medium",
          "opencode-go/gpt-6-luna",
          "opencode-go/kimi-k2",
        ],
      })
    );

    const old = launch(5, false, ["@scout", "@judge"]);

    assert.deepStrictEqual(
      modelQuestionOf(
        spawn,
        RequestBody.Brief({
          payload: {
            ...old,
            envelope: {
              ...old.envelope,
              roles: [
                {
                  spec: ModelSpec.make("@scout"),
                  readonly: true,
                  arms: "host",
                },
              ],
            },
          },
        })
      ),
      Option.none()
    );
  });

  it("offers Send back on a subagent's brief and a launch, and Run on 1 first on a launch of several nodes", () => {
    const body = RequestBody.Brief({ payload: brief });
    const launchBody = RequestBody.Brief({ payload: launch(5, false) });

    assert.isTrue(
      takesSendBack({ kind: "brief", tool: "subagent_spawn" }, body)
    );
    assert.isFalse(takesSendBack({ kind: "brief", tool: "agent" }, body));
    assert.isFalse(
      takesSendBack({ kind: "brief", tool: "subagent_spawn" }, launchBody)
    );
    assert.isTrue(
      takesSendBack({ kind: "brief", tool: "workflow_plan" }, launchBody)
    );
    assert.isFalse(
      takesSendBack({ kind: "brief", tool: "workflow_plan" }, body)
    );

    assert.isFalse(takesRunOnOne(body));
    assert.isTrue(
      takesRunOnOne(RequestBody.Brief({ payload: launch(5, false) }))
    );
    assert.isTrue(
      takesRunOnOne(RequestBody.Brief({ payload: launch(1, true) }))
    );
    assert.isFalse(
      takesRunOnOne(RequestBody.Brief({ payload: launch(1, false) }))
    );
  });
});

describe("why Go is blocked", () => {
  it("is not blocked while every named model resolves", () => {
    assert.isTrue(
      Option.isNone(
        goBlockOf([resolvedCheck("opencode-go/gpt-6-luna", "medium")])
      )
    );
  });

  it("says plainly which model blocks it and why", () => {
    assert.deepStrictEqual(
      goBlockOf([
        resolvedCheck("faux/scripted", null),
        unresolvedCheck("openai-codex/gpt-6-luna", "missing_credential"),
      ]),
      Option.some({
        spec: "openai-codex/gpt-6-luna",
        title:
          "Go is blocked: openai-codex/gpt-6-luna is not ready, as its provider has no usable credential.",
        detail: "Check again once it is ready, or send it back.",
      })
    );

    const cases: ReadonlyArray<readonly [string, ModelCheckFailure]> = [
      ["gpt-6-luna", "invalid_spec"],
      ["@judge", "role_removed"],
      ["opencode-go/nope", "unknown_model"],
      ["claude-bridge/claude-opus-5-5", "limited"],
      ["opencode-go/gpt-6-luna", "failing"],
    ];

    assert.deepStrictEqual(
      cases.map(([spec, reason]) =>
        Option.map(
          goBlockOf([unresolvedCheck(spec, reason)]),
          (block) => block.title
        )
      ),
      [
        Option.some(
          "Go is blocked: gpt-6-luna is not a model (provider/modelId)."
        ),
        Option.some("Go is blocked: @judge is a role, and roles were removed."),
        Option.some(
          "Go is blocked: opencode-go/nope is not ready, as it is not in the model catalog."
        ),
        Option.some(
          "Go is blocked: claude-bridge/claude-opus-5-5 is not ready, as its plan limit is reached."
        ),
        Option.some(
          "Go is blocked: opencode-go/gpt-6-luna is not ready, as its provider is failing."
        ),
      ]
    );
  });

  it("says what each named model runs on, with its level", () => {
    assert.strictEqual(
      runsOnText(resolvedCheck("opencode-go/gpt-6-luna:high", "high")),
      "opencode-go/gpt-6-luna at high"
    );
    assert.strictEqual(
      runsOnLine([
        resolvedCheck("opencode-go/gpt-6-luna", null),
        unresolvedCheck("opencode-go/nope", "unknown_model"),
      ]),
      "opencode-go/gpt-6-luna; opencode-go/nope: not in the catalog"
    );
  });
});

const judge = (spec: string | null): JudgeRef => ({
  kind: "model",
  spec: spec === null ? null : ModelSpec.make(spec),
  rubric: "A count.",
});

describe("a goal's model judge", () => {
  it("names its model, or the goal thread's when it names none or a recorded role", () => {
    assert.deepStrictEqual(
      [null, "@judge", "opencode-go/gpt-6-luna"].map(judgeModelText),
      ["this thread's", "this thread's", "opencode-go/gpt-6-luna"]
    );
    assert.strictEqual(judgeChip(judge(null)), "Model: this thread's");
    assert.strictEqual(judgeText(judge(null)), "a model (this thread's)");
    assert.strictEqual(
      judgeText(judge("opencode-go/gpt-6-luna")),
      "a model (opencode-go/gpt-6-luna)"
    );
  });
});
