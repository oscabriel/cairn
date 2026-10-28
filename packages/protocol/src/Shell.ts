// Ported from github.com/pingdotgg/t3code, packages/contracts/src/{orchestrationV2.ts (ThreadShell, ShellSnapshot,
// ShellStreamItem, SubscribeShellInput), orchestrationProject.ts (ProjectShell)}
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the inbox fields
// (settle, snooze, pin, order keys, visited), the run times and the stream item vocabulary. Changed:
// optional fields are Options (null on the wire), run state is Cairn's `activity` derived from
// pi-durable, one location (archived threads leave the stream), and items are tagged structs.
// Phase 2 adds the row's `lineage` (t3code's shape, orchestrationV2.ts 108 to 112), its children's
// tally, goal, spend and pending count, each decoding to a default from rows stored before it.
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

import { Effect, Option, Schema } from "effect";

import {
  ApprovalId,
  DisplayText,
  EntryId,
  NonNegativeInt,
  ProjectId,
  RunId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import { ModelRef, ThinkingLevel } from "./Models.ts";
import { RuntimeMode, RuntimeRequestKind } from "./Policy.ts";
import { SpendSummary } from "./Spend.ts";
import { NO_SUBAGENTS, SubagentTally, ThreadLineage } from "./Subagents.ts";

const OptionalTime = Schema.OptionFromNullOr(Schema.DateTimeUtc);

/** A project as the sidebar shows it. */
export const ProjectShell = Schema.Struct({
  id: ProjectId,
  title: DisplayText,
  /** A folder the user chose, or the hidden scratch project behind "no project". */
  kind: Schema.Literals(["folder", "scratch"]),
  /** The absolute path of the project's root on the Beelink. */
  workspaceRoot: TrimmedNonEmptyString,
  /** The `owner/name` of the GitHub repo the root belongs to, when it is one. */
  repository: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  /** The model new threads in this project start with; none uses the server default. */
  defaultModel: Schema.OptionFromNullOr(ModelRef),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});

export type ProjectShell = typeof ProjectShell.Type;

/** What a thread's agent loop is doing, derived from pi-durable's live state. */
export const ThreadActivity = Schema.Literals([
  "idle",
  "preparing",
  "running",
  "waiting",
  "parked",
  "failed",
]);

export type ThreadActivity = typeof ThreadActivity.Type;

/** How the last failed run failed, so the sidebar can say "usage limit" instead of an error. */
export const RunFailureClass = Schema.Literals([
  "usage_limit",
  "provider_error",
  "transport_error",
  "unknown",
]);

export type RunFailureClass = typeof RunFailureClass.Type;

/**
 * What a waiting thread waits for, beyond the user: a Claude slot, or (a child) its parent's answer
 * to a question it asked with `ask_parent`.
 */
export const WaitingFor = Schema.Literals(["claude_slot", "parent", "none"]);

export type WaitingFor = typeof WaitingFor.Type;

/**
 * A field phase 2 added to a row the shell store keeps as JSON: absent in a stored row, it decodes
 * to `fallback` (the encoded value), so rows written before it still read.
 */
const added = <S extends Schema.Top>(schema: S, fallback: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(fallback)));

/**
 * The oldest request on a thread that needs the user. `origin` names the descendant whose request
 * it is, for a child's escalated question mirrored in its parent (ADR 0027); none for the thread's
 * own.
 */
export const PendingRuntimeRequest = Schema.Struct({
  id: ApprovalId,
  kind: RuntimeRequestKind,
  createdAt: Schema.DateTimeUtc,
  origin: added(Schema.OptionFromNullOr(ThreadId), null),
});

export type PendingRuntimeRequest = typeof PendingRuntimeRequest.Type;

/** The newest committed message, for the sidebar's preview line. Never a streaming delta. */
export const LatestVisibleMessage = Schema.Struct({
  entryId: EntryId,
  role: Schema.Literals(["user", "assistant"]),
  text: DisplayText,
  at: Schema.DateTimeUtc,
});

export type LatestVisibleMessage = typeof LatestVisibleMessage.Type;

/** A thread's manual settle state, which wins over the automatic one until cleared. */
export const SettledOverride = Schema.Literals(["settled", "active"]);

export type SettledOverride = typeof SettledOverride.Type;

/** A goal thread's criteria, counted for its row. */
export const GoalTally = Schema.Struct({
  total: NonNegativeInt,
  met: NonNegativeInt,
  failed: NonNegativeInt,
});

export type GoalTally = typeof GoalTally.Type;

/**
 * One thread's sidebar row: its inbox state (owned by the shell store) plus a cache of its
 * pi-durable activity (recomputed by the shell projector, never replayed). Unseen completion is
 * `latestRunCompletedAt > lastVisitedAt`, computed by the client so every device agrees.
 */
