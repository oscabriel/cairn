// Identifiers that cross the wire, and the small shared value schemas every protocol module uses.
// Ids minted by pi-durable (entries, conversations, tasks, submissions) are its positive integers;
// ids minted by a client (threads, commands) are UUIDv7 strings, so a draft becomes a thread
// idempotently across reconnects.

import { Schema } from "effect";

/** A non-negative integer, as counts, offsets and sequences are. */
export const NonNegativeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
);

/** A positive integer, as pi-durable's ids are. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** A string with no surrounding whitespace and at least one character. */
export const TrimmedNonEmptyString = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1)
);

/** Text a person typed or will read: a title, a label, a summary. Bounded so a row stays small. */
export const DisplayText = Schema.String.check(Schema.isMaxLength(4096));

/** A server-minted opaque token: letters, digits, `_` and `-`, at most 128 characters. */
const OpaqueToken = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)
);

/** A UUIDv7 string, the form every client-minted id takes. */
const Uuid7 = Schema.String.check(Schema.isUUID(7));

/** A project (a folder or repo on the Beelink, or the hidden scratch project). Minted by the server. */
export const ProjectId = OpaqueToken.pipe(Schema.brand("ProjectId"));

export type ProjectId = typeof ProjectId.Type;

/** A thread. A UUIDv7 minted by the client, so launching a draft twice lands once. */
export const ThreadId = Uuid7.pipe(Schema.brand("ThreadId"));

export type ThreadId = typeof ThreadId.Type;

/** One shell or launch command, minted by the client; the server's receipt table dedupes it. */
export const CommandId = Uuid7.pipe(Schema.brand("CommandId"));

export type CommandId = typeof CommandId.Type;

/**
 * One turn input (send, steer, follow-up), minted by the client and handed to pi-durable as the
 * submission's `requestId`, so a resent input is admitted once.
 */
export const RequestId = OpaqueToken.pipe(Schema.brand("RequestId"));

export type RequestId = typeof RequestId.Type;

/** An uploaded attachment. Minted by the server when it signs the upload URL. */
export const AttachmentId = OpaqueToken.pipe(Schema.brand("AttachmentId"));

export type AttachmentId = typeof AttachmentId.Type;

/** A pi-durable transcript entry. Ids grow with commit order within one store. */
export const EntryId = PositiveInt.pipe(Schema.brand("EntryId"));

export type EntryId = typeof EntryId.Type;

/** A pi-durable conversation. A thread is one ownerless conversation; subagents are owned ones. */
export const ConversationId = PositiveInt.pipe(Schema.brand("ConversationId"));

export type ConversationId = typeof ConversationId.Type;

/** A pi-durable task (a run, a tool call, a generation). A parked task is retried by this id. */
export const TaskId = PositiveInt.pipe(Schema.brand("TaskId"));

export type TaskId = typeof TaskId.Type;

/** A pi-durable submission: one admitted input, queued or placed. Withdrawn by this id. */
export const SubmissionId = PositiveInt.pipe(Schema.brand("SubmissionId"));

export type SubmissionId = typeof SubmissionId.Type;

/** An approval record in the `cairn.approvals` document, answered by `thread.respond`. */
export const ApprovalId = OpaqueToken.pipe(Schema.brand("ApprovalId"));

export type ApprovalId = typeof ApprovalId.Type;

/** A run of the agent loop on a thread: the id of pi-durable's run task. */
export const RunId = PositiveInt.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;
