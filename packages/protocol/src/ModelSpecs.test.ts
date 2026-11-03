// The model spec pattern: a `provider/model` whose model id may hold `@` (a Workers AI id such as
// `@cf/meta/...`), with an optional thinking suffix; and a role name from before ADR 0043, which
// stored records still hold and must still decode. Then those records themselves.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { ModelSpec } from "./ModelSpecs.ts";
import { Brief, LaunchEdits, WorkflowLaunch } from "./Policy.ts";
import { DispatchRecord } from "./Subagents.ts";
import { NodeRecord } from "./Workflows.ts";

const decodes = Schema.is(ModelSpec);

describe("a model spec", () => {
  it("is a model with an optional thinking suffix, or a stored role name", () => {
    assert.deepStrictEqual(
      [
        "opencode-go/gpt-6-luna",
        "opencode-go/gpt-6-luna:low",
        "cloudflare-workers-ai/@cf/meta/llama-4-scout",
        "cloudflare-workers-ai/@cf/meta/llama-4-scout:low",
        "@worker",
        "@worker:high",
      ].map(decodes),
      [true, true, true, true, true, true]
    );
  });

  it("refuses a model with no provider and a role outside the old name rule", () => {
    assert.deepStrictEqual(
      ["gpt-6-luna", "@a-role-name-longer-than-24", "@Worker"].map(decodes),
      [false, false, false]
    );
  });
});

// Records written before ADR 0043 removed roles: a subagent's dispatch record, a brief and a node
// row naming a role, a goal's model judge on `@judge`, and a workflow's frozen launch payload whose
// envelope and call sites are keyed by role, with per-launch role overrides and the user's edits.
// Each must still decode under today's schemas: a role name where a spec goes, and the fields roles
// had (`role`, `via`, `skipped`, `family`, `roleOverrides`), which decoding drops.
const OLD_BUDGET = {
  maxListMicros: null,
  maxTokens: null,
  maxTurns: null,
  maxMinutes: null,
  planGuard: null,
  warnAt: 0.8,
};

const OLD_BINDING = {
  model: { provider: "opencode-go", modelId: "gpt-6-luna" },
  thinkingLevel: null,
  fallbacks: [],
  note: null,
};

describe("records written before roles were removed", () => {
  it("decodes a subagent's dispatch record that resolved @worker", () => {
    const decoded = Schema.decodeUnknownSync(DispatchRecord)({
      spec: "@worker",
      resolved: {
        spec: "@worker",
        role: "@worker",
        model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
        thinkingLevel: "medium",
        via: "fallback",
        skipped: [
          {
            model: { provider: "anthropic", modelId: "claude-opus-5-5" },
            reason: "missing_credential",
          },
        ],
        family: "anthropic",
        priced: true,
      },
      previewed: null,
      dispatchedAt: 1_761_000_000_000,
    });

    assert.deepStrictEqual(decoded.resolved, {
      spec: ModelSpec.make("@worker"),
      model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
      thinkingLevel: "medium",
      priced: true,
    });
  });

  it("decodes a frozen launch keyed by role, with its overrides and edits", () => {
    const launch = Schema.decodeUnknownSync(WorkflowLaunch)({
      type: "workflow",
      workflowId: "wf-7",
      name: "council",
      description: "Two advisors and a judge",
      phases: [],
      scriptHash: "sha256-abc",
      scriptRef: "task-7",
      args: { advisors: ["@worker", "@scout"], judge: "@judge" },
      callSites: [
        {
          spec: "@scout",
          label: "Advisor",
          phase: null,
          schemaName: null,
          readonly: true,
          arms: "host",
          maxCount: 2,
        },
      ],
      nodes: { count: 3, unbounded: false },
      estimate: null,
      envelope: {
        scriptHash: "sha256-abc",
        maxNodes: 3,
        maxConcurrent: 2,
        roles: [
          { spec: "@scout", readonly: true, arms: "host" },
          { spec: "@judge:high", readonly: true, arms: "host" },
        ],
        modes: ["full-access"],
        writes: [],
        budget: OLD_BUDGET,
      },
      roleOverrides: { "@judge": OLD_BINDING },
    });

    assert.deepStrictEqual(
      launch.envelope.roles.map((entry) => entry.spec),
      ["@scout", "@judge:high"]
    );
    assert.isFalse(Object.hasOwn(launch, "roleOverrides"));

    const edits = Schema.decodeUnknownSync(LaunchEdits)({
      budget: OLD_BUDGET,
      roleOverrides: { "@scout": OLD_BINDING },
    });

    assert.deepStrictEqual(Object.keys(edits), ["budget"]);
  });

  it("decodes a brief, a node row and a goal's judge naming roles", () => {
    const brief = Schema.decodeUnknownSync(Brief)({
      type: "brief",
      title: "Count the files",
      task: "Count the files in the project root.",
      why: "",
      avoid: [],
      doneWhen: [
        {
          text: "The judge agrees.",
          judge: { kind: "model", spec: "@judge", rubric: "A count." },
        },
      ],
      workspace: "shared",
      base: null,
      writes: [],
      role: "@scout:high",
      model: null,
      thinking: null,
      mode: "full-access",
      mayCommit: false,
      budget: OLD_BUDGET,
      resultSchema: null,
      wake: "answer",
      decisions: [],
      roleOverrides: {},
    });

    assert.strictEqual(brief.role, "@scout:high");
    assert.deepStrictEqual(brief.doneWhen[0].judge, {
      kind: "model",
      spec: ModelSpec.make("@judge"),
      rubric: "A count.",
    });

    const node = Schema.decodeSync(NodeRecord.fields.role)("@worker");

    assert.strictEqual(node, "@worker");
  });
});
