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

/**
 * How many children the whole brain may have working at once (subagents note, section 7),
 * proposed and unmeasured until the phase 2 fan-out judge sets it.
 */
export const MAX_LIVE_CHILDREN_PER_BRAIN = 32;

/** Days a brief waits for Go before it expires and the parent is told (ADR 0030). */
export const BRIEF_EXPIRY_DAYS = 7;

/**
 * The `details` a `subagent_spawn` tool call carries through `api.details` (subagents note,
 * section 9), so the transcript row links to the child without a lookup. Plain JSON.
 */
export const SubagentSpawnDetails = Schema.Struct({
  threadId: ThreadId,
});

export type SubagentSpawnDetails = typeof SubagentSpawnDetails.Type;

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

/**
 * Where a child stands in its parent's registry. The registry item is written by the start task at
 * Go, so a brief that is declined, revised or expires never reaches it; those ends live on the
 * brief's own record (`ApprovalStatus`).
 */
export const SubagentStatus = Schema.Literals([
  "working",
  "waiting",
  "settled",
]);

export type SubagentStatus = typeof SubagentStatus.Type;

/**
 * Where a child's `ask_parent` question stands, from the parent's side; `cancelled` once it ends
 * unanswered: the child's run that asked it was stopped (ADR 0029), or its record expired.
 */
export const SubagentQuestionState = Schema.Literals([
  "pending",
  "answered",
  "escalated",
  "cancelled",
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

/**
 * One delivered settlement, as the registry keeps it: the answer is an entry id, never its text.
 * `inputs` are the request ids (keys of the record's `inputs`) of every input the settled run
 * answered or ended, so a run that settled several inputs, a failed one included, settles once.
 */
export const SettlementMark = Schema.Struct({
  seq: PositiveInt,
  outcome: SettlementOutcome,
  answerEntry: Schema.NullOr(EntryId),
  reportedAt: EpochMillis,
  inputs: Schema.Array(Schema.String),
});

export type SettlementMark = typeof SettlementMark.Type;

/** Where a child run stands in its parent's registry: nudged for its typed result, or settled. */
export const RunMarkPhase = Schema.Literals(["nudge", "settled"]);

export type RunMarkPhase = typeof RunMarkPhase.Type;

/**
 * One child run, as its parent's registry keys it: `run` is the run's identity (its answer entry,
 * or for a run that ended unanswered its terminal entry), never a reason or a detail. A `nudge`
 * mark is written by the commit that sends a typed child its nudge and lists every input the
 * nudged run ended; a `settled` mark by the commit that settles a run, with every input (a nudge's
 * request id included) it ended. A reporter whose run or input a mark names settles nothing.
 * `seq` is the settlement's (for a nudge, the one its nudge's request id is derived from).
 */
export const RunMark = Schema.Struct({
  run: Schema.String,
  phase: RunMarkPhase,
  seq: PositiveInt,
  inputs: Schema.Array(Schema.String),
  quiet: Schema.Boolean,
});

export type RunMark = typeof RunMark.Type;

/**
 * One child in its parent's `cairn.subagents`, keyed by the spawn tool's approval id (stable
 * across reruns). `inputs` maps each input's request id to its reporter task, so a resent steer
 * lands once; `runs` marks each child run nudged or settled, so a run settles once whichever of
 * its reporters gets there first; `delivered` is the last settlement whose note and wake were
 * written.
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
  runs: Schema.Array(RunMark),
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
  /**
   * Attempts used up to and including the valid call: calls to `submit_result`, and a nudge sent
   * before any call.
   */
  attempts: PositiveInt,
});

export type ResultDocument = typeof ResultDocument.Type;
