// The thread stream and turn inputs. The view is pi-durable's `ConversationView` as the brain
// projects it for the wire (ThreadWire): only client-visible documents, image data replaced by
// references, long strings truncated. Chord ops address that JSON tree by path, so the view keeps
// its plain JSON shape on both sides (no Option decoding inside it): an op's path must mean the same
// thing on the server and in the client.
//
// Partly ported from cairn-v1, packages/protocol/src/view.ts at 1a5cd4a (the op and view schemas),
// rewritten for Cairn's standards; the truncation marker and limits follow t3code's
// apps/server/src/orchestration-v2/WireProjection.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
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

import { MAX_ATTACHMENTS_PER_TURN } from "./Attachments.ts";
import {
  ApprovalId,
  AttachmentId,
  ConversationId,
  EntryId,
  NonNegativeInt,
  PositiveInt,
  RequestId,
  SubmissionId,
  TaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import { ModelRef, ThinkingLevel } from "./Models.ts";
import { ApprovalDecision } from "./Policy.ts";

/** The largest string the projection sends; longer ones are cut and marked. */
export const WIRE_STRING_LIMIT_BYTES = 32_768;

/** What a cut string ends with. The object holding it also gets `truncated: true`. */
export const TRUNCATION_MARKER = "\n… output truncated for transport";

/** The largest entry `thread.entry` returns in full. */
export const FULL_ENTRY_LIMIT_BYTES = 256 * 1024;

/** pi-durable documents a client may see. Others (`pi.provider`, `pi.system`) stay in the brain. */
export const VISIBLE_DOCUMENTS: ReadonlyArray<string> = [
  "pi.agent",
  "pi.live",
  "pi.inbox",
  "pi.usage",
  "cairn.approvals",
];

const Segment = Schema.Union([Schema.String, Schema.Int]);

const Path = Schema.Array(Segment);

const NonEmptyPath = Schema.NonEmptyArray(Segment);

/**
 * One chord delta op, decoded (paths inline, no interning): `r` replaces the root, `s` sets, `d`
 * deletes, `a` appends text, `t` truncates text, `p` splices an array, `m` permutes one. A
 * `__proto__` segment is valid JSON here, so apply ops only with a path-checking applier.
 */
export const Op = Schema.Union([
  Schema.Tuple([Schema.Literal("r"), Schema.Json]),
  Schema.Tuple([Schema.Literal("s"), NonEmptyPath, Schema.Json]),
  Schema.Tuple([Schema.Literal("d"), NonEmptyPath]),
  Schema.Tuple([Schema.Literal("a"), NonEmptyPath, Schema.String]),
  Schema.Tuple([Schema.Literal("t"), NonEmptyPath, NonNegativeInt]),
  Schema.Tuple([
    Schema.Literal("p"),
    Path,
    NonNegativeInt,
    NonNegativeInt,
    Schema.Array(Schema.Json),
  ]),
  Schema.Tuple([Schema.Literal("m"), Path, Schema.Array(NonNegativeInt)]),
]);

export type Op = typeof Op.Type;

/** An image in a projected entry: the bytes stay in the brain and are fetched by reference. */
export const ProjectedImage = Schema.Struct({
  type: Schema.Literal("image"),
  mimeType: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
  /** Where to fetch it: an attachment the user uploaded, or an image inside a tool result. */
  ref: Schema.Union([
    Schema.TaggedStruct("Attachment", { attachmentId: AttachmentId }),
    Schema.TaggedStruct("EntryImage", {
      entryId: EntryId,
      index: NonNegativeInt,
    }),
  ]),
});

export type ProjectedImage = typeof ProjectedImage.Type;

/**
 * One transcript entry as pi-durable records it. `model` holds pi-ai messages and `data` the
 * entry kind's payload; both are JSON the brain owns. Absent keys are absent, not null, because
 * ops address this tree as pi-durable shapes it.
 */
export const Entry = Schema.Struct({
  id: EntryId,
  conversationId: ConversationId,
  kind: Schema.String,
  model: Schema.optionalKey(Schema.Array(Schema.Json)),
  data: Schema.optionalKey(Schema.Json),
  head: Schema.optionalKey(EntryId),
  edits: Schema.optionalKey(Schema.Array(Schema.Json)),
  byTaskId: Schema.optionalKey(TaskId),
});

export type Entry = typeof Entry.Type;

/**
 * The kind of a notice entry: display-only text the brain writes into a thread's transcript about
 * something that happened outside a run. It has no `model`, so the model never sees it.
 */
export const NOTICE_ENTRY_KIND = "cairn.notice";

/** The `data` of a `cairn.notice` entry. */
export const NoticeEntryData = Schema.Struct({
  /** What the notice reports: a launch that failed after its conversation existed. */
  reason: Schema.Literals(["launch_failed"]),
  /** The text to show, as the thread row's `lastError` has it. */
  text: Schema.String,
});

export type NoticeEntryData = typeof NoticeEntryData.Type;

/** A conversation record: its fork source and its owner, when it has them. */
export const ConversationRecord = Schema.Struct({
  id: ConversationId,
  parent: Schema.optionalKey(
    Schema.Struct({ conversationId: ConversationId, at: EntryId })
  ),
  owner: Schema.optionalKey(
    Schema.Struct({ conversationId: ConversationId, taskId: TaskId })
  ),
});

export type ConversationRecord = typeof ConversationRecord.Type;

/** The projected view of one conversation: its active entries and its visible documents. */
export const ConversationView = Schema.Struct({
  conversation: ConversationRecord,
  entries: Schema.Array(Entry),
  docs: Schema.Record(Schema.String, Schema.Json),
});

export type ConversationView = typeof ConversationView.Type;

/**
 * A fresh view. Sent first on every subscription and legal at any later point, whenever the
 * brain cannot express a change as ops.
 */
export const ThreadSnapshotItem = Schema.TaggedStruct("Snapshot", {
  /** Per subscription, for tests and diagnostics; it starts at 0. */
  seq: NonNegativeInt,
  view: ConversationView,
  /** How many older active entries the view leaves out; `thread.history` pages them in. */
  entriesOffset: NonNegativeInt,
  hasMoreHistory: Schema.Boolean,
});

/** Ops that turn the previous view into the next one. Entry indices count from `entriesOffset`. */
export const ThreadOpsItem = Schema.TaggedStruct("Ops", {
  seq: NonNegativeInt,
  ops: Schema.Array(Op),
});

/** One item of the thread stream. */
export const ThreadStreamItem = Schema.Union([
  ThreadSnapshotItem,
  ThreadOpsItem,
]);

export type ThreadStreamItem = typeof ThreadStreamItem.Type;

/** `thread.subscribe` input. */
export const SubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** A conversation inside the thread (a subagent); none is the thread itself. */
  conversationId: Schema.OptionFromNullOr(ConversationId),
});

