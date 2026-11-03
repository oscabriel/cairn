// The launch approval's pure rules (ADR 0032): what the envelope covers (`briefWithin`, keyed by
// model per ADR 0043, a role name an envelope recorded before it reading as the launching thread's
// model), how a
// launch's answer moves its row (`applyLaunchAnswer`), the brief a node is dispatched under, and
// the ledger check's envelope rule (a brief its envelope accepted names this workflow's accepted
// launch).

import { ApprovalId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import { Brief, WorkflowLaunch } from "@cairn/protocol/Policy";
import type { Envelope } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { UNDECIDED } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { jsonRecordOf } from "../subagents/SubagentDocs.ts";
import {
  ledgerProblems,
  nodeRequestIdOf,
  proposedRecord,
} from "./WorkflowDocs.ts";
import type { NodeItemState, WorkflowItemState } from "./WorkflowDocs.ts";
import {
  applyLaunchAnswer,
  briefWithin,
  isNodeBrief,
  nodeBriefPayload,
  nodeBriefRecord,
} from "./WorkflowLaunch.ts";

const envelope: Envelope = {
  scriptHash: "sha256-abc",
  maxNodes: 3,
  maxConcurrent: 2,
  roles: [
    {
      spec: ModelSpec.make("opencode-go/gpt-6-luna"),
      readonly: true,
      arms: "host",
    },
    { spec: ModelSpec.make("faux/kit:high"), readonly: false, arms: "host" },
  ],
  modes: ["auto-accept-edits"],
  writes: [],
  budget: DEFAULT_BUDGET,
};

const launch = WorkflowLaunch.make({
  type: "workflow",
  workflowId: "wf-7",
  name: "kit-flow",
  description: "A kit workflow",
  phases: [],
  scriptHash: "sha256-abc",
  scriptRef: "task-7",
  args: {},
  callSites: [],
  nodes: { count: 3, unbounded: false },
  estimate: null,
  envelope,
});

const launchRecord = (
  fields: Partial<ApprovalRecord> = {}
): ApprovalRecord => ({
  id: "call-7",
  toolTaskId: 7,
  tool: "workflow_plan",
  kind: "brief",
  summary: "Run workflow kit-flow: 3 nodes",
  status: "pending",
  askedAt: 1,
  expiresAt: 2,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  ...UNDECIDED,
  payload: jsonRecordOf(Schema.encodeSync(WorkflowLaunch)(launch)),
  ...fields,
});

const row = (): WorkflowItemState =>
  proposedRecord({ launch, approvalId: "call-7", sample: Option.none() });

/** The launching thread's model. */
const THREAD: ModelRef = { provider: "faux", modelId: "kit" };

const LUNA: ModelRef = { provider: "opencode-go", modelId: "gpt-6-luna" };

const ask = (fields: Partial<Parameters<typeof briefWithin>[1]> = {}) => ({
  model: THREAD,
  readonly: false,
  mode: "auto-accept-edits" as const,
  dispatched: 0,
  threadModel: Option.some(THREAD),
  ...fields,
});

const refusal = (fields: Partial<Parameters<typeof briefWithin>[1]>) =>
  Option.map(briefWithin(envelope, ask(fields)), (outside) => outside.refusal);

describe("the envelope", () => {
  it("covers a granted model at any level, a reader under a writer grant, and narrower modes", () => {
    assert.isTrue(Option.isNone(briefWithin(envelope, ask())));
    assert.isTrue(
      Option.isNone(briefWithin(envelope, ask({ model: LUNA, readonly: true })))
    );
    assert.isTrue(
      Option.isNone(briefWithin(envelope, ask({ readonly: true })))
    );
    assert.isTrue(
      Option.isNone(briefWithin(envelope, ask({ mode: "approval-required" })))
    );
    assert.isTrue(
      Option.isNone(
        briefWithin({ ...envelope, modes: [] }, ask({ mode: "full-access" }))
      )
    );
  });

  it("does not cover another model, a writer under a reader grant, a wider mode, or a node past the cap", () => {
    const other: ModelRef = { provider: "anthropic", modelId: "claude-x" };

    assert.deepStrictEqual(
      refusal({ model: other }),
      Option.some("outside_grant")
    );
    assert.deepStrictEqual(
      refusal({ model: LUNA, readonly: false }),
      Option.some("outside_grant")
    );
    assert.deepStrictEqual(
      refusal({ mode: "full-access" }),
      Option.some("outside_grant")
    );
    assert.deepStrictEqual(refusal({ dispatched: 3 }), Option.some("node_cap"));

    const words = Option.map(
      briefWithin(envelope, ask({ model: other })),
      (outside) => outside.why
    );

    assert.deepStrictEqual(
      words,
      Option.some("the launch did not show model anthropic/claude-x")
    );
  });

  it("reads a role name an envelope recorded before ADR 0043 as the launching thread's model", () => {
    const recorded: Envelope = {
      ...envelope,
      roles: [
        { spec: ModelSpec.make("@scout"), readonly: true, arms: "host" },
        { spec: ModelSpec.make("@worker:high"), readonly: false, arms: "host" },
      ],
    };

    assert.isTrue(Option.isNone(briefWithin(recorded, ask())));
    assert.isTrue(
      Option.isNone(briefWithin(recorded, ask({ readonly: true })))
    );
    assert.deepStrictEqual(
      Option.map(briefWithin(recorded, ask({ model: LUNA })), (o) => o.refusal),
      Option.some("outside_grant")
    );
    // With no thread model to read them as, the role names grant nothing.
    assert.deepStrictEqual(
      Option.map(
        briefWithin(recorded, ask({ threadModel: Option.none() })),
        (o) => o.refusal
      ),
      Option.some("outside_grant")
    );
  });
});

describe("a launch's answer", () => {
  it("Go approves the row once, with who decided and when", () => {
    const workflow = row();

    const accepted = launchRecord({
      status: "accepted",
      answeredAt: 9,
      decidedBy: { kind: "user" },
      answer: { decision: "accept", answers: null, note: null, launch: null },
    });

    assert.isTrue(applyLaunchAnswer(workflow, accepted));
    assert.strictEqual(workflow.state, "approved");
    assert.strictEqual(workflow.decidedAt, 9);
    assert.isNull(workflow.sample);
    assert.isFalse(applyLaunchAnswer(workflow, accepted), "once");
  });

  it("Run on 1 first approves with sample 1, and the card's budget replaces the row's", () => {
    const workflow = row();

    const sampled = launchRecord({
      status: "accepted",
      answeredAt: 9,
      decidedBy: { kind: "user" },
      answer: {
        decision: "accept_sample",
        answers: null,
        note: null,
        // An answer recorded before ADR 0043 also carried role overrides; they are ignored.
        launch: {
          budget: { ...DEFAULT_BUDGET, maxTokens: 4000 },
          roleOverrides: { "@scout": { model: LUNA } },
        },
      },
    });

    assert.isTrue(applyLaunchAnswer(workflow, sampled));
    assert.strictEqual(workflow.sample, 1);
    assert.strictEqual(workflow.budget.maxTokens, 4000);
  });

  it("anything but Go declines the row; a pending record moves nothing", () => {
    const pending = row();

    assert.isFalse(applyLaunchAnswer(pending, launchRecord()));
    assert.strictEqual(pending.state, "proposed");

    for (const status of [
      "declined",
      "revised",
      "expired",
      "cancelled",
    ] as const) {
      const workflow = row();

      assert.isTrue(
        applyLaunchAnswer(workflow, launchRecord({ status, answeredAt: 4 }))
      );
      assert.strictEqual(workflow.state, "declined", status);
      assert.strictEqual(workflow.endedAt, 4);
    }
  });
});

describe("a node's brief", () => {
  it("is a brief the protocol reads, saying why when the envelope does not cover it", () => {
    const payload = nodeBriefPayload({
      workflowName: "kit-flow",
      label: "Read a.ts",
      prompt: "node:a",
      spec: Option.some("opencode-go/gpt-6-luna"),
      effort: Option.some("high"),
      readonly: true,
      mode: "full-access",
      budget: DEFAULT_BUDGET,
      resultSchema: Option.none(),
      outside: Option.some({
        refusal: "outside_grant",
        why: "the launch did not show model opencode-go/gpt-6-luna",
      }),
    });

    const brief = Schema.decodeUnknownSync(Brief)(payload);

    // The named model travels in the node's brief, so the card checks it.
    assert.strictEqual(brief.role, "opencode-go/gpt-6-luna");

    assert.strictEqual(brief.title, "Read a.ts");
    assert.strictEqual(brief.thinking, "high");
    assert.strictEqual(brief.mayCommit, false);
    assert.include(brief.why, "did not show model opencode-go/gpt-6-luna");

    const covered = nodeBriefRecord({
      id: "call-12",
      toolTaskId: 12,
      tool: "agent",
      summary: "Run node",
      at: 5,
      payload,
      envelope: Option.some("call-7"),
    });

    assert.strictEqual(covered.status, "accepted");
    assert.deepStrictEqual(covered.decidedBy, {
      kind: "envelope",
      approvalId: ApprovalId.make("call-7"),
    });
    assert.isTrue(isNodeBrief(covered));
    assert.isFalse(isNodeBrief(launchRecord()));
  });
});

const node = (id: string, briefId: string | null): NodeItemState => ({
  id,
  workflowId: "wf-7",
  key: null,
  label: id,
  phase: null,
  index: 0,
  requestId: nodeRequestIdOf("wf-7", id),
  briefId,
  role: "@worker",
  provider: "faux",
  modelId: "kit",
  effort: null,
  readonly: false,
  arms: "host",
  state: "settled",
  stage: "answered",
  childThreadId: null,
  conversationId: 9,
  submissionId: null,
  nestedTaskId: 12,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: 3,
  endedAt: 4,
  error: null,
});

/** A node brief its envelope (`approvalId`) accepted. */
const byEnvelope = (id: string, approvalId: string): ApprovalRecord =>
  nodeBriefRecord({
    id,
    toolTaskId: 1,
    tool: "agent",
    summary: "Run node",
    at: 1,
    payload: null,
    envelope: Option.some(approvalId),
  });

/** The launch (`call-7`, at `status`) and two node briefs its envelope accepted, one naming another launch. */
const envelopeRecords = (status: ApprovalRecord["status"]) => ({
  "call-7": launchRecord({ status }),
  "call-1": byEnvelope("call-1", "call-7"),
  "call-2": byEnvelope("call-2", "call-99"),
});

describe("the ledger check's envelope rule", () => {
  it("a brief its envelope accepted must name this workflow's accepted launch", () => {
    const workflow = row();

    workflow.nodes["n-1"] = node("n-1", "call-1");
    workflow.nodes["n-2"] = node("n-2", "call-2");
    // A row that waited for its brief and was stopped started nothing: no child, no check.
    workflow.nodes["n-3"] = {
      ...node("n-3", "call-3"),
      conversationId: null,
      state: "stopped",
    };

    const records = envelopeRecords;
    const ledger = { items: { [workflow.id]: workflow } };

    assert.deepStrictEqual(
      ledgerProblems(ledger, records("accepted")).map((found) => found.problem),
      ["brief call-2 names envelope call-99, not its launch call-7"]
    );
    assert.deepStrictEqual(
      ledgerProblems(ledger, records("declined")).map((found) => found.nodeId),
      ["n-1", "n-2"]
    );
  });
});
