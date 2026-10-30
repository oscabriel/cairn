// Ported from github.com/pingdotgg/t3code, packages/contracts/src/providerPolicy.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the four runtime modes and their default,
// the approval decisions. Changed: request kinds are Cairn's (Executor calls and tool calls through
// pi-durable), and the Codex sandbox and approval-policy literals are gone. Phase 2 adds Cairn's
// own decision record (`cairn.approvals` version 2, ADR 0029), the brief (ADR 0026, 0030), the
// workflow envelope (ADR 0032), goals with judge-bound criteria, and the thread's permission
// document (ADR 0031); none of those come from t3code.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { Schema } from "effect";

import {
  ApprovalId,
  DisplayText,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import { ModelRef, ThinkingLevel } from "./Models.ts";
import { RoleOverrides, RoleSpec } from "./Roles.ts";
import { Budget } from "./Spend.ts";

/**
 * A thread's permission mode: which tool calls need an approval (ADR 0031). Full access asks for
 * none and is the default; auto-accept edits asks for `bash`, Executor calls and Cairn tools that
 * act; approval-required (Supervised) asks for everything but reads. `auto` is reserved for a
 * decider after phase 2 and is not offered. A child's mode is never wider than its parent's.
 */
export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export type RuntimeMode = typeof RuntimeMode.Type;

/** The permission mode a new thread starts in. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

/**
 * An answer to one approval. `accept_for_thread` also adds the tool to the thread's `allow` list;
 * `revise` (Send back) is for briefs only and needs a reason; `accept_sample` (Run on 1 first) is
 * for a workflow's launch approval only.
 */
export const ApprovalDecision = Schema.Literals([
  "accept",
  "accept_for_thread",
  "accept_sample",
  "decline",
  "revise",
]);

export type ApprovalDecision = typeof ApprovalDecision.Type;

/**
 * What a pending runtime request asks the user for. `brief` is a brief waiting for Go (a
 * subagent's, or a workflow's launch and its envelope); `criteria` is criteria a model proposed for
 * its goal, waiting for the user to bind them.
 */
export const RuntimeRequestKind = Schema.Literals([
  "executor-call",
  "tool-call",
  "user-input",
  "sign-in",
  "brief",
  "criteria",
]);

export type RuntimeRequestKind = typeof RuntimeRequestKind.Type;

/**
 * Where one approval record stands. A status leaves `pending` once and never returns. Only
 * `pending` holds a tool call; `cancelled` is written by a stop, `revised` by Send back on a brief.
 */
export const ApprovalStatus = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled",
  "revised",
]);

export type ApprovalStatus = typeof ApprovalStatus.Type;

/** Who a question goes to first (ADR 0027). Approvals and briefs always go to the user. */
export const ApprovalRoute = Schema.Literals(["user", "parent"]);

export type ApprovalRoute = typeof ApprovalRoute.Type;

/** Milliseconds since the epoch, as pi-durable documents store times. */
export const EpochMillis = NonNegativeInt;

/** A JSON object, as a JSON Schema or a typed payload is carried in a document. */
export const JsonObject = Schema.Record(Schema.String, Schema.Json);

export type JsonObject = typeof JsonObject.Type;

// Decision records are pi-durable documents the thread stream carries as plain JSON (see
// `Thread.ts`), so their optional fields are `null`, never Options: an op's path must mean the same
// thing on the server and in the client.

/**
 * Who decided a record (ADR 0029). Null on a record only while it is `pending`. `thread` is a
 * parent's model answering its child's question; `mode` is the permission mode accepting at ask
 * time; `envelope` is a workflow's launch approval covering a node's brief (ADR 0032); `judge` is
 * a judge run. `proxy` (a decider inside a goal's grant) arrives with hands-off goals after phase
 * 2, as an added member.
 */
