// The dispatch ledger (ADR 0012 as amended, ADR 0032, workflows note W3): one `cairn.workflows`
// document on the thread whose model launched the script, `{ items: { [workflowId]: WorkflowRecord } }`
// as plain JSON (S23). Its shapes are the protocol's `WorkflowsDocument` (packages/protocol/src/
// Workflows.ts); the kind is protocol and never changes, and a fork starts with no workflows.
//
// The document is written only by the node tools (`WorkflowTools.ts`), their watcher task and
// whoever proposes and answers a launch (5A), always through `tx`; the thread stream carries it, so
// the steps panel needs no second channel. These are the pure rules the writers share: ids, the
// row a dispatch reserves, whether a node fits the launch's envelope, what a settled node cost, and
// the ledger check every judge runs (no row without a brief that names an accepted approval).
//
// The shapes follow MonoCode's dispatch ledger (github.com/hardbeat920/MonoCode,
// src/features/orchestration/model/orchestrationState.ts at 26465c62): a row is written before the
// effect, keyed so a resent dispatch finds its first row, and only the row's own task may settle it.
// Ideas only; the code is Cairn's.
//
// MIT License. Copyright (c) 2026 hardbeat920 (MonoCode).
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software. THE
// SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { Envelope, NodeArms } from "@cairn/protocol/Policy";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import type {
  NodeRefusal,
  NodeStage,
  NodeState,
  WorkflowOutcome,
  WorkflowState,
} from "@cairn/protocol/Workflows";
import type { JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { UsageState } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

import type { ApprovalRecord, JsonRecord } from "../brain/CairnDocs.ts";

/** What a settled node used: the protocol's `NodeReceipt` as plain JSON. */
export interface NodeReceiptState {
  [key: string]: JsonValue;
  answerEntry: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  listMicros: number | null;
  toolCalls: number;
  durationMs: number;
}

/** One dispatch: the protocol's `NodeRecord` as plain JSON. */
export interface NodeItemState {
  [key: string]: JsonValue;
  id: string;
  workflowId: string;
  key: string | null;
  label: string;
  phase: string | null;
  index: number;
  requestId: string;
  briefId: string | null;
  role: string | null;
  provider: string | null;
  modelId: string | null;
  effort: string | null;
  readonly: boolean;
  arms: NodeArms;
  state: NodeState;
  stage: NodeStage;
  childThreadId: string | null;
  conversationId: number | null;
  submissionId: number | null;
  nestedTaskId: number | null;
  attempt: number;
  schemaAttempts: number;
  receipt: NodeReceiptState | null;
  result: JsonValue;
  resultSummary: string | null;
  refusal: NodeRefusal | null;
  held: { [key: string]: JsonValue; until: number | null } | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

/** A launch's budget: the protocol's `Budget` as plain JSON. */
export interface BudgetState {
  [key: string]: JsonValue;
  maxListMicros: number | null;
  maxTokens: number | null;
  maxTurns: number | null;
  maxMinutes: number | null;
  planGuard: JsonRecord | null;
  warnAt: number;
}

/** One workflow: the protocol's `WorkflowRecord` as plain JSON. */
export interface WorkflowItemState {
  [key: string]: JsonValue;
  id: string;
  name: string;
  description: string;
  phases: Array<{
    [key: string]: JsonValue;
    title: string;
    detail: string | null;
  }>;
  scriptHash: string;
  scriptRef: string;
  args: JsonValue;
  state: WorkflowState;
  outcome: WorkflowOutcome | null;
  approvalId: string;
  decidedBy: JsonRecord | null;
  decidedAt: number | null;
  sample: number | null;
  budget: BudgetState;
  estimate: JsonRecord | null;
  codemodeTaskId: number | null;
  startedAt: number | null;
  endedAt: number | null;
  result: string | null;
  nodes: { [nodeId: string]: NodeItemState };
  log: {
    [taskId: string]: { [key: string]: JsonValue; at: number; text: string };
  };
  spent: {
    [key: string]: JsonValue;
    tokens: number;
    listMicros: number;
    unpricedTokens: number;
  };
  softAt: number | null;
  spentAt: number | null;
}

/** `cairn.workflows` state. */
export interface WorkflowsState {
  [key: string]: JsonValue;
  items: { [workflowId: string]: WorkflowItemState };
}

/** `cairn.workflows`: every workflow a thread launched, by id (the dispatch ledger). */
export const WorkflowsDoc = defineDoc<WorkflowsState>({
  kind: WORKFLOWS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, which launched nothing.
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

// Ids. Every id the ledger mints matches the protocol's `RequestId` (`[A-Za-z0-9_-]{1,128}`).

/** A workflow's id: `wf-<workflow_plan tool task id>`. */
export const workflowIdOf = (taskId: number) => `wf-${String(taskId)}`;

/** A node's id: `n-<node tool task id>`, stable across reruns of that task. */
export const nodeIdOf = (taskId: number) => `n-${String(taskId)}`;

/** A node's idempotency key and its child's submission request id: `wf-<workflowId>-<nodeId>`. */
export const nodeRequestIdOf = (workflowId: string, nodeId: string) =>
  `wf-${workflowId}-${nodeId}`;

/** The request id of the one nudge a typed node's child may get (2E's rule). */
export const nudgeRequestIdOf = (requestId: string) => `${requestId}-nudge`;

/** Where a workflow's script call keeps its result: the code mode call's own task. */
export const resultRefOf = (codemodeTaskId: number) =>
  `task-${String(codemodeTaskId)}`;

/** Node states a node never leaves. */
const ENDED: ReadonlySet<NodeState> = new Set<NodeState>([
  "settled",
  "failed",
  "stopped",
  "refused",
]);

/** True when `state` is one a node never leaves. */
export const isNodeEnded = (state: NodeState) => ENDED.has(state);

/** Workflow states that hold nothing any more. */
const WORKFLOW_ENDED: ReadonlySet<WorkflowState> = new Set<WorkflowState>([
  "finished",
  "failed",
  "stopped",
  "declined",
]);

/** True when a workflow will run no more nodes. */
export const isWorkflowEnded = (state: WorkflowState) =>
  WORKFLOW_ENDED.has(state);

// Proposing and approving: 5A's answer path calls these; tests and judges plant launches with them.

/** What a proposed row is made from: the launch approval's id and its frozen payload. */
export interface ProposeInput {
  readonly launch: WorkflowLaunch;
  readonly approvalId: string;
  /** Run on N first; none runs on all. */
  readonly sample: Option.Option<number>;
}

/** A `proposed` row for `launch`, nothing dispatched and nothing spent. */
export const proposedRecord = (input: ProposeInput): WorkflowItemState => {
  const { launch } = input;

  return {
    id: launch.workflowId,
    name: launch.name,
    description: launch.description,
    phases: launch.phases.map((phase) => ({
      title: phase.title,
      detail: phase.detail,
    })),
    scriptHash: launch.scriptHash,
    scriptRef: launch.scriptRef,
    args: copyJson(launch.args),
    state: "proposed",
    outcome: null,
    approvalId: input.approvalId,
    decidedBy: null,
    decidedAt: null,
    sample: Option.getOrNull(input.sample),
    budget: {
      maxListMicros: launch.envelope.budget.maxListMicros,
      maxTokens: launch.envelope.budget.maxTokens,
      maxTurns: launch.envelope.budget.maxTurns,
      maxMinutes: launch.envelope.budget.maxMinutes,
      planGuard:
        launch.envelope.budget.planGuard === null
          ? null
          : { ...launch.envelope.budget.planGuard },
      warnAt: launch.envelope.budget.warnAt,
    },
    estimate: launch.estimate === null ? null : { ...launch.estimate },
    codemodeTaskId: null,
    startedAt: null,
    endedAt: null,
    result: null,
    nodes: {},
    log: {},
    spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
    softAt: null,
    spentAt: null,
  };
};

/**
 * Moves a `proposed` row to `approved` with who decided and when, in the commit that accepts its
 * launch approval. False when the row is not `proposed` (answered already, or gone).
 */
export const approveRecord = (
  record: WorkflowItemState,
  decidedBy: JsonRecord,
  at: number
): boolean => {
  if (record.state !== "proposed") {
    return false;
  }

  record.state = "approved";
  record.decidedBy = decidedBy;
  record.decidedAt = at;

  return true;
};

// The envelope (ADR 0032): what a launch's Go granted, read from the accepted record's payload.

const decodeLaunch = Schema.decodeUnknownOption(WorkflowLaunch);

/** The launch a record's frozen payload holds; none when it holds another kind. */
export const launchOf = (
  record: ApprovalRecord
): Option.Option<WorkflowLaunch> =>
  record.payload === null ? Option.none() : decodeLaunch(record.payload);

/** The envelope a launch approval's payload grants; none when the record carries no launch. */
export const envelopeOf = (record: ApprovalRecord): Option.Option<Envelope> =>
  Option.map(launchOf(record), (launch) => launch.envelope);

/** Why a node does not fit its workflow's envelope, or none when it fits. */
export const outsideEnvelope = (
  envelope: Envelope,
  node: { readonly role: string; readonly readonly: boolean }
): Option.Option<NodeRefusal> => {
  // A role granted as a writer covers a reader of the same role; a reader grant covers no writer.
  const granted = envelope.roles.some(
    (role) =>
      role.spec === node.role &&
      role.arms === "host" &&
      (!role.readonly || node.readonly)
  );

  return granted ? Option.none() : Option.some("outside_grant");
};

/** Nodes of a workflow that count against its node cap: every row but a refused one. */
export const dispatchedCount = (record: WorkflowItemState): number =>
  Object.values(record.nodes).filter((node) => node.state !== "refused").length;

/** The next node's index: rows in the order the script reached them. */
export const nextIndex = (record: WorkflowItemState): number =>
  Object.keys(record.nodes).length;

// Spend.

/** What one conversation's `pi.usage` adds up to over its model buckets. */
export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  /** pi-ai's own cost total; zero for a model with no price (the bridge). */
  readonly costTotal: number;
}

/** Tokens and list cost one conversation's `pi.usage` records, over its model buckets. */
export const usageTotals = (
  usage: Readonly<UsageState> | undefined
): UsageTotals => {
  const sum = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
  };

  for (const bucket of Object.values(usage?.models ?? {})) {
    sum.input += bucket.input;
    sum.output += bucket.output;
    sum.cacheRead += bucket.cacheRead;
    sum.cacheWrite += bucket.cacheWrite;
    sum.totalTokens += bucket.totalTokens;
    sum.costTotal += bucket.cost.total;
  }

  return sum;
};

/** Tokens a workflow's settled nodes used, from their receipts. */
export const settledTokens = (record: WorkflowItemState): number =>
  Object.values(record.nodes).reduce(
    (sum, node) => sum + (node.receipt?.totalTokens ?? 0),
    0
  );

// The ledger check every judge runs.

/** One way a ledger breaks ADR 0026's rule. */
export interface LedgerProblem {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly problem: string;
}

/**
 * Every dispatched row (every state but `refused`) must name a brief, and that brief must be an
 * `accepted` approval in the launching conversation's records. Refused rows started nothing.
 */
export const ledgerProblems = (
  workflows: Readonly<WorkflowsState>,
  approvals: Readonly<Record<string, ApprovalRecord>>
): ReadonlyArray<LedgerProblem> =>
  Object.values(workflows.items).flatMap((workflow) =>
    Object.values(workflow.nodes).flatMap((node): Array<LedgerProblem> => {
      if (node.state === "refused") {
        return [];
      }

      if (node.briefId === null) {
        return [
          { workflowId: workflow.id, nodeId: node.id, problem: "no briefId" },
        ];
      }

      const brief = approvals[node.briefId];

      return brief?.status === "accepted"
        ? []
        : [
            {
              workflowId: workflow.id,
              nodeId: node.id,
              problem: `briefId ${node.briefId} is ${brief?.status ?? "missing"}, not accepted`,
            },
          ];
    })
  );
