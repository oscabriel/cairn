// Workflows (ADR 0012 as amended, 0032, 0033): durable scripts whose nodes are subagents, with a
// dispatch ledger in the launching thread's `cairn.workflows` document, a launch approval that is
// an envelope (its payload is `WorkflowLaunch` in `Policy.ts`), per-node stop, and durable events
// with exactly-once reactors. Documents are plain JSON (see `Thread.ts`); RPC inputs use Options.
// Shapes from docs/phase-2/notes/workflows.md, "The dispatch ledger", "Durable events", "The steps
// panel's data" and "Protocol additions".

import { Schema } from "effect";

import {
  ApprovalId,
  ConversationId,
  DisplayText,
  EntryId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  SubmissionId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import {
  Decider,
  EpochMillis,
  NodeArms,
  WorkflowEstimate,
  WorkflowPhase,
} from "./Policy.ts";
import { RoleSpec } from "./Roles.ts";
import { Budget, Micros } from "./Spend.ts";

/** Nodes one workflow runs at once (a semaphore in the `agent` tool); the hard cap is 32. */
export const MAX_CONCURRENT_NODES = 8;

/** Nodes one workflow may dispatch in all. */
export const MAX_WORKFLOW_NODES = 1000;

/** Items one `pipeline` or `parallel` call takes; more is rejected, never truncated. */
export const MAX_ITEMS_PER_CALL = 4096;

/** Where a workflow stands. */
export const WorkflowState = Schema.Literals([
  "proposed",
  "approved",
  "running",
  "finished",
  "failed",
  "stopped",
  "declined",
]);

export type WorkflowState = typeof WorkflowState.Type;

/** Why a workflow ended partial. */
export const WorkflowPartialReason = Schema.Literals([
  "budget_spent",
  "stopped",
  "script_error",
  "replay_diverged",
]);

export type WorkflowPartialReason = typeof WorkflowPartialReason.Type;

/** How an ended workflow turned out. */
export const WorkflowOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("complete") }),
  Schema.Struct({
    kind: Schema.Literal("partial"),
    reason: WorkflowPartialReason,
  }),
]);

export type WorkflowOutcome = typeof WorkflowOutcome.Type;

/** Where one dispatch stands. Agent nodes never reach `start_unknown`. */
export const NodeState = Schema.Literals([
  "reserved",
  "running",
  "held",
  "settled",
  "failed",
  "stopped",
  "refused",
  "start_unknown",
  "stop_unknown",
]);

export type NodeState = typeof NodeState.Type;

/** How far a dispatch got, so a rerun resumes from its step. */
export const NodeStage = Schema.Literals([
  "reserved",
  "child_created",
  "submitted",
  "answered",
  "validated",
  "verified",
]);

export type NodeStage = typeof NodeStage.Type;

/** Why a node was refused before it started; the script sees `null`. */
export const NodeRefusal = Schema.Literals([
  "budget_spent",
  "outside_grant",
  "node_cap",
  "no_provider",
]);

export type NodeRefusal = typeof NodeRefusal.Type;

/** What a settled node used, summed over its conversation subtree from `pi.usage`. */
export const NodeReceipt = Schema.Struct({
  answerEntry: Schema.NullOr(EntryId),
  input: NonNegativeInt,
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  totalTokens: NonNegativeInt,
  /** Null when the model is unpriced (ADR 0036). */
  listMicros: Schema.NullOr(NonNegativeInt),
  toolCalls: NonNegativeInt,
  durationMs: NonNegativeInt,
});

export type NodeReceipt = typeof NodeReceipt.Type;

/**
 * One dispatch in the ledger. `id` is `n-<node tool task id>`, stable across reruns; `requestId`
 * (`wf-<workflowId>-<id>`) is the idempotency key and the submission's request id, written with
 * `-` where the notes write `:` because every brain-minted request id matches the protocol's
 * `RequestId` (`[A-Za-z0-9_-]{1,128}`, see `docs/phase-2/waves.md`); `briefId` names the accepted
 * approval that let it start, the workflow's own launch approval for a node inside the envelope
 * (ADR 0032).
 */