export const Decider = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("mode"), mode: RuntimeMode }),
  Schema.Struct({ kind: Schema.Literal("envelope"), approvalId: ApprovalId }),
  Schema.Struct({
    kind: Schema.Literal("judge"),
    runId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("expiry") }),
  Schema.Struct({
    kind: Schema.Literal("system"),
    why: Schema.Literals(["run-stopped", "boot"]),
  }),
]);

export type Decider = typeof Decider.Type;

/** One option of a question. */
export const QuestionOption = Schema.Struct({
  label: DisplayText,
  description: Schema.NullOr(DisplayText),
  recommended: Schema.Boolean,
});

export type QuestionOption = typeof QuestionOption.Type;

/** One question `ask_user` (or a brief's decisions) puts to the user, in t3code's shape. */
export const Question = Schema.Struct({
  /** A short label for the card's step ("Database"). */
  header: DisplayText.check(Schema.isMaxLength(80)),
  question: DisplayText,
  options: Schema.Array(QuestionOption).check(Schema.isMaxLength(9)),
  multiSelect: Schema.Boolean,
  /** Whether "Something else" is offered. */
  allowCustomAnswer: Schema.Boolean,
});

export type Question = typeof Question.Type;

/** The answer to one question, by its index in the record's payload. */
export const QuestionAnswer = Schema.Struct({
  index: NonNegativeInt,
  /** Labels of the options picked. */
  picks: Schema.Array(DisplayText),
  custom: Schema.NullOr(DisplayText),
});

export type QuestionAnswer = typeof QuestionAnswer.Type;

/**
 * An outside judge that decides a criterion or a brief's `doneWhen` item. A `model` judge must be
 * of another family than the thread's; `verification` waits for phase 4.
 */
export const JudgeRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("command"),
    argv: Schema.NonEmptyArray(Schema.String),
    expectExit: NonNegativeInt,
    timeoutSec: PositiveInt.check(Schema.isLessThanOrEqualTo(3600)),
  }),
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("model"),
    spec: RoleSpec,
    rubric: DisplayText,
  }),
  Schema.Struct({
    kind: Schema.Literal("verification"),
    recipe: TrimmedNonEmptyString,
  }),
]);

export type JudgeRef = typeof JudgeRef.Type;

/** A judge run's recorded result. Only the verdict writer (`verdicts/Verdicts.ts`) makes one. */
export const Verdict = Schema.Struct({
  at: EpochMillis,
  ok: Schema.Boolean,
  judge: JudgeRef,
  evidence: Schema.Struct({
    exit: Schema.NullOr(Schema.Int),
    /** The last lines of a command's output. */
    tail: Schema.NullOr(Schema.String),
    sha: Schema.NullOr(TrimmedNonEmptyString),
    /** `provider/modelId` of a model judge. */
    model: Schema.NullOr(TrimmedNonEmptyString),
    note: Schema.NullOr(DisplayText),
  }),
  runId: TrimmedNonEmptyString,
});

export type Verdict = typeof Verdict.Type;

/** Where a criterion stands. `met` only by a verdict recorded after the criterion last changed. */
export const CriterionState = Schema.Literals(["open", "met", "failed"]);

export type CriterionState = typeof CriterionState.Type;

/** One stated, checkable condition of a goal, naming its judge. */
export const Criterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: DisplayText,
  judge: JudgeRef,
  state: CriterionState,
  verdict: Schema.NullOr(Verdict),
  tries: NonNegativeInt,
  changedAt: EpochMillis,
});

export type Criterion = typeof Criterion.Type;

/** A criterion as proposed, by the user or in a `criteria` approval, before any verdict. */
export const CriterionProposal = Schema.Struct({
  text: DisplayText,
  judge: JudgeRef,
});

export type CriterionProposal = typeof CriterionProposal.Type;

/** Where a child works: its own worktree (writing roles) or the parent's checkout (read-only). */
export const BriefWorkspace = Schema.Literals(["worktree", "shared"]);

export type BriefWorkspace = typeof BriefWorkspace.Type;

