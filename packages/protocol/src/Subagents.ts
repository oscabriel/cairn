// Subagents (ADR 0028): a subagent is a thread with a hidden row and a `lineage`, owned by a
// background anchor of its parent, and its result reaches the parent as a note with a separate
// wake. These are the shapes the brain writes and the clients read: the lineage on the shell row,
// the settlement, the parent's `cairn.subagents` registry, the child's `cairn.child` document, the
// parent's `cairn.escalations` index, and the child's `cairn.result`. Documents are plain JSON (see
// `Thread.ts`); the shell row's fields are Options. Shapes from docs/phase-2/notes/subagents.md,
// sections 1 to 5 and 9, and models.md, section 2.

import { Schema } from "effect";

import {
  ApprovalId,
  ConversationId,
  DisplayText,
  EntryId,
  NonNegativeInt,
  PositiveInt,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import { ModelRef } from "./Models.ts";
import {
  ApprovalPayload,
  BriefWorkspace,
  EpochMillis,
  JsonObject,
  RuntimeMode,
  RuntimeRequestKind,
  WakeMode,
} from "./Policy.ts";
import { ResolvedRole, RoleSpec } from "./Roles.ts";

/** How deep subagents may nest under a thread the user opened (ADR 0028), fixed until measured. */
export const MAX_SUBAGENT_DEPTH = 2;

/** How many children one parent may have working at once (ADR 0028), fixed until measured. */
export const MAX_LIVE_CHILDREN = 8;

/** How a row relates to its parent. Only subagents in phase 2; stones arrive in phase 3. */
export const RelationshipToParent = Schema.Literals(["subagent"]);

export type RelationshipToParent = typeof RelationshipToParent.Type;

/**
 * A child thread's place in the tree, on its shell row (t3code's shape). A row with a lineage is
 * hidden from the sidebar, which resolves it to its nearest ancestor that has a row.
 */
export const ThreadLineage = Schema.Struct({
  parentThreadId: ThreadId,
  relationshipToParent: RelationshipToParent,
  rootThreadId: ThreadId,
});

export type ThreadLineage = typeof ThreadLineage.Type;

/** A parent row's count of its children, by what they are doing, derived by the projector. */
export const SubagentTally = Schema.Struct({
  working: NonNegativeInt,
  /** Waiting on a question (to the parent or the user) or an approval. */
  asking: NonNegativeInt,
  settled: NonNegativeInt,
  failed: NonNegativeInt,
});

export type SubagentTally = typeof SubagentTally.Type;

/** A tally with no children. */
export const NO_SUBAGENTS: SubagentTally = {
  working: 0,
  asking: 0,
  settled: 0,
  failed: 0,
};

/** Whether `thread.stop` on a parent also stops its working children. A parent's stop keeps them. */
export const SubagentStopPolicy = Schema.Literals(["keep", "stop"]);

export type SubagentStopPolicy = typeof SubagentStopPolicy.Type;

/** How one input to a child ended, in the run vocabulary. */
export const SettlementOutcome = Schema.Literals([
  "completed",
  "stopped",
  "failed",
]);

export type SettlementOutcome = typeof SettlementOutcome.Type;

/**
 * A child's result for one input, closed (ADR 0028). `seq` is 1 for the brief's run, then one per
 * later input that produced an answer. `error` is set exactly when the outcome is `failed`; a
 * `usageLimit` failure writes the note and wakes nobody.
 */
export const SubagentSettlement = Schema.Struct({
  subagent: ThreadId,
  seq: PositiveInt,
  outcome: SettlementOutcome,
  summary: DisplayText,
  /** "None", how the result differs from the brief, or "not reported". */
  divergence: DisplayText,
  /** Validated against the brief's result schema; null without one. */
  payload: Schema.Json,
  commit: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  turns: Schema.Struct({ thisRun: NonNegativeInt, total: NonNegativeInt }),
  error: Schema.NullOr(DisplayText),
  usageLimit: Schema.Boolean,
});

export type SubagentSettlement = typeof SubagentSettlement.Type;

/**
 * The entry kind of a settlement's note in the parent's transcript: a write carrying a model user
 * message, with the settlement as `data`. The client renders it as a subagent row.
 */
export const SUBAGENT_RESULT_ENTRY = "cairn.subagent-result";

/** Where a child stands in its parent's registry. */
export const SubagentStatus = Schema.Literals([
  "working",
  "waiting",
  "settled",
  "declined",
  "expired",
]);

export type SubagentStatus = typeof SubagentStatus.Type;

/** Where a child's `ask_parent` question stands, from the parent's side. */
export const SubagentQuestionState = Schema.Literals([
  "pending",
  "answered",
  "escalated",
]);

export type SubagentQuestionState = typeof SubagentQuestionState.Type;

/** A child's worktree, when its brief asked for one. */
export const ChildWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseSha: TrimmedNonEmptyString,
});

export type ChildWorktree = typeof ChildWorktree.Type;