export const ThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: DisplayText,
  provider: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  thinkingLevel: ThinkingLevel,
  runtimeMode: RuntimeMode,
  branch: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  worktreePath: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  activity: ThreadActivity,
  activeRunId: Schema.OptionFromNullOr(RunId),
  latestRunRequestedAt: OptionalTime,
  latestRunStartedAt: OptionalTime,
  latestRunCompletedAt: OptionalTime,
  /** Inputs admitted but not yet placed in the transcript. */
  queueLength: NonNegativeInt,
  lastError: Schema.OptionFromNullOr(DisplayText),
  lastErrorClass: Schema.OptionFromNullOr(RunFailureClass),
  usageLimitResetAt: OptionalTime,
  waitingFor: WaitingFor,
  pendingRuntimeRequest: Schema.OptionFromNullOr(PendingRuntimeRequest),
  latestVisibleMessage: Schema.OptionFromNullOr(LatestVisibleMessage),
  latestUserMessageAt: OptionalTime,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  archivedAt: OptionalTime,
  settledOverride: Schema.OptionFromNullOr(SettledOverride),
  settledAt: OptionalTime,
  unsettledAt: OptionalTime,
  snoozedUntil: OptionalTime,
  snoozedAt: OptionalTime,
  pinnedAt: OptionalTime,
  pinOrderKey: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  activeOrderKey: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  autoSettleDisabledAt: OptionalTime,
  lastVisitedAt: OptionalTime,
  /** Tasks pi-durable stopped retrying after repeated crashes; each can be retried. */
  parkedTaskIds: Schema.Array(TaskId),
  /** A subagent's place under its parent (ADR 0028); a row with one is hidden from the sidebar. */
  lineage: added(Schema.OptionFromNullOr(ThreadLineage), null),
  /** This thread's own children by what they are doing; zeros when it has none. */
  subagents: added(SubagentTally, NO_SUBAGENTS),
  /** A goal thread's criteria, counted (ADR 0026); none on a thread without criteria. */
  goal: added(Schema.OptionFromNullOr(GoalTally), null),
  /** What the thread and its lineage subtree spent (ADR 0036); none until it has used a model. */
  spend: added(Schema.OptionFromNullOr(SpendSummary), null),
  /** Requests waiting for the user on this thread, escalations included, for the push body. */
  pendingCount: added(NonNegativeInt, 0),
});

export type ThreadShell = typeof ThreadShell.Type;

/**
 * The phase 2 fields of a row with no lineage, no children, no criteria, no spend and no request
 * waiting: what a new top-level thread starts with.
 */
export const BARE_ROW_FIELDS = {
  lineage: Option.none(),
  subagents: NO_SUBAGENTS,
  goal: Option.none(),
  spend: Option.none(),
  pendingCount: 0,
} satisfies Pick<
  ThreadShell,
  "lineage" | "subagents" | "goal" | "spend" | "pendingCount"
>;

/** Every project and every non-archived thread, as of `snapshotSequence`. */
export const ShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(ProjectShell),
  threads: Schema.Array(ThreadShell),
});

export type ShellSnapshot = typeof ShellSnapshot.Type;

/** A full snapshot; it replaces whatever the client held. */
export const ShellSnapshotItem = Schema.TaggedStruct("Snapshot", {
  snapshot: ShellSnapshot,
});

/** The replay is done and the stream is live: the completion marker. */
export const ShellSynchronizedItem = Schema.TaggedStruct("Synchronized", {});

/** A project's current state, after the event at `sequence`. */
export const ProjectUpdatedItem = Schema.TaggedStruct("ProjectUpdated", {
  sequence: NonNegativeInt,
  project: ProjectShell,
});

/** A project was deleted at `sequence`. */
export const ProjectRemovedItem = Schema.TaggedStruct("ProjectRemoved", {
  sequence: NonNegativeInt,
  projectId: ProjectId,
});

/** A thread's current row, after the event at `sequence`. */
export const ThreadUpdatedItem = Schema.TaggedStruct("ThreadUpdated", {
  sequence: NonNegativeInt,
  thread: ThreadShell,
});

/** A thread left the shell at `sequence`: archived or deleted. */
export const ThreadRemovedItem = Schema.TaggedStruct("ThreadRemoved", {
  sequence: NonNegativeInt,
  threadId: ThreadId,
});

/**
 * One item of the shell stream. Updates carry whole rows, never diffs, so a client that applies
 * them in order after a snapshot holds exactly the server's state.
 */
export const ShellStreamItem = Schema.Union([
  ShellSnapshotItem,
  ShellSynchronizedItem,
  ProjectUpdatedItem,
  ProjectRemovedItem,
  ThreadUpdatedItem,
  ThreadRemovedItem,
]);

export type ShellStreamItem = typeof ShellStreamItem.Type;

/** A shell stream item that moves the cursor: everything but a snapshot or the marker. */
export type ShellDelta = Exclude<
  ShellStreamItem,
  { readonly _tag: "Snapshot" } | { readonly _tag: "Synchronized" }
>;

/** `shell.subscribe` input. */
export const SubscribeShellInput = Schema.Struct({
  /** Resume after this sequence; none starts with a snapshot. */
  afterSequence: Schema.OptionFromNullOr(NonNegativeInt),
  /** Send `Synchronized` once the snapshot or replay is done. */
  requestCompletionMarker: Schema.Boolean,
});

export type SubscribeShellInput = typeof SubscribeShellInput.Type;