/** Whether finishing a child wakes its parent, or only leaves the note (ADR 0028). */
export const WakeMode = Schema.Literals(["answer", "quiet"]);

export type WakeMode = typeof WakeMode.Type;

/**
 * A brief (ADR 0026): what a subagent is to do, why, and how its result will be judged. Frozen in
 * the record at ask time; the child's first input is rendered from it at Go (ADR 0030).
 */
export const Brief = Schema.Struct({
  type: Schema.Literal("brief"),
  /** 5 to 10 words: the child's title and its steps label. */
  title: DisplayText.check(Schema.isMaxLength(80)),
  task: DisplayText,
  why: DisplayText,
  avoid: Schema.Array(DisplayText).check(Schema.isMaxLength(20)),
  /** How the result will be judged; at least one. */
  doneWhen: Schema.NonEmptyArray(CriterionProposal),
  workspace: BriefWorkspace,
  /** The base revision for a worktree; null is the parent's HEAD. */
  base: Schema.NullOr(TrimmedNonEmptyString),
  /** Project-relative write scope, never with `..`. */
  writes: Schema.Array(TrimmedNonEmptyString),
  /** A role alias or literal spec, resolved at dispatch (ADR 0035). */
  role: Schema.NullOr(RoleSpec),
  model: Schema.NullOr(ModelRef),
  thinking: Schema.NullOr(ThinkingLevel),
  /** Never wider than the parent's. */
  mode: RuntimeMode,
  /** Commit yes; push and merge never in phase 2. */
  mayCommit: Schema.Boolean,
  budget: Budget,
  /** The JSON Schema the child's result must satisfy (object root); null asks for text. */
  resultSchema: Schema.NullOr(JsonObject),
  wake: WakeMode,
  /** Numbered decisions with the proposer's picks, after Ultimate. */
  decisions: Schema.Array(Question).check(Schema.isMaxLength(9)),
  /**
   * A workflow node's own brief only: the launch's per-launch binding of the node's role (the
   * user's edits on Go, else the model's proposal; empty when the launch binds none), which the
   * brain resolves the role with at Go (ADR 0035). The card checks the role with it. Absent on a
   * subagent's brief and on node briefs written before it existed, which the card does not check.
   */
  roleOverrides: Schema.optionalKey(RoleOverrides),
});

export type Brief = typeof Brief.Type;

/** Where a workflow node runs: on the host, or (phase 3) on a stone. */
export const NodeArms = Schema.Literals(["host", "stone"]);

export type NodeArms = typeof NodeArms.Type;

/** One role an envelope lets nodes run as, and whether it may write. */
export const EnvelopeRole = Schema.Struct({
  spec: RoleSpec,
  readonly: Schema.Boolean,
  arms: NodeArms,
});

export type EnvelopeRole = typeof EnvelopeRole.Type;

/**
 * What a workflow's launch approval grants (ADR 0032): a node brief that fits it is accepted with
 * `decidedBy` envelope; one outside it raises its own brief card. A goal reserves the same shape
 * for hands-off grants later.
 */
export const Envelope = Schema.Struct({
  /** The script the grant is bound to; null for a goal's envelope. */
  scriptHash: Schema.NullOr(TrimmedNonEmptyString),
  maxNodes: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
  maxConcurrent: PositiveInt.check(Schema.isLessThanOrEqualTo(32)),
  roles: Schema.Array(EnvelopeRole),
  modes: Schema.Array(RuntimeMode),
  writes: Schema.Array(TrimmedNonEmptyString),
  budget: Budget,
});

export type Envelope = typeof Envelope.Type;

/** One call site of a workflow script, from the dry run, for the launch card. */
export const CallSite = Schema.Struct({
  spec: RoleSpec,
  label: DisplayText,
  phase: Schema.NullOr(DisplayText),
  schemaName: Schema.NullOr(TrimmedNonEmptyString),
  readonly: Schema.Boolean,
  arms: NodeArms,
  /** How many times at most; null when it depends on the data. */
  maxCount: Schema.NullOr(PositiveInt),
});

