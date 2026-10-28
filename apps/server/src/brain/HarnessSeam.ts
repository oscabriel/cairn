// The harness seam: what the rest of the server may ask of the agent loop, keyed by thread, because
// one pi-durable store holds every thread (ADR 0016). Two implementations sit behind it: the real
// one over pi-durable (PiDurableHarness) and an independent in-memory one that plays scripted
// transcripts (ScriptedHarness). The replay conformance suite in `conformance/` judges both against
// the same hand-written expectations (ADR 0024).
//
// The shape follows t3code's ProviderAdapterV2 (github.com/pingdotgg/t3code,
// packages/provider-core/src/server/ProviderAdapter.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92)
// reduced to what a durable in-process loop needs. Its event vocabulary is not ported: the thread
// stream is pi-durable's own view, projected for the wire by ThreadWire.

import type { ProjectId, SubmissionId } from "@cairn/protocol/Ids";
import {
  ApprovalId,
  ConversationId,
  EntryId,
  NonNegativeInt,
  RunId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import type { ApprovalDecision, QuestionAnswer } from "@cairn/protocol/Policy";
import { RuntimeRequestKind, ApprovalStatus } from "@cairn/protocol/Policy";
import { RunFailureClass } from "@cairn/protocol/Shell";
import type {
  FullEntry,
  HistoryPage,
  ThreadStreamItem,
  WhenBusy,
  WithdrawResult,
} from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Effect, Option, Stream } from "effect";
import { Context, Schema } from "effect";

/** Why a seam call failed. Callers translate each reason to the protocol error it means. */
export const HarnessErrorReason = Schema.Literals([
  /** No thread with this id was ever ensured in this store. */
  "thread_not_found",
  /** A run is busy and the input asked to be rejected rather than queued. */
  "thread_busy",
  "submission_not_found",
  "approval_not_found",
  "task_not_found",
  "entry_not_found",
  /** The request named something the thread cannot do now, such as a cwd change while it runs. */
  "invalid_input",
  /** The harness is opening, closing or reopening after a storage failure. */
  "unavailable",
  /** pi-durable rejected the call for a reason Cairn does not classify. */
  "internal",
]);

export type HarnessErrorReason = typeof HarnessErrorReason.Type;