export const NodeRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  workflowId: TrimmedNonEmptyString,
  /** The script's stable label, for `resume`. */
  key: Schema.NullOr(TrimmedNonEmptyString),
  label: DisplayText,
  phase: Schema.NullOr(DisplayText),
  index: NonNegativeInt,
  requestId: TrimmedNonEmptyString,
  briefId: Schema.NullOr(ApprovalId),
  /** The spec the script passed and what it resolved to at dispatch (ADR 0035). */
  role: Schema.NullOr(RoleSpec),
  provider: Schema.NullOr(TrimmedNonEmptyString),
  modelId: Schema.NullOr(TrimmedNonEmptyString),
  effort: Schema.NullOr(TrimmedNonEmptyString),
  readonly: Schema.Boolean,
  arms: NodeArms,
  state: NodeState,
  stage: NodeStage,
  childThreadId: Schema.NullOr(ThreadId),
  conversationId: Schema.NullOr(ConversationId),
  submissionId: Schema.NullOr(SubmissionId),
  nestedTaskId: Schema.NullOr(TaskId),
  attempt: PositiveInt,
  schemaAttempts: NonNegativeInt,
  receipt: Schema.NullOr(NodeReceipt),
  /** The typed value, or a reference to it when over the small cap. */
  result: Schema.Json,
  /** A one-line summary of the result for the steps panel. */
  resultSummary: Schema.NullOr(DisplayText),
  refusal: Schema.NullOr(NodeRefusal),
  /** A node held by a spent plan window, and when the window resets. */
  held: Schema.NullOr(Schema.Struct({ until: Schema.NullOr(EpochMillis) })),
  startedAt: Schema.NullOr(EpochMillis),
  endedAt: Schema.NullOr(EpochMillis),
  error: Schema.NullOr(DisplayText),
});

export type NodeRecord = typeof NodeRecord.Type;

/** A workflow run's meter: what its nodes spent so far, plain JSON. */
export const WorkflowSpent = Schema.Struct({
  tokens: NonNegativeInt,
  listMicros: Micros,
  unpricedTokens: NonNegativeInt,
});

export type WorkflowSpent = typeof WorkflowSpent.Type;

/** A meter at zero, for a workflow that has not dispatched. */
export const NOTHING_SPENT: WorkflowSpent = {
  tokens: 0,
  listMicros: Micros.make(0),
  unpricedTokens: 0,
};

/**
 * One workflow in the ledger, `id` =`wf-<workflow_plan tool task id>`. Phases are the declared
 * ones followed by any that appear at run time, append-only.
 */
export const WorkflowRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: DisplayText,
  phases: Schema.Array(WorkflowPhase),
  scriptHash: TrimmedNonEmptyString,
  /** The entry or file holding the source, never the source inline. */
  scriptRef: TrimmedNonEmptyString,
  /** The launch arguments, frozen; cut by the wire's string limit. */
  args: Schema.Json,
  state: WorkflowState,
  outcome: Schema.NullOr(WorkflowOutcome),
  approvalId: ApprovalId,
  decidedBy: Schema.NullOr(Decider),
  decidedAt: Schema.NullOr(EpochMillis),
  /** Run on 1 first: `pipeline` takes this many items; null runs on all. */
  sample: Schema.NullOr(PositiveInt),
  budget: Budget,
  estimate: Schema.NullOr(WorkflowEstimate),
  codemodeTaskId: Schema.NullOr(TaskId),
  startedAt: Schema.NullOr(EpochMillis),
  endedAt: Schema.NullOr(EpochMillis),
  /** A reference to the script's return value. */
  result: Schema.NullOr(TrimmedNonEmptyString),
  nodes: Schema.Record(Schema.String, NodeRecord),
  /**
   * `log(msg)` lines keyed by the `tools.log` nested task id (decimal), so a rerun after a kill
   * between the task's commit and its result writes the same key again instead of a second line.
   * Shown in key order, which is call order.
   */
  log: Schema.Record(
    Schema.String,
    Schema.Struct({ at: EpochMillis, text: DisplayText })
  ),
  /**
   * The run's meter, recomputed by the budget reactor (5B) from its nodes' `pi.usage` and carried
   * to clients by the thread stream. `listMicros` sums priced nodes only; `unpricedTokens` is what
   * it leaves out (ADR 0036).
   */
  spent: WorkflowSpent,
  /** When the meter first crossed the budget's `warnAt`; set once, in the commit that emits `workflow.budget.soft`. */
  softAt: Schema.NullOr(EpochMillis),
  /** When the meter first reached the budget; set once, in the commit that emits `workflow.budget.spent`. */
  spentAt: Schema.NullOr(EpochMillis),
});