export type CallSite = typeof CallSite.Type;

/** A pre-launch estimate, labelled as one. A payload without one says "no estimate yet". */
export const WorkflowEstimate = Schema.Struct({
  nodes: NonNegativeInt,
  tokensLow: NonNegativeInt,
  tokensHigh: NonNegativeInt,
  listMicrosLow: Schema.NullOr(NonNegativeInt),
  listMicrosHigh: Schema.NullOr(NonNegativeInt),
  /** For example "from the last 9 `@reader` nodes". */
  basis: DisplayText,
});

export type WorkflowEstimate = typeof WorkflowEstimate.Type;

/** A phase of a workflow, declared in its `meta` or appearing at run time. */
export const WorkflowPhase = Schema.Struct({
  title: DisplayText.check(Schema.isMaxLength(120)),
  detail: Schema.NullOr(DisplayText),
});

export type WorkflowPhase = typeof WorkflowPhase.Type;

/** A workflow's launch approval payload (kind `brief`): the plan the user says Go to. */
export const WorkflowLaunch = Schema.Struct({
  type: Schema.Literal("workflow"),
  workflowId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: DisplayText,
  phases: Schema.Array(WorkflowPhase),
  scriptHash: TrimmedNonEmptyString,
  /** Where the source is kept (an entry or file), never the source inline. */
  scriptRef: TrimmedNonEmptyString,
  args: Schema.Json,
  callSites: Schema.Array(CallSite),
  /** The dry run's node count; `unbounded` when it reached a cap ("at least N"). */
  nodes: Schema.Struct({ count: NonNegativeInt, unbounded: Schema.Boolean }),
  estimate: Schema.NullOr(WorkflowEstimate),
  envelope: Envelope,
  /**
   * Role bindings the model proposes for this launch only (ADR 0035, "a per-launch override on a
   * workflow's approval"); empty uses the global table. The user's edits on the card travel in the
   * answer's `launch`, never in this frozen payload.
   */
  roleOverrides: RoleOverrides,
});

export type WorkflowLaunch = typeof WorkflowLaunch.Type;

/**
 * What the user changed on a workflow's launch card before Go: the budget and the per-launch role
 * overrides, each replacing the payload's whole. Carried in the answer, so the frozen payload stays
 * what the model proposed and the record still shows both. Only a launch approval takes one.
 */
export const LaunchEdits = Schema.Struct({
  budget: Budget,
  roleOverrides: RoleOverrides,
});

export type LaunchEdits = typeof LaunchEdits.Type;

/**
 * Where a question came from (ADR 0027): a tool call (`ask_user`, `ask_parent`), or a subagent's
 * final plain answer whose last line asked for a decision, which the relay turned into a question
 * to its parent instead of a result.
 */
export const QuestionSource = Schema.Literals(["tool", "answer"]);

export type QuestionSource = typeof QuestionSource.Type;

/** A question record's payload (`ask_user`, `ask_parent`, a relayed answer). */
export const QuestionsPayload = Schema.Struct({
  type: Schema.Literal("questions"),
  questions: Schema.NonEmptyArray(Question).check(Schema.isMaxLength(9)),
  /** Absent on records written before it existed, which all came from a tool. */
  source: Schema.optionalKey(QuestionSource),
});

export type QuestionsPayload = typeof QuestionsPayload.Type;

/** A `criteria` record's payload: criteria a model proposed for its goal. */
export const CriteriaPayload = Schema.Struct({
  type: Schema.Literal("criteria"),
  criteria: Schema.NonEmptyArray(CriterionProposal),
});

export type CriteriaPayload = typeof CriteriaPayload.Type;

/**
 * A raise asked for when a budget is reached (ADR 0036). Its record has kind `tool-call` and tool
 * `budget_raise`: a yes or no on a gated action, which the card tells apart by the payload's `type`.
 */
