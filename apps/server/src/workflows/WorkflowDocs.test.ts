// The ledger's pure rules: a proposed row decodes as the protocol's `WorkflowRecord` (S23, plain
// JSON), the node cap's count, and the ledger check every judge runs. The envelope's checks are
// WorkflowLaunch.test.ts's.

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { Envelope } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { WorkflowsDocument } from "@cairn/protocol/Workflows";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { UNDECIDED } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { jsonRecordOf } from "../subagents/SubagentDocs.ts";
import {
  approveRecord,
  dispatchedCount,
  envelopeOf,
  ledgerProblems,
  nodeRequestIdOf,
  proposedRecord,
} from "./WorkflowDocs.ts";
import type { NodeItemState, WorkflowItemState } from "./WorkflowDocs.ts";

const envelope: Envelope = {
  scriptHash: "sha256-abc",
  maxNodes: 3,
  maxConcurrent: 2,
  roles: [
    { spec: RoleSpec.make("@scout"), readonly: true, arms: "host" },
    { spec: RoleSpec.make("@worker"), readonly: false, arms: "host" },
  ],
  modes: ["approval-required"],
  writes: [],
  budget: DEFAULT_BUDGET,
};

const launch = WorkflowLaunch.make({
  type: "workflow",
  workflowId: "wf-7",
  name: "kit-flow",
  description: "A kit workflow",
  phases: [{ title: "Fan", detail: null }],
  scriptHash: "sha256-abc",
  scriptRef: "script-wf-7",
  args: { files: ["a.ts"] },
  callSites: [],
  nodes: { count: 2, unbounded: false },
  estimate: null,
  envelope,
  roleOverrides: {},
});

const record = (status: ApprovalRecord["status"]): ApprovalRecord => ({
  id: "launch-wf-7",
  toolTaskId: 7,
  tool: "workflow_plan",
  kind: "brief",
  summary: "Run kit-flow",
  status,
  askedAt: 1,
  expiresAt: 2,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  ...UNDECIDED,
  payload: jsonRecordOf(Schema.encodeSync(WorkflowLaunch)(launch)),
});

const node = (
  id: string,
  state: NodeItemState["state"],
  briefId: string | null
): NodeItemState => ({
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
  state,
  stage: "child_created",
  childThreadId: null,
  conversationId: 9,
  submissionId: null,
  nestedTaskId: 12,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: state === "refused" ? "node_cap" : null,
  held: null,
  startedAt: 3,
  endedAt: null,
  error: null,
});

const row = (): WorkflowItemState =>
  proposedRecord({ launch, approvalId: "launch-wf-7", sample: Option.none() });

const decodeDocument = Schema.decodeUnknownSync(WorkflowsDocument);

describe("the dispatch ledger's rules", () => {
  it("a proposed, approved row with nodes decodes as the protocol's document", () => {
    const workflow = row();

    assert.isTrue(approveRecord(workflow, { kind: "user" }, 5));
    assert.isFalse(approveRecord(workflow, { kind: "user" }, 6), "once");

    workflow.nodes["n-12"] = node("n-12", "running", "launch-wf-7");

    const decoded = decodeDocument({ items: { [workflow.id]: workflow } });

    assert.strictEqual(decoded.items["wf-7"]?.state, "approved");
    assert.strictEqual(decoded.items["wf-7"]?.decidedAt, 5);
    assert.strictEqual(
      decoded.items["wf-7"]?.nodes["n-12"]?.requestId,
      "wf-wf-7-n-12"
    );
  });

  it("the envelope of a planted launch is read back from the record", () => {
    assert.deepStrictEqual(
      Option.getOrThrow(envelopeOf(record("accepted"))),
      envelope
    );
    assert.isTrue(
      Option.isNone(envelopeOf({ ...record("accepted"), payload: null }))
    );
  });

  it("refused rows do not count against the cap", () => {
    const workflow = row();

    workflow.nodes["n-1"] = node("n-1", "settled", "launch-wf-7");
    workflow.nodes["n-2"] = node("n-2", "refused", null);
    workflow.nodes["n-3"] = node("n-3", "running", "launch-wf-7");

    assert.strictEqual(dispatchedCount(workflow), 2);
  });

  it("the ledger check names every dispatched row without an accepted brief", () => {
    const workflow = row();

    workflow.nodes["n-1"] = node("n-1", "settled", "launch-wf-7");
    workflow.nodes["n-2"] = node("n-2", "refused", null);
    workflow.nodes["n-3"] = node("n-3", "running", null);

    const ledger = { items: { [workflow.id]: workflow } };

    assert.deepStrictEqual(
      ledgerProblems(ledger, { "launch-wf-7": record("accepted") }).map(
        (problem) => problem.nodeId
      ),
      ["n-3"]
    );
    assert.deepStrictEqual(
      ledgerProblems(ledger, { "launch-wf-7": record("declined") }).map(
        (problem) => problem.problem
      ),
      ["briefId launch-wf-7 is declined, not accepted", "no briefId"]
    );
  });
});