export type WorkflowRecord = typeof WorkflowRecord.Type;

/** The document kind of a thread's dispatch ledger. */
export const WORKFLOWS_DOCUMENT = "cairn.workflows";

/** `cairn.workflows` on the launching thread: every workflow it launched, by id. */
export const WorkflowsDocument = Schema.Struct({
  items: Schema.Record(Schema.String, WorkflowRecord),
});

export type WorkflowsDocument = typeof WorkflowsDocument.Type;

/** `workflow.stop` input: stop a whole workflow; settled results stay. */
export const WorkflowStopInput = Schema.Struct({
  threadId: ThreadId,
  workflowId: TrimmedNonEmptyString,
});

export type WorkflowStopInput = typeof WorkflowStopInput.Type;

/** `workflow.stopNode` input: stop one node; the script sees `null` for it. */
export const WorkflowStopNodeInput = Schema.Struct({
  threadId: ThreadId,
  workflowId: TrimmedNonEmptyString,
  nodeId: TrimmedNonEmptyString,
});

export type WorkflowStopNodeInput = typeof WorkflowStopNodeInput.Type;

/** `workflow.list` input: the saved recipes, built-in and the project's. */
export const WorkflowListInput = Schema.Struct({
  projectId: Schema.OptionFromNullOr(ProjectId),
});

export type WorkflowListInput = typeof WorkflowListInput.Type;

/** A saved recipe a thread can launch by name (the council, ...). */
export const RecipeSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: DisplayText,
  whenToUse: Schema.OptionFromNullOr(DisplayText),
  source: Schema.Literals(["built-in", "project"]),
  phases: Schema.Array(
    Schema.Struct({
      title: DisplayText,
      detail: Schema.OptionFromNullOr(DisplayText),
    })
  ),
});

export type RecipeSummary = typeof RecipeSummary.Type;

/** `workflow.list` result. */
export const RecipeList = Schema.Struct({
  recipes: Schema.Array(RecipeSummary),
});

export type RecipeList = typeof RecipeList.Type;

/** The durable events phase 2 emits (ADR 0033), each in the commit of the change it describes. */
export const EventName = Schema.Literals([
  "approval.answered",
  "brief.approved",
  "workflow.proposed",
  "workflow.started",
  "workflow.finished",
  "workflow.node.settled",
  "workflow.node.refused",
  "workflow.node.stopped",
  "workflow.budget.soft",
  "workflow.budget.spent",
  "subagent.result",
]);

export type EventName = typeof EventName.Type;

/** The data of one event entry (`event.<name>`), versioned like a document. */
export const EventEnvelope = Schema.Struct({
  v: PositiveInt,
  at: EpochMillis,
  data: Schema.Json,
  context: Schema.NullOr(Schema.Json),
});

export type EventEnvelope = typeof EventEnvelope.Type;

/** The document kind of the event log's cursor state (session scope). */
export const EVENTS_DOCUMENT = "cairn.events";

/** Where one reactor has read to: a log conversation and the last entry it handled there. */
export const ReactorCursor = Schema.Struct({
  logConversationId: ConversationId,
  entryId: Schema.NullOr(EntryId),
});

export type ReactorCursor = typeof ReactorCursor.Type;

/** `cairn.events`: the current log (rotated monthly) and each reactor's cursor. */
export const EventsDocument = Schema.Struct({
  logConversationId: Schema.NullOr(ConversationId),
  /** The month the current log covers, `YYYY-MM`. */
  logMonth: Schema.NullOr(TrimmedNonEmptyString),
  cursors: Schema.Record(Schema.String, ReactorCursor),
});

export type EventsDocument = typeof EventsDocument.Type;

/** One reactor's health, for the settings page (`workflow.eventStatus`). */
export const ReactorStatus = Schema.Struct({
  reactor: TrimmedNonEmptyString,
  /** Events after its cursor not yet handled. */
  lag: NonNegativeInt,
  lastHandledAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  lastFailure: Schema.OptionFromNullOr(
    Schema.Struct({ at: Schema.DateTimeUtc, message: DisplayText })
  ),
  failuresInARow: NonNegativeInt,
});

export type ReactorStatus = typeof ReactorStatus.Type;

/** `workflow.eventStatus` result. */
export const EventStatus = Schema.Struct({
  reactors: Schema.Array(ReactorStatus),
});

export type EventStatus = typeof EventStatus.Type;