export const BudgetRaisePayload = Schema.Struct({
  type: Schema.Literal("budget-raise"),
  /** `thread`, `goal` or a workflow id: the scope whose budget is reached. */
  scope: TrimmedNonEmptyString,
  from: Budget,
  to: Budget,
});

export type BudgetRaisePayload = typeof BudgetRaisePayload.Type;

/**
 * The largest program a `program` record holds, in UTF-8 bytes: the thread stream's string limit
 * (`WIRE_STRING_LIMIT_BYTES` in `Thread.ts`, held equal by a test), so the card never shows a cut
 * program the user would approve unseen. A longer program is refused at ask time.
 */
export const PROGRAM_CODE_LIMIT_BYTES = 32_768;

/** The UTF-8 length of one code point; a lone surrogate counts as the 3-byte replacement it encodes to. */
const utf8Width = (point: number): number => {
  if (point < 0x80) {
    return 1;
  }

  if (point < 0x8_00) {
    return 2;
  }

  return point < 0x1_00_00 ? 3 : 4;
};

/** A string's length in UTF-8 bytes. */
const utf8Length = (text: string): number => {
  let bytes = 0;

  for (const char of text) {
    bytes += utf8Width(char.codePointAt(0) ?? 0);
  }

  return bytes;
};

/** An Executor program approved once, as the program, in Supervised mode (ADR 0031). */
export const ProgramPayload = Schema.Struct({
  type: Schema.Literal("program"),
  /** The code the user approves exactly, as the card shows it whole. */
  code: Schema.String.check(
    Schema.isMaxLength(PROGRAM_CODE_LIMIT_BYTES),
    Schema.makeFilter(
      (code: string) =>
        utf8Length(code) <= PROGRAM_CODE_LIMIT_BYTES ||
        `a program must fit the wire's ${PROGRAM_CODE_LIMIT_BYTES} bytes`,
      { identifier: "ProgramCodeBytes" }
    )
  ),
});

export type ProgramPayload = typeof ProgramPayload.Type;

/** A record's payload, frozen at ask time. A plain tool call keeps its `summary` and no payload. */
export const ApprovalPayload = Schema.Union([
  Brief,
  WorkflowLaunch,
  QuestionsPayload,
  CriteriaPayload,
  BudgetRaisePayload,
  ProgramPayload,
]);

export type ApprovalPayload = typeof ApprovalPayload.Type;

/**
 * What the decider answered. `launch` is set only on Go (`accept` or `accept_sample`) for a
 * workflow's launch approval when the user edited the card; null runs the payload as proposed.
 */
export const ApprovalAnswer = Schema.Struct({
  decision: ApprovalDecision,
  answers: Schema.NullOr(Schema.Array(QuestionAnswer)),
  note: Schema.NullOr(DisplayText),
  launch: Schema.NullOr(LaunchEdits),
});

export type ApprovalAnswer = typeof ApprovalAnswer.Type;

/** The document kind of a conversation's decision records. */
export const APPROVALS_DOCUMENT = "cairn.approvals";

/** The current version of `cairn.approvals`; version 1 records migrate with nulls. */
export const APPROVALS_VERSION = 2;

/**
 * One decision record in a conversation's `cairn.approvals` (version 2, ADR 0029): a gated tool
 * call, a question, a brief or proposed criteria, and who decided it and why. `payload` never
 * changes after the ask; `status` leaves `pending` once.
 */