/** A seam call failed. `retryable` is true only when nothing was committed. */
export class HarnessError extends Schema.TaggedError<HarnessError>()(
  "HarnessError",
  {
    message: Schema.String,
    reason: HarnessErrorReason,
    retryable: Schema.Boolean,
    threadId: Schema.OptionFromNullOr(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** What `ensureThread` creates: the thread's conversation with its first agent settings. */
export interface EnsureThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel;
  /** The directory the thread's tools run in: the project root or a worktree made beforehand. */
  readonly cwd: string;
  /** Text rendered after every extension section; none leaves pi-durable's default. */
  readonly instructions: Option.Option<string>;
}

/** The conversation a thread lives in. `created` is false when the thread already existed. */
export interface ThreadHandle {
  readonly threadId: ThreadId;
  readonly conversationId: ConversationId;
  readonly created: boolean;
}

/** A change to a thread's agent; a none leaves that setting as it is. */
export interface ThreadAgentChange {
  readonly model: Option.Option<ModelRef>;
  readonly thinkingLevel: Option.Option<ThinkingLevel>;
  /** Accepted only while the thread is idle, so a rerun after a crash builds its env where it ran. */
  readonly cwd: Option.Option<string>;
}

/** The kind and data a user input is recorded as, instead of a bare `pi.user` entry. */
export interface InputEntry {
  readonly kind: string;
  readonly data: JsonValue;
}

/** A passive entry: it never starts a run, and is written once per `requestId`. */
export interface PassiveEntry extends InputEntry {
  readonly requestId: string;
}

/** One turn of input as the model sees it, after Cairn's turn-content stages ran. */
export interface HarnessTurnInput {
  /** Minted by the client; the same id on the same thread is admitted once, also across restarts. */
  readonly requestId: string;
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly entry: Option.Option<InputEntry>;
  readonly whenBusy: WhenBusy;
}

/** The admitted submission, as pi-durable recorded it. */
export interface SubmissionRef {
  readonly submissionId: SubmissionId;
  readonly status: "queued" | "placed" | "done" | "unanswered";
}

/** `stop` options: keep queued inputs (the default stop) or withdraw them too. */
export interface StopOptions {
  readonly clearQueue: boolean;
}

/** `history` query: up to `limit` entries before `before`, returned oldest first. */
export interface HistoryQuery {
  readonly before: EntryId;
  readonly limit: number;
}

/** The bytes of one image inside an entry, for the entry image route. */
export interface EntryImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** One frame of the thread stream: a fresh projected snapshot, then ops against it. */
export type ThreadFrame = ThreadStreamItem;

/** The user's answer to one approval, as `thread.respond` carries it (ADR 0029). */
export interface ApprovalAnswerInput {
  readonly decision: ApprovalDecision;
  /** The user's words: on Decline they reach the model with the tool's result. */
  readonly reason: Option.Option<string>;
  /** A question record's answers; any other kind refuses them. */
  readonly answers: Option.Option<ReadonlyArray<QuestionAnswer>>;
}

/** A thread whose run, queue, approval or task needs attention at boot. */
export interface LiveThreadState {
  readonly threadId: ThreadId;
  readonly conversationId: ConversationId;
  readonly runId: Option.Option<RunId>;
  readonly queueLength: number;
  readonly parkedTaskIds: ReadonlyArray<TaskId>;
  readonly pendingApprovals: ReadonlyArray<ApprovalId>;
}

/** What an implementation can do, so judges skip what a backend does not model. */
export interface HarnessCapabilities {
  /** State survives a restart of the implementation. */
  readonly durable: boolean;
  /** Real models and tools run; false for scripted transcripts. */
  readonly live: boolean;
}

/** How a failed run failed, from the provider's error text (see RunFailure). */
export const RunFailureInfo = Schema.Struct({
  class: RunFailureClass,
  retryable: Schema.Boolean,
  resetAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
});

export type RunFailureInfo = typeof RunFailureInfo.Type;

/** A thread's conversation exists (first ensured, or seen again after a boot). */
export const ThreadEnsured = Schema.TaggedStruct("ThreadEnsured", {
  threadId: ThreadId,
  conversationId: ConversationId,
});

/** A run took a thread's inputs. */
export const RunStarted = Schema.TaggedStruct("RunStarted", {
  threadId: ThreadId,
  runId: RunId,
  at: Schema.DateTimeUtc,
});

/**
 * A run ended. The only completion signal: the shell projector, checkpoints and push key on it.
 * `interrupted` covers a stop; `failed` carries the classified failure.
 */
export const RunTerminal = Schema.TaggedStruct("RunTerminal", {
  threadId: ThreadId,
  runId: RunId,
  status: Schema.Literals(["completed", "interrupted", "failed"]),
  failure: Schema.OptionFromNullOr(RunFailureInfo),
  at: Schema.DateTimeUtc,
});

/** A user or assistant message entered the transcript. Never a streaming delta. */
export const MessageCommitted = Schema.TaggedStruct("MessageCommitted", {
  threadId: ThreadId,
  entryId: EntryId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  at: Schema.DateTimeUtc,
});

/** The number of inputs queued behind the run changed. */
export const QueueChanged = Schema.TaggedStruct("QueueChanged", {
  threadId: ThreadId,
  length: NonNegativeInt,
});

/** An approval record was asked for or answered. */
export const RuntimeRequestUpdated = Schema.TaggedStruct(
  "RuntimeRequestUpdated",
  {
    threadId: ThreadId,
    id: ApprovalId,
    kind: RuntimeRequestKind,
    status: ApprovalStatus,
  }
);

/** The thread's spend changed. */
export const UsageUpdated = Schema.TaggedStruct("UsageUpdated", {
  threadId: ThreadId,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});

/** The crash-loop guard parked a task; `retry` runs it again. */
export const TaskParked = Schema.TaggedStruct("TaskParked", {
  threadId: ThreadId,
  taskId: TaskId,
});

/** A compaction began summarizing the thread. */
export const CompactionStarted = Schema.TaggedStruct("CompactionStarted", {
  threadId: ThreadId,
  taskId: TaskId,
});

/** A compaction ended, with a summary or without one. */
export const CompactionEnded = Schema.TaggedStruct("CompactionEnded", {
  threadId: ThreadId,
  taskId: TaskId,
  failed: Schema.Boolean,
});

/** Every committed change the rest of the server reacts to, across all threads. */
export const HarnessEvent = Schema.Union([
  ThreadEnsured,
  RunStarted,
  RunTerminal,
  MessageCommitted,
  QueueChanged,
  RuntimeRequestUpdated,
  UsageUpdated,
  TaskParked,
  CompactionStarted,
  CompactionEnded,
]);

export type HarnessEvent = typeof HarnessEvent.Type;

/** The agent loop, keyed by thread. */
export class HarnessSeam extends Context.Service<
  HarnessSeam,
  {
    /** Creates the thread's conversation once; a second call (or a raced one) returns the same one. */
    ensureThread(
      input: EnsureThread
    ): Effect.Effect<ThreadHandle, HarnessError>;
    /** Changes the thread's model, thinking level or cwd; a cwd change fails while it runs. */
    configure(
      threadId: ThreadId,
      change: ThreadAgentChange
    ): Effect.Effect<void, HarnessError>;
    /** Admits one input, idempotent by `requestId`; `whenBusy: reject` fails with `thread_busy`. */
    submit(
      threadId: ThreadId,
      input: HarnessTurnInput
    ): Effect.Effect<SubmissionRef, HarnessError>;
    /** Stops the run; queued inputs stay unless `clearQueue`. */
    stop(
      threadId: ThreadId,
      options: StopOptions
    ): Effect.Effect<void, HarnessError>;
    /** Takes back one queued input; false when it already reached the transcript. */
    withdraw(
      threadId: ThreadId,
      submissionId: SubmissionId
    ): Effect.Effect<WithdrawResult, HarnessError>;
    /**
     * Answers one approval as the user (`decidedBy` user), with the user's reason and answers; an
     * answered one stays as it was.
     */
    respond(
      threadId: ThreadId,
      approvalId: ApprovalId,
      answer: ApprovalAnswerInput
    ): Effect.Effect<void, HarnessError>;
    /** Appends a passive entry that never starts a run, idempotent by `requestId`. */
    write(
      threadId: ThreadId,
      entry: PassiveEntry
    ): Effect.Effect<void, HarnessError>;
    /** Summarizes the thread's older context now. */
    compact(
      threadId: ThreadId,
      instructions: Option.Option<string>
    ): Effect.Effect<void, HarnessError>;
    /**
     * A fresh projected snapshot, then ops; a snapshot may come again at any time. A thread that was
     * never ensured fails `thread_not_found` at once; to subscribe before a launch's ensure lands,
     * wait on `whenEnsured` first.
     */
    watch(threadId: ThreadId): Stream.Stream<ThreadFrame, HarnessError>;
    /**
     * Waits until the thread's conversation exists: at once for an ensured thread, otherwise when an
     * `ensureThread` for it commits. It never fails `thread_not_found` and has no deadline of its
     * own, so the caller bounds the wait and decides when "not yet" means "never". It listens
     * before it looks, so an ensure that lands while it starts is not missed.
     */
    whenEnsured(threadId: ThreadId): Effect.Effect<void, HarnessError>;
    /** Older entries, projected as the stream projects them. */
    history(
      threadId: ThreadId,
      query: HistoryQuery
    ): Effect.Effect<HistoryPage, HarnessError>;
    /** One entry without string truncation, up to the full-entry limit. */
    entry(
      threadId: ThreadId,
      entryId: EntryId
    ): Effect.Effect<FullEntry, HarnessError>;
    /** The bytes of the `index`th image of an entry. */
    entryImage(
      threadId: ThreadId,
      entryId: EntryId,
      index: number
    ): Effect.Effect<EntryImage, HarnessError>;
    /** Committed changes of every thread, in commit order. Each subscriber sees changes after it joined. */
    readonly events: Stream.Stream<HarnessEvent>;
    /** Every thread with a run, a queue, an approval or a parked task: the boot reconcile reads it. */
    readonly inspect: Effect.Effect<
      ReadonlyArray<LiveThreadState>,
      HarnessError
    >;
    /** Runs a task the crash-loop guard parked again. */
    retry(taskId: TaskId): Effect.Effect<void, HarnessError>;
    readonly capabilities: HarnessCapabilities;
  }
>()("cairn/server/brain/HarnessSeam") {}