export type SubscribeThreadInput = typeof SubscribeThreadInput.Type;

/** `thread.history` input: up to `limit` active entries before `before`, oldest first. */
export const HistoryInput = Schema.Struct({
  threadId: ThreadId,
  conversationId: Schema.OptionFromNullOr(ConversationId),
  before: EntryId,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)),
});

export type HistoryInput = typeof HistoryInput.Type;

/** `thread.history` result. Entries are projected exactly as the stream projects them. */
export const HistoryPage = Schema.Struct({
  entries: Schema.Array(Entry),
  hasMore: Schema.Boolean,
});

export type HistoryPage = typeof HistoryPage.Type;

/** `thread.entry` input. */
export const EntryInput = Schema.Struct({
  threadId: ThreadId,
  entryId: EntryId,
});

export type EntryInput = typeof EntryInput.Type;

/** `thread.entry` result: one entry without string truncation, up to `FULL_ENTRY_LIMIT_BYTES`. */
export const FullEntry = Schema.Struct({
  entry: Entry,
  /** True when even the full entry was over the limit and was cut. */
  truncated: Schema.Boolean,
});

export type FullEntry = typeof FullEntry.Type;

/** What to do with an input that arrives while a run is busy. */
export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);

export type WhenBusy = typeof WhenBusy.Type;

/**
 * One turn of user input. The client mints `requestId`; pi-durable admits a resent input once.
 * `skillRefs` are skill names typed as `$name` or `/skill:name`, expanded by the brain.
 */
export const TurnInput = Schema.Struct({
  requestId: RequestId,
  text: Schema.String.check(Schema.isMaxLength(120_000)),
  attachments: Schema.Array(AttachmentId).check(
    Schema.isMaxLength(MAX_ATTACHMENTS_PER_TURN)
  ),
  skillRefs: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
});

export type TurnInput = typeof TurnInput.Type;

/** `thread.send` input. */
export const SendInput = Schema.Struct({
  threadId: ThreadId,
  input: TurnInput,
  whenBusy: WhenBusy,
});

export type SendInput = typeof SendInput.Type;

/** `thread.send` result: the admitted submission, which `thread.withdraw` can take back while queued. */
export const SendResult = Schema.Struct({
  submissionId: SubmissionId,
});

export type SendResult = typeof SendResult.Type;

/** `thread.stop` input. Stopping keeps queued inputs unless `clearQueue` is set. */
export const StopInput = Schema.Struct({
  threadId: ThreadId,
  clearQueue: Schema.Boolean,
});

export type StopInput = typeof StopInput.Type;

/** `thread.withdraw` input: take back one queued input. */
export const WithdrawInput = Schema.Struct({
  threadId: ThreadId,
  submissionId: SubmissionId,
});

export type WithdrawInput = typeof WithdrawInput.Type;

/** `thread.withdraw` result: false when the input had already reached the transcript. */
export const WithdrawResult = Schema.Struct({
  withdrawn: Schema.Boolean,
});

export type WithdrawResult = typeof WithdrawResult.Type;

/** `thread.configure` input; an absent key leaves that setting as it is. */
export const ConfigureInput = Schema.Struct({
  threadId: ThreadId,
  model: Schema.OptionFromOptionalKey(ModelRef),
  thinkingLevel: Schema.OptionFromOptionalKey(ThinkingLevel),
});

export type ConfigureInput = typeof ConfigureInput.Type;

/** `thread.respond` input: an answer to one approval. */
export const RespondInput = Schema.Struct({
  threadId: ThreadId,
  approvalId: ApprovalId,
  decision: ApprovalDecision,
});

export type RespondInput = typeof RespondInput.Type;

/** `thread.retryTask` input: run a parked task again. */
export const RetryTaskInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TaskId,
});

export type RetryTaskInput = typeof RetryTaskInput.Type;