export const ApprovalRecord = Schema.Struct({
  id: ApprovalId,
  /** The pi-durable tool task that asked, so a rerun finds its record; 0 for a mirror. */
  toolTaskId: NonNegativeInt,
  tool: TrimmedNonEmptyString,
  kind: RuntimeRequestKind,
  /** One line for the card. */
  summary: DisplayText,
  status: ApprovalStatus,
  askedAt: EpochMillis,
  expiresAt: EpochMillis,
  answeredAt: Schema.NullOr(EpochMillis),
  /** The effect sandwich: `started` is committed before the effect runs, `done` after it. */
  run: Schema.NullOr(Schema.Literals(["started", "done"])),
  /** Executor's own `apr_` request id, once Executor asked. */
  executorRequestId: Schema.NullOr(TrimmedNonEmptyString),
  payload: Schema.NullOr(ApprovalPayload),
  answer: Schema.NullOr(ApprovalAnswer),
  decidedBy: Schema.NullOr(Decider),
  /** The user's words on Decline or Send back, a parent's reason, or a rule's text. */
  reason: Schema.NullOr(DisplayText),
  /** Questions only; every other kind is `user`. */
  route: ApprovalRoute,
  escalatedAt: Schema.NullOr(EpochMillis),
  /** Briefs: the revision this one replaces. */
  supersedes: Schema.NullOr(ApprovalId),
  /** Briefs: set once, by the start task. */
  started: Schema.NullOr(Schema.Struct({ childThreadId: ThreadId })),
  /** Briefs: the hash of the rendered input the child received. */
  briefHash: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * In a parent's document: the child's escalated question this record mirrors. Both are written
   * in one commit, and an answer to either settles both once (ADR 0027).
   */
  mirrorOf: Schema.NullOr(
    Schema.Struct({ threadId: ThreadId, approvalId: ApprovalId })
  ),
});

export type ApprovalRecord = typeof ApprovalRecord.Type;

/** `cairn.approvals` document state: every record of one conversation, by id. */
export const ApprovalsDocument = Schema.Struct({
  items: Schema.Record(Schema.String, ApprovalRecord),
});

export type ApprovalsDocument = typeof ApprovalsDocument.Type;

/** The document kind of a thread's permission state (ADR 0031). */
export const PERMISSIONS_DOCUMENT = "cairn.permissions";

/** `cairn.permissions`: the mode gated tools read at call time, and tools allowed for the thread. */
export const PermissionsDocument = Schema.Struct({
  mode: RuntimeMode,
  /** Tool names "Allow for this thread" added; their wrappers skip the ask. */
  allow: Schema.Array(TrimmedNonEmptyString),
});

export type PermissionsDocument = typeof PermissionsDocument.Type;

/** The document kind of a goal thread's objective and criteria. */
export const GOAL_DOCUMENT = "cairn.goal";

/**
 * `cairn.goal` (version 1): a goal is a thread with criteria (ADR 0026), so "is a goal" is
 * `criteria.length > 0`. A criterion's `state` and `verdict` are written only by the verdict writer.
 */
export const GoalDocument = Schema.Struct({
  objective: DisplayText,
  criteria: Schema.Array(Criterion),
  /** Limits for briefs the goal may approve by rule; reserved for hands-off goals. */
  envelope: Schema.NullOr(Envelope),
  closedAt: Schema.NullOr(EpochMillis),
  closedBy: Schema.NullOr(Decider),
});

export type GoalDocument = typeof GoalDocument.Type;

/** `goal.setCriteria` input: the user binds a goal's criteria directly (`decidedBy` user). */
export const SetCriteriaInput = Schema.Struct({
  threadId: ThreadId,
  objective: Schema.OptionFromOptionalKey(DisplayText),
  criteria: Schema.Array(CriterionProposal).check(Schema.isMaxLength(32)),
});

export type SetCriteriaInput = typeof SetCriteriaInput.Type;

/**
 * `goal.mark` input: the user's own verdict on a criterion a `user` judge decides (`decidedBy`
 * user). The verdict writer records it; a criterion any other judge decides refuses it.
 */
export const MarkCriterionInput = Schema.Struct({
  threadId: ThreadId,
  criterionId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  /** Why, in the user's words; kept as the verdict's note. */
  note: Schema.OptionFromOptionalKey(DisplayText),
});

export type MarkCriterionInput = typeof MarkCriterionInput.Type;
