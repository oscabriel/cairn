import type { ThinkingLevel } from "@cairn/protocol/Models";
import type { Brief, WorkflowLaunch } from "@cairn/protocol/Policy";
import { RoleName, RoleSpec } from "@cairn/protocol/Roles";
import type {
  ResolvedRole,
  RoleCheck,
  SkippedModel,
} from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  goBlockOf,
  Resolution,
  roleQuestionOf,
  runsOnLine,
  runsOnText,
  takesRunOnOne,
  takesSendBack,
} from "./BriefGo.ts";
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
  role: RoleSpec.make("@worker"),
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
  spec: RoleSpec.make(spec),
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
  roleOverrides: WorkflowLaunch["roleOverrides"] = {}
): WorkflowLaunch => ({
  type: "workflow",
  workflowId: "wf-1",
  name: "Council",
  description: "Five reviewers, one verdict.",
  phases: [],
  scriptHash: "abc",
  scriptRef: "entry-1",
  args: null,
  callSites: [site("@scout"), site("@judge"), site("@scout")],
  nodes: { count, unbounded },
  estimate: null,
  envelope: {
    scriptHash: "abc",
    maxNodes: 5,
    maxConcurrent: 2,
    roles: [
      { spec: RoleSpec.make("@judge"), readonly: true, arms: "host" },
      { spec: RoleSpec.make("@verifier"), readonly: true, arms: "host" },
    ],
    modes: [],
    writes: [],
    budget: DEFAULT_BUDGET,
  },
  roleOverrides,
});

const resolvedCheck = (fields: {
  readonly spec: string;
  readonly via: ResolvedRole["via"];
  readonly thinkingLevel: ThinkingLevel | null;
  readonly sameFamilyAsWorker: boolean;
}): RoleCheck => ({
  spec: fields.spec,
  resolution: Resolution.cases.Resolved.make({
    resolved: {
      spec: RoleSpec.make(fields.spec),
      role: fields.spec.startsWith("@") ? RoleName.make(fields.spec) : null,
      model: { provider: "opencode-go", modelId: "gpt-6-luna" },
      thinkingLevel: fields.thinkingLevel,
      via: fields.via,
      skipped: [],
      family: "openai",
      priced: true,
    },
  }),
  sameFamilyAsWorker: fields.sameFamilyAsWorker,
});

const unresolvedCheck = (
  spec: string,
  reason: "unbound_role" | "invalid_spec" | "no_ready_model",
  skipped: ReadonlyArray<SkippedModel> = []
): RoleCheck => ({
  spec,
  resolution: Resolution.cases.Unresolved.make({ reason, skipped }),
  sameFamilyAsWorker: false,
});

describe("what the brief card asks about roles", () => {
  it("asks about a brief's role, else its model, else nothing", () => {
    assert.deepStrictEqual(
      roleQuestionOf(RequestBody.Brief({ payload: brief })),
      Option.some({ specs: ["@worker"], overrides: Option.none() })
    );
    assert.deepStrictEqual(
      roleQuestionOf(
        RequestBody.Brief({
          payload: {
            ...brief,
            role: null,
            model: { provider: "opencode-go", modelId: "gpt-6-luna" },
          },
        })
      ),
      Option.some({
        specs: ["opencode-go/gpt-6-luna"],
        overrides: Option.none(),
      })
    );
    assert.isTrue(
      Option.isNone(
        roleQuestionOf(RequestBody.Brief({ payload: { ...brief, role: null } }))
      )
    );
    assert.isTrue(
      Option.isNone(
        roleQuestionOf(
          RequestBody.Approval({
            summary: "Open the gate",
            payload: Option.none(),
          })
        )
      )
    );
  });

  it("asks about every spec a launch names once, with its overrides", () => {
    assert.deepStrictEqual(
      roleQuestionOf(RequestBody.Brief({ payload: launch(5, false) })),
      Option.some({
        specs: ["@scout", "@judge", "@verifier"],
        overrides: Option.none(),
      })
    );

    const overrides = {
      [RoleName.make("@scout")]: {
        model: { provider: "opencode-go", modelId: "gpt-6-luna" },
        thinkingLevel: null,
        fallbacks: [],
        note: null,
      },
    };

    assert.deepStrictEqual(
      Option.flatMap(
        roleQuestionOf(
          RequestBody.Brief({ payload: launch(5, false, overrides) })
        ),
        (question) => question.overrides
      ),
      Option.some(overrides)
    );
  });

  it("offers Send back on a subagent's brief only, and Run on 1 first on a launch of several nodes", () => {
    const body = RequestBody.Brief({ payload: brief });

    assert.isTrue(
      takesSendBack({ kind: "brief", tool: "subagent_spawn" }, body)
    );
    assert.isFalse(takesSendBack({ kind: "brief", tool: "agent" }, body));
    assert.isFalse(
      takesSendBack(
        { kind: "brief", tool: "subagent_spawn" },
        RequestBody.Brief({ payload: launch(5, false) })
      )
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
  it("is not blocked while every spec resolves", () => {
    assert.isTrue(
      Option.isNone(
        goBlockOf([
          resolvedCheck({
            spec: "@worker",
            via: "primary",
            thinkingLevel: "medium",
            sameFamilyAsWorker: false,
          }),
        ])
      )
    );
  });

  it("says plainly which spec blocks it and why", () => {
    assert.deepStrictEqual(
      goBlockOf([
        resolvedCheck({
          spec: "@worker",
          via: "primary",
          thinkingLevel: null,
          sameFamilyAsWorker: false,
        }),
        unresolvedCheck("@reviewer", "unbound_role"),
      ]),
      Option.some({
        spec: "@reviewer",
        title: "Go is blocked: no role named @reviewer is in the role table.",
        detail:
          "Bind it in the role table, then check again, or send the brief back.",
      })
    );
    assert.deepStrictEqual(
      Option.map(
        goBlockOf([unresolvedCheck("@x:bogus", "invalid_spec")]),
        (block) => block.title
      ),
      Option.some("Go is blocked: @x:bogus is neither a role nor a model.")
    );
    assert.deepStrictEqual(
      goBlockOf([
        unresolvedCheck("@verifier", "no_ready_model", [
          {
            model: { provider: "openai-codex", modelId: "gpt-6-luna" },
            reason: "missing_credential",
          },
        ]),
      ]),
      Option.some({
        spec: "@verifier",
        title:
          "Go is blocked: no model is ready for @verifier (openai-codex/gpt-6-luna has no credential here).",
        detail: "Bind it to a ready model in the role table, then check again.",
      })
    );
  });

  it("says what each spec runs on, with a fallback and a judge on the worker's family", () => {
    assert.strictEqual(
      runsOnText(
        resolvedCheck({
          spec: "@judge",
          via: "fallback",
          thinkingLevel: "high",
          sameFamilyAsWorker: true,
        })
      ),
      "@judge: opencode-go/gpt-6-luna at high (its fallback, same model family as @worker)"
    );
    assert.strictEqual(
      runsOnLine([
        resolvedCheck({
          spec: "opencode-go/gpt-6-luna",
          via: "literal",
          thinkingLevel: null,
          sameFamilyAsWorker: false,
        }),
        unresolvedCheck("@reviewer", "unbound_role"),
      ]),
      "opencode-go/gpt-6-luna: opencode-go/gpt-6-luna; @reviewer: not bound"
    );
  });
});