/**
 * What the dispatch resolved (ADR 0035): the role the brief named, the model it ran on, and the
 * card's preview when the table moved while the brief waited.
 */
export const DispatchRecord = Schema.Struct({
  spec: Schema.NullOr(RoleSpec),
  resolved: ResolvedRole,
  /** The model the brief card showed, when it differs from `resolved`. */
  previewed: Schema.NullOr(ModelRef),
  dispatchedAt: EpochMillis,
});

export type DispatchRecord = typeof DispatchRecord.Type;

/** One delivered settlement, as the registry keeps it: the answer is an entry id, never its text. */
export const SettlementMark = Schema.Struct({
  seq: PositiveInt,
  outcome: SettlementOutcome,
  answerEntry: Schema.NullOr(EntryId),
  reportedAt: EpochMillis,
});

export type SettlementMark = typeof SettlementMark.Type;

/**
 * One child in its parent's `cairn.subagents`, keyed by the spawn tool's approval id (stable
 * across reruns). `inputs` maps each input's request id to its reporter task, so a resent steer
 * lands once; `delivered` is the last settlement whose note and wake were written.
 */
export const SubagentRecord = Schema.Struct({
  threadId: ThreadId,
  conversationId: ConversationId,
  anchorTaskId: TaskId,
  briefApprovalId: ApprovalId,
  description: DisplayText,
  dispatch: DispatchRecord,
  isolation: BriefWorkspace,
  worktree: Schema.NullOr(ChildWorktree),
  status: SubagentStatus,
  wake: WakeMode,
  settlements: Schema.Array(SettlementMark),
  delivered: NonNegativeInt,
  questions: Schema.Record(
    Schema.String,
    Schema.Struct({
      state: SubagentQuestionState,
      escalatedAt: Schema.NullOr(EpochMillis),
    })
  ),
  inputs: Schema.Record(Schema.String, TaskId),
});

export type SubagentRecord = typeof SubagentRecord.Type;

/** The document kind of a parent's registry of its children. */
export const SUBAGENTS_DOCUMENT = "cairn.subagents";

/** `cairn.subagents` on the parent: every child it spawned, by spawn key. */
export const SubagentsDocument = Schema.Struct({
  items: Schema.Record(Schema.String, SubagentRecord),
});

export type SubagentsDocument = typeof SubagentsDocument.Type;

/** A child's `report` call, first valid one wins. */
export const ChildReport = Schema.Struct({
  summary: DisplayText,
  divergence: DisplayText,
  payload: Schema.Json,
  commit: Schema.NullOr(TrimmedNonEmptyString),
});

export type ChildReport = typeof ChildReport.Type;

/** The document kind of a child's link to its parent. */
export const CHILD_DOCUMENT = "cairn.child";

/**
 * `cairn.child` on the child, written in the spawn commit: its tools find their parent here, so
 * `ask_parent` and `report` take no target and a child addresses only its parent.
 */
export const ChildDocument = Schema.Struct({
  key: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  parentConversationId: ConversationId,
  rootThreadId: ThreadId,
  depth: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_SUBAGENT_DEPTH)),
  briefApprovalId: ApprovalId,
  resultSchema: Schema.NullOr(JsonObject),
  attempts: NonNegativeInt,
  report: Schema.NullOr(ChildReport),
  permissionMode: RuntimeMode,
});

export type ChildDocument = typeof ChildDocument.Type;

/** Where an escalated question stands in the parent's index. */
export const EscalationStatus = Schema.Literals(["open", "resolved"]);

export type EscalationStatus = typeof EscalationStatus.Type;

/** One child question escalated to the user and shown in the parent thread. */
export const Escalation = Schema.Struct({
  childThreadId: ThreadId,
  kind: RuntimeRequestKind,
  payload: Schema.NullOr(ApprovalPayload),
  askedAt: EpochMillis,
  escalatedAt: EpochMillis,
  /** Why it reached the user: the parent escalated, its run ended, or the 15 minutes passed. */
  why: DisplayText,
  status: EscalationStatus,
});

export type Escalation = typeof Escalation.Type;

/** The document kind of a parent's index of escalated child questions. */
export const ESCALATIONS_DOCUMENT = "cairn.escalations";

/**
 * `cairn.escalations` on the parent, by the child's approval id, written in the escalation commit
 * beside the mirror record. A `thread.respond` on the parent resolves through an open entry here,
 * which is also its authorization check.
 */
export const EscalationsDocument = Schema.Struct({
  items: Schema.Record(Schema.String, Escalation),
});

export type EscalationsDocument = typeof EscalationsDocument.Type;

/** The document kind of a child's validated typed result. */
export const RESULT_DOCUMENT = "cairn.result";

/** `cairn.result` on the child: the value `submit_result` validated, read by the delegating tool. */
export const ResultDocument = Schema.Struct({
  result: Schema.Json,
  divergence: DisplayText,
  /** Calls to `submit_result` up to and including the valid one. */
  attempts: PositiveInt,
});

export type ResultDocument = typeof ResultDocument.Type;
