// The harness seam over pi-durable: every thread is an ownerless conversation in the brain's one
// store (ADR 0016), found through its `cairn.thread` receipt.
//
// - ensureThread: receipt, `createConversation`, `configure` and `cairn.thread-meta` in one
//   commit that reads no table first, so concurrent calls for one thread land once.
// - stop keeps the queue (`abortTask` on the run task); `clearQueue` aborts the conversation, which
//   also withdraws queued inputs (plan D16). A run that handed over to its next generation between
//   the read and the abort (a tool round ended) is followed to the successor, a few times at most.
// - Notes: a note written during a run waits in `pi.inbox` for its boundary. pi-durable's abort and
//   a failed run keep queued writes there, so the stop, every RunTerminal that did not complete and
//   the next note on an idle thread place them first, keeping notes in the order they were written
//   (ADR 0028). Queued inputs stay queued, and nothing here starts a run.
// - watch: a fresh projected snapshot, then ops; after a reopen of the Session the stream carries
//   on with a new snapshot of the new Session, because a snapshot is legal at any point. The
//   conversation watch is asked for a window (`STREAM_WINDOW`) that starts with as many entries as
//   the thread window can hold and never slides, so appends stay appends for the subscription's
//   life (pi-durable 1.5 otherwise drops the oldest 50 past 100 entries).
// - whenEnsured: subscribes to this process's ensures, then reads the receipt, so an ensure that
//   lands in between is not missed. Only `ensureThread` writes receipts, and only in this process.
// - events: the commit feed.
//
// The submit, watch and abort wrappers follow cairn-v1, apps/server/src/Harnesses.ts at 1a5cd4a.

import { Buffer } from "node:buffer";

import { isWiderThan } from "@cairn/client-logic/EffectiveMode";
import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
  SubmissionId,
  ThreadId,
} from "@cairn/protocol/Ids";
import {
  FULL_ENTRY_LIMIT_BYTES,
  ThreadOpsItem,
  ThreadSnapshotItem,
} from "@cairn/protocol/Thread";
import type {
  AgentChange,
  Conversation,
  ConversationDocToken,
  ConversationId as PiConversationId,
  ConversationView as PiConversationView,
  ConversationWindow,
  Cursor,
  InputSubmissionDraft,
  JsonObject,
  LiveState,
  TaskId as PiTaskId,
  WatchCall,
} from "@earendil-works/pi-durable";
import {
  ConversationBusy,
  configure,
  InboxDoc,
  LiveDoc,
} from "@earendil-works/pi-durable";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { BriefFaults } from "../subagents/BriefFaults.ts";
import { holdWakes } from "../subagents/Delivery.ts";
import {
  ChildDoc,
  EscalationsDoc,
  SubagentsDoc,
} from "../subagents/SubagentDocs.ts";
import { answerBrief, steerReporter } from "../subagents/Subagents.ts";
import { GoalDoc } from "../verdicts/GoalDocs.ts";
import { criteriaAnswered } from "../verdicts/Verdicts.ts";
import { WorkflowsDoc } from "../workflows/WorkflowDocs.ts";
import { launchAnswered } from "../workflows/WorkflowLaunch.ts";
import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession, BrainUnavailable } from "./Brain.ts";
import { BrainStore } from "./BrainStore.ts";
import {
  answerApproval,
  Approvals,
  Permissions,
  cancelStoppedApprovals,
  refusalText,
  relayedQuestion,
  ThreadMeta,
  ThreadReceipt,
  writeMode,
} from "./CairnDocs.ts";
import type { AnsweredHook, ApprovalRecord } from "./CairnDocs.ts";
import { CommitFeed, documentValue, RUN_TASK } from "./CommitFeed.ts";
import { documentCall, durable, handOff } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import { HarnessError, HarnessSeam } from "./HarnessSeam.ts";
import type {
  ApprovalAnswerInput,
  EnsureThread,
  HarnessTurnInput,
  HistoryQuery,
  LiveThreadState,
  PassiveEntry,
  PassiveNote,
  StopOptions,
  ThreadAgentChange,
  ThreadFrame,
} from "./HarnessSeam.ts";
import { admitNote, placeQueuedWrites } from "./NoteAdmission.ts";
import { PendingApprovals } from "./PendingApprovals.ts";
import { parentCeiling } from "./Permissions.ts";
import { piConversationId, piEntryId, piSubmissionId } from "./PiIds.ts";
import { SubagentCrashes, SubagentFaults } from "./SubagentFaults.ts";
import {
  WINDOW_POLICY,
  WindowFrame,
  windowedProjector,
} from "./ThreadWindow.ts";
import type { WindowedView } from "./ThreadWindow.ts";
import {
  entryImages,
  isStreamDocument,
  projectDocument,
  projectEntry,
} from "./ThreadWire.ts";
import type { ThreadWireError } from "./ThreadWire.ts";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** What `PendingApprovals` keeps between calls. */
interface PendingIndex {
  /** The conversations holding a pending record, once the scan ran. */
  known: Option.Option<Set<PiConversationId>>;
  /** The Session the scan read. */
  session: Option.Option<BrainSession>;
  /** Changes committed while no scan is known, which win over what the scan read. */
  readonly during: Map<PiConversationId, boolean>;
}

/** Whether a `cairn.approvals` value, as a commit published it, holds a pending record. */
const holdsPending = (value: JsonObject | null): boolean => {
  const items = value?.items;

  return (
    Predicate.isObject(items) &&
    !Array.isArray(items) &&
    Object.values(items).some(
      (item) =>
        Predicate.isObject(item) &&
        !Array.isArray(item) &&
        item.status === "pending"
    )
  );
};

type Writable<A> = { -readonly [K in keyof A]: A[K] };

/**
 * The `cairn.*` documents the thread stream carries beside pi-durable's own view documents: every
 * `cairn.*` kind of `VISIBLE_DOCUMENTS` that a token exists for. A package that defines another
 * visible document adds its token here, and the stream watches it with no other edit.
 */
export const STREAM_DOCUMENTS: ReadonlyArray<ConversationDocToken<JsonObject>> =
  [
    Approvals,
    Permissions,
    SubagentsDoc,
    ChildDoc,
    EscalationsDoc,
    WorkflowsDoc,
    GoalDoc,
  ];

const encoder = new TextEncoder();

const failure = (
  reason: HarnessError["reason"],
  threadId: Option.Option<ThreadId>,
  message: string
) =>
  new HarnessError({
    message,
    reason,
    retryable: reason === "unavailable",
    threadId,
  });

/** Translates a failed pi-durable call: a closing Harness is "unavailable", busy is "thread_busy". */
const fromDurable =
  (threadId: Option.Option<ThreadId>) =>
  (error: DurableCallError): HarnessError => {
    if (error.cause instanceof ConversationBusy) {
      return failure(
        "thread_busy",
        threadId,
        "The thread is running and the input asked not to queue. Send it again when the run ends, or let it queue."
      );
    }

    if (error.closed) {
      return failure(
        "unavailable",
        threadId,
        "The brain is restarting. Nothing new was committed; send again in a moment."
      );
    }

    return new HarnessError({
      message: error.message,
      reason: "internal",
      retryable: false,
      threadId,
      cause: error.cause,
    });
  };

const fromUnavailable =
  (threadId: Option.Option<ThreadId>) => (error: BrainUnavailable) =>
    failure("unavailable", threadId, error.message);

const fromWire =
  (threadId: Option.Option<ThreadId>) => (error: ThreadWireError) =>
    failure("internal", threadId, error.message);

/**
 * How many generations a stop follows when the run hands over between its read and its abort. A
 * handover takes a tool round or a continuation, so more than one in a stop's few milliseconds is
 * already unlikely.
 */
const STOP_HANDOVERS = 4;

/**
 * How long a stop waits for the run's tasks to end before it cancels their records. The wait only
 * orders RunTerminal before the cancellations (which records a run held is read from task owners,
 * not from their ends); an aborted run ends within a tool's abort handling, and a tool that ignores
 * aborts is not waited out.
 */
const STOP_SETTLE = Duration.seconds(2);

/** How many conversations one page of `inspect`'s scan for pending records reads. */
const INSPECT_SCAN_PAGE = 200;

/** `pi.live.run`: the task that owns a busy conversation's run, and the run's inputs. */
type LiveRun = NonNullable<LiveState["run"]>;

/**
 * Whether `next` is `run` handed over to a later generation: a handover moves the run's inputs
 * along (and may add steers), while a run started for queued inputs holds only those.
 */
const isHandover = (run: LiveRun, next: LiveRun) =>
  next.taskId !== run.taskId &&
  run.inputs.length > 0 &&
  next.inputs[0] === run.inputs[0];

/** Runs one pi-durable call, failing with the seam's error. */
const call = <A>(
  threadId: Option.Option<ThreadId>,
  operation: string,
  run: Parameters<typeof durable<A>>[1]
) => durable(operation, run).pipe(Effect.mapError(fromDurable(threadId)));

/**
 * The conversation watch's window (pi-durable 1.5, `ConversationWindow`): its first value holds the
 * newest entries the thread window can start with, and it never drops its oldest, so for the life of
 * one subscription every entry is an append and the thread window's prefix holds (ThreadWindow.ts).
 */
const STREAM_WINDOW: ConversationWindow = {
  min: WINDOW_POLICY.maxEntries,
  max: Number.MAX_SAFE_INTEGER,
};

/**
 * A snapshot frame of a window. The thread window (ThreadWindow.ts) leaves older entries out; with
 * none left out, pi-durable's own window may still start after the first entry (`before`).
 */
const snapshotItem = (
  seq: Ref.Ref<number>,
  windowed: WindowedView,
  current: PiConversationView
) =>
  Effect.gen(function* () {
    const hasMoreHistory =
      windowed.entriesOffset > 0 || current.before !== undefined;

    return ThreadSnapshotItem.make({
      seq: yield* Ref.getAndUpdate(seq, (n) => n + 1),
      view: windowed.view,
      entriesOffset: windowed.entriesOffset,
      hasMoreHistory,
    });
  });

/** The agent a new thread starts with. */
const firstAgent = (input: EnsureThread) => {
  const agent: Writable<AgentChange> = {
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    cwd: input.cwd,
  };

  if (Option.isSome(input.instructions)) {
    agent.instructions = input.instructions.value;
  }

  return agent;
};

/** A seam agent change as pi-durable takes it: only the settings that change. */
const agentChange = (change: ThreadAgentChange) => {
  const agent: Writable<AgentChange> = {};

  if (Option.isSome(change.model)) {
    agent.model = change.model.value;
  }

  if (Option.isSome(change.thinkingLevel)) {
    agent.thinkingLevel = change.thinkingLevel.value;
  }

  if (Option.isSome(change.cwd)) {
    agent.cwd = change.cwd.value;
  }

  return agent;
};

/**
 * The journal's map from a thread to its conversation, once per thread a process binds: the brain's
 * lifecycle lines name the conversation, the user sees the thread (coding standard S57).
 */
const bound = (
  threadId: ThreadId,
  conversationId: number,
  how: "created" | "ensured" | "found"
) =>
  Effect.logInfo("thread bound to its conversation").pipe(
    Effect.annotateLogs({
      event: "thread_bound",
      threadId,
      conversationId,
      how,
    })
  );

const layerNoDeps = Layer.effectContext(
  Effect.gen(function* () {
    const brain = yield* Brain;
    const feed = yield* CommitFeed;
    const crashes = yield* SubagentCrashes;
    const faults = yield* SubagentFaults;
    // Where a judge brain kills itself inside a brief's Go commit; none elsewhere.
    const briefAnswered = answerBrief(yield* BriefFaults);

    // What an answer does in its own commit: a workflow launch's row takes it (ADR 0032), a
    // subagent's brief starts its child or tells its parent (ADR 0030), and an accepted criteria
    // proposal binds its criteria (ADR 0026).
    const answered: AnsweredHook = async (tx, conversationId, record) => {
      await launchAnswered(tx, conversationId, record);
      await briefAnswered(tx, conversationId, record);
      await criteriaAnswered(tx, conversationId, record);
    };

    // A stop finishes here once it started aborting, whatever happens to its caller.
    const layerScope = yield* Effect.scope;

    // Receipts never change once written, so a thread's conversation is cached for good.
    const conversations = new Map<ThreadId, PiConversationId>();

    // Every thread `ensureThread` committed, for `whenEnsured` to wake on.
    const ensured = yield* PubSub.unbounded<ThreadId>();

    const open = (threadId: Option.Option<ThreadId>) =>
      brain.session.pipe(Effect.mapError(fromUnavailable(threadId)));

    const conversationIdOf = Effect.fn("PiDurableHarness.conversationIdOf")(
      function* (session: BrainSession, threadId: ThreadId) {
        const cached = conversations.get(threadId);

        if (cached !== undefined) {
          return cached;
        }

        const receipt = yield* call(
          Option.some(threadId),
          "receipt.read",
          async (context) =>
            await session.harness.snapshot(ThreadReceipt, threadId, context)
        );

        if (receipt === undefined || receipt.conversationId < 1) {
          return yield* failure(
            "thread_not_found",
            Option.some(threadId),
            `Thread ${threadId} does not exist in the brain. Launch it before sending to it.`
          );
        }

        const id = piConversationId(
          ConversationId.make(receipt.conversationId)
        );

        conversations.set(threadId, id);
        yield* bound(threadId, id, "found");

        return id;
      }
    );

    const conversationOf = Effect.fn("PiDurableHarness.conversationOf")(
      function* (session: BrainSession, threadId: ThreadId) {
        const id = yield* conversationIdOf(session, threadId);

        const conversation = yield* call(
          Option.some(threadId),
          "conversation",
          async (context) => await session.harness.conversation(id, context)
        );

        if (conversation === undefined) {
          return yield* failure(
            "thread_not_found",
            Option.some(threadId),
            `Thread ${threadId} has a receipt but no conversation. Report this thread id.`
          );
        }

        return conversation;
      }
    );

    /** The thread a conversation is, from its metadata; none for other conversations. */
    const threadOf = Effect.fn("PiDurableHarness.threadOf")(function* (
      session: BrainSession,
      conversationId: PiConversationId
    ) {
      const meta = yield* call(
        Option.none(),
        "thread-meta.read",
        async (context) =>
          await session.harness.snapshot(ThreadMeta, conversationId, context)
      );

      return Option.flatMap(Option.fromUndefinedOr(meta), (found) =>
        decodeThreadId(found.threadId)
      );
    });

    const ensureThread = Effect.fn("PiDurableHarness.ensureThread")(function* (
      input: EnsureThread
    ) {
      const threadId = Option.some(input.threadId);
      const session = yield* open(threadId);

      const result = yield* call(
        threadId,
        "ensure-thread",
        async (context) =>
          await session.harness.commit(async (tx) => {
            const receipt = await tx.doc(ThreadReceipt, input.threadId, {
              conversationId: 0,
            });

            if (receipt.conversationId > 0) {
              return { id: receipt.conversationId, created: false };
            }

            const record = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });

            await configure(tx, record.id, firstAgent(input));

            const meta = await tx.doc(ThreadMeta, record.id);

            // Created now, so a thread stream can always watch them. A thread created before the
            // registry was written here has none until its first child starts, and a stream
            // opened before that shows it only once the client resubscribes (4C, 6).
            await tx.doc(Approvals, record.id);
            await tx.doc(SubagentsDoc, record.id);
            await tx.doc(EscalationsDoc, record.id);
            // The mode gated tools read at call time (ADR 0031).
            await writeMode(tx, record.id, input.runtimeMode);

            meta.threadId = input.threadId;
            meta.projectId = input.projectId;
            receipt.conversationId = record.id;

            return { id: record.id, created: true };
          }, context)
      );

      const conversationId = ConversationId.make(result.id);

      conversations.set(input.threadId, piConversationId(conversationId));
      yield* bound(
        input.threadId,
        conversationId,
        result.created ? "created" : "ensured"
      );
      yield* PubSub.publish(ensured, input.threadId);

      return {
        threadId: input.threadId,
        conversationId,
        created: result.created,
      };
    });

    const liveRun = Effect.fn("PiDurableHarness.liveRun")(function* (
      session: BrainSession,
      threadId: ThreadId,
      conversationId: PiConversationId
    ) {
      const live = yield* call(
        Option.some(threadId),
        "live.read",
        async (context) =>
          await session.harness.snapshot(LiveDoc, conversationId, context)
      );

      return Option.fromUndefinedOr(live?.run);
    });

    const configureThread = Effect.fn("PiDurableHarness.configure")(function* (
      threadId: ThreadId,
      change: ThreadAgentChange
    ) {
      const session = yield* open(Option.some(threadId));
      const conversation = yield* conversationOf(session, threadId);

      // A subagent's mode never widens past its parent's effective mode (ADR 0031).
      for (const mode of Option.toArray(change.runtimeMode)) {
        const ceiling = yield* call(
          Option.some(threadId),
          "permissions.ceiling",
          async (context) =>
            await parentCeiling(
              {
                snapshot: session.harness.snapshot.bind(session.harness),
                conversationId: conversation.id,
              },
              context
            )
        );

        if (Option.isSome(ceiling) && isWiderThan(mode, ceiling.value)) {
          return yield* failure(
            "invalid_input",
            Option.some(threadId),
            `A subagent's permission mode cannot be wider than its parent's (${ceiling.value}). Choose ${ceiling.value} or a narrower mode.`
          );
        }
      }

      if (Option.isSome(change.cwd) || Option.isSome(change.runtimeMode)) {
        const run = yield* liveRun(session, threadId, conversation.id);

        if (Option.isSome(run)) {
          return yield* failure(
            "invalid_input",
            Option.some(threadId),
            Option.isSome(change.cwd)
              ? `Thread ${threadId} is running, so its folder cannot change now. Stop it or wait, then change the folder.`
              : `Thread ${threadId} is running, so its permission mode cannot change now. Stop it or wait, then change the mode.`
          );
        }
      }

      if (Option.isSome(change.runtimeMode)) {
        const mode = change.runtimeMode.value;

        yield* call(
          Option.some(threadId),
          "permissions.mode",
          async (context) => {
            await session.harness.commit(async (tx) => {
              await writeMode(tx, conversation.id, mode);
            }, context);
          }
        );
      }

      const agent = agentChange(change);

      if (Object.keys(agent).length === 0) {
        return yield* Effect.void;
      }

      return yield* call(
        Option.some(threadId),
        "configure",
        async (context) => {
          await conversation.configure(agent, context);
        }
      );
    });

    const submit = Effect.fn("PiDurableHarness.submit")(function* (
      threadId: ThreadId,
      input: HarnessTurnInput
    ) {
      const session = yield* open(Option.some(threadId));
      const conversation = yield* conversationOf(session, threadId);

      const draft: InputSubmissionDraft = Option.match(input.entry, {
        onNone: () => ({
          type: "input",
          requestId: input.requestId,
          content: [...input.content],
          whenBusy: input.whenBusy,
        }),
        onSome: (entry) => ({
          type: "input",
          requestId: input.requestId,
          content: [...input.content],
          whenBusy: input.whenBusy,
          entry: { kind: entry.kind, data: entry.data },
        }),
      });

      // A user's input to a subagent gets its reporter first, so its result reaches the parent.
      const reported = yield* steerReporter(
        session.harness,
        conversation.id,
        draft
      ).pipe(Effect.mapError(fromDurable(Option.some(threadId))));

      if (reported) {
        crashes.at("steer-recorded");
      }

      // The kill judge's steer control: an id the steer's reporter does not submit under.
      const submitted =
        faults.seamOwnIds && draft.requestId !== undefined
          ? { ...draft, requestId: `${draft.requestId}-seam` }
          : draft;

      const record = yield* call(
        Option.some(threadId),
        "submit",
        async (context) => {
          const submission = await conversation.submit(submitted, context);

          return await submission.status(context);
        }
      );

      return {
        submissionId: SubmissionId.make(record.id),
        status: record.status,
      };
    });

    /**
     * After a stop: waits (bounded, all at once) for the stopped run's tasks to end, so RunTerminal
     * comes first, then cancels the records they held (ADR 0029). A failure here leaves the run
     * stopped and the records pending, and is logged rather than failing the stop; the boot repair
     * (`cancelAbandonedApprovalsAtBoot`) cancels them at the next start. A stop with no run still
     * cancels a question the thread's final answer became (`relayedQuestion`, ADR 0027): the stopped
     * child no longer waits for its answer.
     */
    const cancelHeld = Effect.fn("PiDurableHarness.cancelHeld")(function* (
      session: BrainSession,
      threadId: ThreadId,
      conversationId: PiConversationId,
      stopped: ReadonlyArray<PiTaskId>
    ) {
      if (stopped.length === 0) {
        const approvals = yield* call(
          Option.some(threadId),
          "read-approvals",
          async (context) =>
            await session.harness.snapshot(Approvals, conversationId, context)
        ).pipe(Effect.option);

        if (
          !Option.exists(approvals, (found) =>
            Object.values(found?.items ?? {}).some(relayedQuestion)
          )
        ) {
          return yield* Effect.void;
        }
      }

      yield* Effect.forEach(
        stopped,
        (taskId) =>
          call(
            Option.some(threadId),
            "wait-stopped",
            async (context) =>
              await session.harness.waitForTask(taskId, context)
          ).pipe(
            Effect.timeoutOption(STOP_SETTLE),
            Effect.flatMap((ended) =>
              Option.isSome(ended)
                ? Effect.void
                : Effect.logWarning("stopped task outlived the wait").pipe(
                    Effect.annotateLogs({
                      event: "stop_wait_timeout",
                      threadId,
                      taskId,
                    })
                  )
            ),
            Effect.catch((error) =>
              Effect.logWarning("stopped task wait failed").pipe(
                Effect.annotateLogs({
                  event: "stop_wait_failed",
                  threadId,
                  taskId,
                  cause: error.message,
                })
              )
            )
          ),
        { concurrency: "unbounded", discard: true }
      );

      return yield* cancelStoppedApprovals(
        session.harness,
        conversationId,
        stopped,
        brain.now()
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("stop left approvals pending").pipe(
            Effect.annotateLogs({
              event: "stop_cancel_failed",
              threadId,
              cause: error.message,
            })
          )
        ),
        Effect.asVoid
      );
    });

    /**
     * The stop's aborts, then the cancellation of what the run held. Returns the run task a wake
     * hold names (`holdWakes`): the last generation the stop aborted or followed; none when it found
     * no run live, or when it cleared the queue, as nothing queued can then start a run after the
     * stop and the newest run is the stopped one's last generation.
     */
    const abortAndCancel = Effect.fn("PiDurableHarness.abortAndCancel")(
      function* (
        session: BrainSession,
        threadId: ThreadId,
        conversation: Conversation,
        options: StopOptions
      ) {
        let run = yield* liveRun(session, threadId, conversation.id);

        if (options.clearQueue) {
          yield* call(Option.some(threadId), "abort", async (context) => {
            await conversation.abort(context);
          });

          yield* cancelHeld(
            session,
            threadId,
            conversation.id,
            Option.toArray(Option.map(run, (stopped) => stopped.taskId))
          );

          return Option.none<PiTaskId>();
        }

        const stopped: Array<PiTaskId> = [];
        let followed = 0;

        while (Option.isSome(run) && followed < STOP_HANDOVERS) {
          const current = run.value;

          yield* call(Option.some(threadId), "abort-task", async (context) => {
            await session.harness.abortTask(current.taskId, context);
          });
          stopped.push(current.taskId);

          // Anything but a handover (no run, the same task still ending, a run for queued inputs)
          // ends the stop.
          run = Option.filter(
            yield* liveRun(session, threadId, conversation.id),
            (next) => isHandover(current, next)
          );
          followed += 1;
        }

        if (Option.isSome(run)) {
          yield* Effect.logWarning("run outran the stop").pipe(
            Effect.annotateLogs({
              event: "stop_outran",
              threadId,
              taskId: run.value.taskId,
            })
          );
        }

        yield* cancelHeld(session, threadId, conversation.id, stopped);

        return Option.orElse(
          Option.map(run, (outran) => outran.taskId),
          () => Option.fromUndefinedOr(stopped.at(-1))
        );
      }
    );

    /**
     * Places the notes a stopped or failed run left queued, in one host commit, if the thread is
     * idle; a running thread places them at its next boundary. Never starts a run.
     */
    const placeLeftWrites = Effect.fn("PiDurableHarness.placeLeftWrites")(
      function* (threadId: ThreadId) {
        const session = yield* open(Option.some(threadId));
        const conversationId = yield* conversationIdOf(session, threadId);

        yield* call(Option.some(threadId), "place-writes", async (context) => {
          await session.harness.commit(async (tx) => {
            const marker = await tx.latestHeadMarker(conversationId);
            const live = await tx.doc(LiveDoc, conversationId);
            const inbox = await tx.doc(InboxDoc, conversationId);

            if (
              live.run === undefined &&
              inbox.items.some((item) => item.mode === "write")
            ) {
              await placeQueuedWrites(tx, conversationId, inbox, marker?.head);
            }
          }, context);
        });
      }
    );

    /** `placeLeftWrites` after a stop or a failed run; a failure is logged, never raised. */
    const placeAfterRun = Effect.fn("PiDurableHarness.placeAfterRun")(
      function* (threadId: ThreadId) {
        const placed = yield* Effect.result(placeLeftWrites(threadId));

        if (Result.isFailure(placed)) {
          yield* Effect.logWarning("queued notes stay queued").pipe(
            Effect.annotateLogs({
              event: "place_writes_failed",
              threadId,
              cause: placed.failure.message,
            })
          );
        }
      }
    );

    // A run that failed, or ended by a stop the stop itself did not see out (it outran the wait),
    // leaves its queued notes in `pi.inbox`: place them once its RunTerminal commits.
    yield* feed.events.pipe(
      Stream.filter(
        (event) =>
          Predicate.isTagged(event, "RunTerminal") &&
          event.status !== "completed"
      ),
      // A defect placing one thread's notes is logged and the loop goes on.
      Stream.runForEach((event) =>
        placeAfterRun(event.threadId).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError("queued notes not placed").pipe(
                Effect.annotateLogs({
                  event: "place_writes_defect",
                  threadId: event.threadId,
                  cause: Cause.pretty(cause),
                })
              )
          )
        )
      ),
      Effect.forkIn(layerScope)
    );

    /**
     * One thread's stop, in the caller's fiber: its aborts and cancellations, the notes its run left
     * queued, then with `subagents: "stop"` a hold on its wakes (`holdWakes`) and each child its
     * registry names as working or whose run is live, queue cleared, and theirs in turn (ADR 0028).
     * `keep` leaves them working. A settled child with no run is left as it is, its warm session
     * kept, and so is anything under it. The descendants it stopped, nearest first.
     */
    const stopTree = (
      threadId: ThreadId,
      options: StopOptions
    ): Effect.Effect<ReadonlyArray<ThreadId>, HarnessError> =>
      Effect.gen(function* () {
        const session = yield* open(Option.some(threadId));
        const conversation = yield* conversationOf(session, threadId);

        // The run the stop ended: a run its end starts for a queued input comes after the stop, and
        // the wake hold must not name it (`holdWakes`).
        const ended = yield* abortAndCancel(
          session,
          threadId,
          conversation,
          options
        );

        // The notes the stopped run left queued enter the transcript now (ADR 0028).
        yield* placeAfterRun(threadId);

        if (options.subagents !== "stop") {
          return [];
        }

        // Before any child stops: their stopped results must not wake this thread, even when its
        // last run had completed (ADR 0028).
        yield* call(Option.some(threadId), "wake-hold", async (context) => {
          await session.harness.commit(async (tx) => {
            await holdWakes(tx, conversation.id, ended);
          }, context);
        });

        const registry = yield* call(
          Option.some(threadId),
          "subagents.read",
          async (context) =>
            await session.harness.snapshot(
              SubagentsDoc,
              conversation.id,
              context
            )
        );

        const stopped: Array<ThreadId> = [];

        for (const item of Object.values(registry?.items ?? {})) {
          const child = decodeThreadId(item.threadId);

          // A settled child whose run still goes on is stopped too: its reporter threw before the
          // run ended (O-3), so nothing else follows that run.
          const working =
            item.status !== "settled" ||
            (Option.isSome(child) &&
              Option.isSome(
                yield* liveRun(
                  session,
                  child.value,
                  piConversationId(ConversationId.make(item.conversationId))
                )
              ));

          if (working && Option.isSome(child)) {
            stopped.push(
              child.value,
              ...(yield* stopTree(child.value, {
                clearQueue: true,
                subagents: "stop",
              }))
            );
          }
        }

        return stopped;
      });

    /**
     * Stops a thread's run, and with Stop all its working descendants. The whole stop runs in the
     * harness's own scope and the caller only joins it: an abort mark is durable, so a caller that
     * goes away (a client disconnect interrupting the RPC) must not leave the records its run held
     * pending, nor the later children of a Stop all running. A crash in between is the boot
     * repair's (`cancelAbandonedApprovalsAtBoot`).
     */
    const stop = Effect.fn("PiDurableHarness.stop")(function* (
      threadId: ThreadId,
      options: StopOptions
    ) {
      const stopping = yield* stopTree(threadId, options).pipe(
        Effect.forkIn(layerScope)
      );

      return yield* Fiber.join(stopping);
    });

    const withdraw = Effect.fn("PiDurableHarness.withdraw")(function* (
      threadId: ThreadId,
      submissionId: SubmissionId
    ) {
      const session = yield* open(Option.some(threadId));
      const conversationId = yield* conversationIdOf(session, threadId);

      const outcome = yield* call(
        Option.some(threadId),
        "abort-submission",
        async (context) =>
          await session.harness.abortSubmission(
            piSubmissionId(submissionId),
            context,
            conversationId
          )
      );

      if (outcome === "not_found") {
        return yield* failure(
          "submission_not_found",
          Option.some(threadId),
          `Input ${submissionId} is not queued on thread ${threadId}. Refresh the thread and try again.`
        );
      }

      return { withdrawn: outcome === "aborted" };
    });

    const respond = Effect.fn("PiDurableHarness.respond")(function* (
      threadId: ThreadId,
      approvalId: ApprovalId,
      answer: ApprovalAnswerInput
    ) {
      const session = yield* open(Option.some(threadId));
      const conversationId = yield* conversationIdOf(session, threadId);

      const outcome = yield* answerApproval(
        session.harness,
        conversationId,
        approvalId,
        { ...answer, by: { kind: "user" } },
        brain.now(),
        answered
      ).pipe(Effect.mapError(fromDurable(Option.some(threadId))));

      if (outcome === "not_found") {
        return yield* failure(
          "approval_not_found",
          Option.some(threadId),
          `Approval ${approvalId} is not on thread ${threadId}. Refresh the thread; it may have been answered elsewhere.`
        );
      }

      const refused = refusalText(outcome, approvalId);

      if (Option.isSome(refused)) {
        return yield* failure(
          "invalid_input",
          Option.some(threadId),
          refused.value
        );
      }

      return yield* Effect.void;
    });

    const compact = Effect.fn("PiDurableHarness.compact")(function* (
      threadId: ThreadId,
      instructions: Option.Option<string>
    ) {
      const session = yield* open(Option.some(threadId));
      const conversation = yield* conversationOf(session, threadId);

      yield* call(Option.some(threadId), "compact", async (context) => {
        await conversation.compact(
          Option.getOrUndefined(instructions),
          context
        );
      });
    });

    /**
     * A write never starts a run. A display-only entry goes through `submit`, which appends it at
     * once whatever the conversation's state. A note (with `model`) is admitted here, in one host
     * commit, because pi-durable's admission treats a model write on an idle conversation with
     * queued inputs as a boundary: it would place them and start a run (a parent the user stopped
     * with a follow-up or a wake still queued would restart on a child's note, against ADR 0028).
     * So on an idle conversation it first places the writes a stopped or failed run left queued,
     * then appends the note, and leaves queued inputs alone; a running one queues the note for the
     * next boundary, where writes go ahead of inputs. The request id makes it land once, as
     * `submit`'s does.
     */
    const write = Effect.fn("PiDurableHarness.write")(function* (
      threadId: ThreadId,
      entry: PassiveEntry | PassiveNote
    ) {
      const session = yield* open(Option.some(threadId));

      if (!("model" in entry)) {
        const conversation = yield* conversationOf(session, threadId);

        yield* call(Option.some(threadId), "write", async (context) => {
          await conversation.submit(
            {
              type: "write",
              requestId: entry.requestId,
              entry: { kind: entry.kind, data: entry.data },
            },
            context
          );
        });

        return;
      }

      const conversationId = yield* conversationIdOf(session, threadId);

      const draft = {
        kind: entry.kind,
        data: entry.data,
        model: [
          {
            role: "user" as const,
            content: entry.model.map((part) => ({
              type: "text" as const,
              text: part.text,
            })),
            timestamp: brain.now(),
          },
        ],
      };

      yield* call(Option.some(threadId), "write", async (context) => {
        await session.harness.commit(async (tx) => {
          await admitNote(tx, conversationId, entry.requestId, draft);
        }, context);
      });
    });

    /** The thread stream within one Session; ends when that Session's watch ends. */
    const watchIn = (
      session: BrainSession,
      threadId: ThreadId,
      seq: Ref.Ref<number>
    ) =>
      Stream.callback<ThreadFrame, HarnessError>(
        (queue) =>
          Effect.gen(function* () {
            const conversation = yield* conversationOf(session, threadId);

            const watch = yield* Effect.acquireRelease(
              call(
                Option.some(threadId),
                "watch",
                async (context) =>
                  await conversation.watch(context, STREAM_WINDOW)
              ),
              (handle) =>
                Effect.promise(async () => {
                  await handle.stop();
                })
            );

            // The `cairn.*` documents are not among pi-durable's built-in view documents; the
            // stream watches each one beside the conversation and adds it to the view.
            const docWatches = yield* Effect.forEach(
              STREAM_DOCUMENTS,
              (token) =>
                Effect.acquireRelease(
                  call(
                    Option.some(threadId),
                    `watch-${token.definition.kind}`,
                    async (context) =>
                      await session.harness.watchDoc(
                        token,
                        conversation.id,
                        context
                      )
                  ),
                  (handle) =>
                    Effect.promise(async () => {
                      await handle?.stop();
                    })
                ).pipe(
                  Effect.map((handle) => ({
                    kind: token.definition.kind,
                    handle: Option.fromUndefinedOr(handle),
                  }))
                )
            );

            const projector = windowedProjector();

            let latest = watch.value;

            // Each watched document's newest value; a document that does not exist yet is absent.
            const latestDocs = new Map<string, Readonly<JsonObject>>();

            for (const { kind, handle } of docWatches) {
              for (const value of Option.toArray(handle)) {
                latestDocs.set(kind, value.value);
              }
            }

            const withDocs = (): PiConversationView =>
              latestDocs.size === 0
                ? latest
                : {
                    ...latest,
                    docs: { ...latest.docs, ...Object.fromEntries(latestDocs) },
                  };

            const first = yield* Effect.fromResult(
              projector.snapshot(withDocs())
            ).pipe(Effect.mapError(fromWire(Option.some(threadId))));

            yield* Queue.offer(
              queue,
              yield* snapshotItem(seq, first, watch.value)
            );

            // The listeners only record the newest revision and ring; with the one-frame output
            // buffer below, a slow subscriber gets one larger diff instead of a backlog.
            const ticks = yield* Queue.sliding<true>(1);

            watch.start(
              handOff((change: WatchCall<PiConversationView>) => {
                if (change.kind === "value") {
                  latest = change.value;
                  Queue.offerUnsafe(ticks, true);
                }
              })
            );

            for (const { kind, handle } of docWatches) {
              for (const docWatch of Option.toArray(handle)) {
                docWatch.start(
                  handOff((change: WatchCall<Readonly<JsonObject>>) => {
                    // A retired document keeps its last value on the watch; the view drops it.
                    for (const value of Option.toArray(documentCall(change))) {
                      if (value === null) {
                        latestDocs.delete(kind);
                      } else {
                        latestDocs.set(kind, value);
                      }

                      Queue.offerUnsafe(ticks, true);
                    }
                  })
                );
              }
            }

            yield* Queue.take(ticks).pipe(
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  const current = withDocs();

                  const frame = yield* Effect.fromResult(
                    projector.advance(current)
                  ).pipe(Effect.mapError(fromWire(Option.some(threadId))));

                  yield* WindowFrame.$match(frame, {
                    Snapshot: (windowed) =>
                      Effect.flatMap(
                        snapshotItem(seq, windowed, current),
                        (item) => Queue.offer(queue, item)
                      ),
                    Ops: ({ ops }) =>
                      ops.length === 0
                        ? Effect.void
                        : Effect.flatMap(
                            Ref.getAndUpdate(seq, (n) => n + 1),
                            (next) =>
                              Queue.offer(
                                queue,
                                ThreadOpsItem.make({ seq: next, ops })
                              )
                          ),
                  });
                })
              ),
              Effect.forever,
              Effect.catch((error) => Queue.fail(queue, error)),
              Effect.forkScoped
            );

            yield* Effect.promise(async () => await watch.closed).pipe(
              Effect.flatMap((end) =>
                end.kind === "listener_error"
                  ? Queue.fail(
                      queue,
                      failure(
                        "internal",
                        Option.some(threadId),
                        `The thread stream stopped: ${end.error.message}. Resubscribe.`
                      )
                    )
                  : Queue.end(queue)
              ),
              Effect.forkScoped
            );
          }),
        // One frame waits for the consumer at most: while it is behind, the producer suspends on
        // the offer and the sliding tick keeps only that something changed, so the next frame is
        // one diff over every revision since the last (T49). Frames are deltas, so dropping or
        // sliding the frames themselves would corrupt the client's view.
        { bufferSize: 1, strategy: "suspend" }
      );

    const watchThread = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const seq = yield* Ref.make(0);
          const session = yield* open(Option.some(threadId));

          // An unknown thread fails the subscription at once.
          yield* conversationIdOf(session, threadId);

          // One frame buffered here too, so the coalescing in `watchIn` reaches the subscriber.
          return brain.sessions.pipe(
            Stream.switchMap((next) => watchIn(next, threadId, seq), {
              bufferSize: 1,
            })
          );
        })
      );

    /** One `cairn.*` document the stream carries, read once from a snapshot of its token. */
    const document = Effect.fn("PiDurableHarness.document")(function* (
      threadId: ThreadId,
      kind: string
    ) {
      if (!isStreamDocument(kind)) {
        return yield* failure(
          "invalid_input",
          Option.some(threadId),
          `The thread stream does not carry ${kind}; read one of its cairn.* documents.`
        );
      }

      const session = yield* open(Option.some(threadId));
      const conversationId = yield* conversationIdOf(session, threadId);

      const token = STREAM_DOCUMENTS.find(
        (candidate) => candidate.definition.kind === kind
      );

      // A visible kind with no token here is one the stream does not watch on pi-durable yet.
      if (token === undefined) {
        return Option.none();
      }

      const value = yield* call(
        Option.some(threadId),
        `read-${kind}`,
        async (context) =>
          await session.harness.snapshot(token, conversationId, context)
      );

      return Option.flatMap(Option.fromNullishOr(value), (doc) =>
        projectDocument(kind, doc)
      );
    });

    const whenEnsured = Effect.fn("PiDurableHarness.whenEnsured")(function* (
      threadId: ThreadId
    ) {
      // Subscribed before the receipt read, so an ensure committing in between still wakes it.
      const wake = yield* PubSub.subscribe(ensured);
      const session = yield* open(Option.some(threadId));

      const known = yield* conversationIdOf(session, threadId).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason === "thread_not_found",
          () => Effect.succeed(false)
        )
      );

      if (known) {
        return;
      }

      yield* PubSub.take(wake).pipe(
        Effect.repeat({ until: (id) => id === threadId })
      );
    }, Effect.scoped);

    const history = Effect.fn("PiDurableHarness.history")(function* (
      threadId: ThreadId,
      query: HistoryQuery
    ) {
      if (query.before <= 1) {
        return { entries: [], hasMore: false };
      }

      const session = yield* open(Option.some(threadId));
      const conversation = yield* conversationOf(session, threadId);

      const page = yield* call(
        Option.some(threadId),
        "entries",
        async (context) =>
          await conversation.entries(
            {
              maxEntryId: piEntryId(EntryId.make(query.before - 1)),
              order: "descending",
            },
            query.limit + 1,
            undefined,
            context
          )
      );

      const kept = page.items.slice(0, query.limit).toReversed();

      const entries = yield* Effect.forEach(kept, (entry) =>
        Effect.fromResult(projectEntry(entry, "stream")).pipe(
          Effect.mapError(fromWire(Option.some(threadId)))
        )
      );

      return { entries, hasMore: page.items.length > query.limit };
    });

    const readEntry = Effect.fn("PiDurableHarness.readEntry")(function* (
      threadId: ThreadId,
      entryId: EntryId
    ) {
      const session = yield* open(Option.some(threadId));
      const conversationId = yield* conversationIdOf(session, threadId);

      const found = yield* call(
        Option.some(threadId),
        "entry",
        async (context) =>
          await session.storage.entry(
            conversationId,
            piEntryId(entryId),
            context
          )
      );

      if (found === undefined) {
        return yield* failure(
          "entry_not_found",
          Option.some(threadId),
          `Entry ${entryId} is not in thread ${threadId}.`
        );
      }

      return found.entry;
    });

    const entry = Effect.fn("PiDurableHarness.entry")(function* (
      threadId: ThreadId,
      entryId: EntryId
    ) {
      const record = yield* readEntry(threadId, entryId);

      const full = yield* Effect.fromResult(projectEntry(record, "full")).pipe(
        Effect.mapError(fromWire(Option.some(threadId)))
      );

      if (
        encoder.encode(JSON.stringify(full)).length <= FULL_ENTRY_LIMIT_BYTES
      ) {
        return { entry: full, truncated: false };
      }

      const cut = yield* Effect.fromResult(projectEntry(record, "stream")).pipe(
        Effect.mapError(fromWire(Option.some(threadId)))
      );

      return { entry: cut, truncated: true };
    });

    const entryImage = Effect.fn("PiDurableHarness.entryImage")(function* (
      threadId: ThreadId,
      entryId: EntryId,
      index: number
    ) {
      const record = yield* readEntry(threadId, entryId);
      const image = entryImages(record)[index];

      if (image === undefined) {
        return yield* failure(
          "entry_not_found",
          Option.some(threadId),
          `Entry ${entryId} has no image ${index}.`
        );
      }

      return {
        mimeType: image.mimeType,
        bytes: Uint8Array.from(Buffer.from(image.data, "base64")),
      };
    });

    // Which conversations hold a pending approval record: one scan of every conversation,
    // the first time it is asked, then kept by every commit's `cairn.approvals` changes. A change
    // that lands while the scan runs wins over what the scan read; a Session the supervisor
    // reopened is scanned again, since a commit stored as the old one failed may never have been
    // published.
    const pendingIndex: PendingIndex = {
      known: Option.none(),
      session: Option.none(),
      during: new Map(),
    };

    yield* brain.subscribeCommits((session, publication) => {
      if (
        Option.isSome(pendingIndex.session) &&
        pendingIndex.session.value !== session
      ) {
        pendingIndex.known = Option.none();
        pendingIndex.session = Option.none();
      }

      for (const change of publication.changes) {
        if (
          change.type === "document" &&
          change.record.kind === Approvals.definition.kind &&
          change.conversationId !== undefined
        ) {
          const holds = holdsPending(documentValue(change));

          if (Option.isSome(pendingIndex.known)) {
            if (holds) {
              pendingIndex.known.value.add(change.conversationId);
            } else {
              pendingIndex.known.value.delete(change.conversationId);
            }
          } else {
            pendingIndex.during.set(change.conversationId, holds);
          }
        }
      }
    });

    const scanLock = yield* Semaphore.make(1);

    const pendingConversations = scanLock.withPermits(1)(
      Effect.gen(function* () {
        if (Option.isSome(pendingIndex.known)) {
          return new Set(pendingIndex.known.value);
        }

        const session = yield* open(Option.none());
        const found = new Set<PiConversationId>();
        let cursor: Option.Option<Cursor> = Option.none();
        let scanned = 0;

        pendingIndex.during.clear();

        do {
          const after = Option.getOrUndefined(cursor);

          const page = yield* call(
            Option.none(),
            "conversations.scan",
            async (context) =>
              await session.storage.scanConversations(
                {},
                INSPECT_SCAN_PAGE,
                after,
                context
              )
          );

          for (const conversation of page.items) {
            const approvals = yield* call(
              Option.none(),
              "approvals.read",
              async (context) =>
                await session.harness.snapshot(
                  Approvals,
                  conversation.id,
                  context
                )
            );

            scanned += 1;

            if (
              Object.values(approvals?.items ?? {}).some(
                (item) => item.status === "pending"
              )
            ) {
              found.add(conversation.id);
            }
          }

          cursor = Option.fromUndefinedOr(page.next);
        } while (Option.isSome(cursor));

        for (const [conversationId, holds] of pendingIndex.during) {
          if (holds) {
            found.add(conversationId);
          } else {
            found.delete(conversationId);
          }
        }

        pendingIndex.during.clear();
        pendingIndex.known = Option.some(found);
        pendingIndex.session = Option.some(session);

        yield* Effect.logInfo("approvals scanned").pipe(
          Effect.annotateLogs({
            event: "approvals_scanned",
            conversations: scanned,
            pending: found.size,
          })
        );

        return new Set(found);
      })
    );

    const inspect = Effect.gen(function* () {
      const session = yield* open(Option.none());

      const inspection = yield* call(
        Option.none(),
        "inspect",
        async (context) => await session.harness.inspect(context)
      );

      const byConversation = new Map<
        PiConversationId,
        {
          runId: Option.Option<RunId>;
          queueLength: number;
        }
      >();

      const slot = (id: PiConversationId) => {
        const existing = byConversation.get(id);

        if (existing !== undefined) {
          return existing;
        }

        const created = {
          runId: Option.none<RunId>(),
          queueLength: 0,
        };

        byConversation.set(id, created);

        return created;
      };

      // Only a run makes a thread live: a thread whose only tasks are Cairn's own (a subagent's, a
      // workflow's, a judge run) has nothing running, queued or pending, so the seam leaves it out.
      for (const task of inspection.tasks) {
        const { record } = task;

        if (record.kind === RUN_TASK) {
          slot(record.conversationId).runId = Option.some(
            RunId.make(record.id)
          );
        }
      }

      for (const submission of inspection.submissions) {
        if (submission.type === "input" && submission.status === "queued") {
          slot(submission.conversationId).queueLength += 1;
        }
      }

      // `inspect()` reports live work only, so a thread waiting on the user with nothing running
      // (a criteria proposal, a halted scope's raise) is found by its records: the records of
      // every conversation that holds a pending one (`PendingApprovals`).
      const pendingOf = new Map<PiConversationId, Array<ApprovalRecord>>();

      for (const conversationId of yield* pendingConversations) {
        const approvals = yield* call(
          Option.none(),
          "approvals.read",
          async (context) =>
            await session.harness.snapshot(Approvals, conversationId, context)
        );

        const pending = Object.values(approvals?.items ?? {}).filter(
          (item) => item.status === "pending"
        );

        if (pending.length > 0) {
          pendingOf.set(conversationId, pending);
          slot(conversationId);
        }
      }

      const states: Array<LiveThreadState> = [];

      for (const [conversationId, found] of byConversation) {
        const threadId = yield* threadOf(session, conversationId);

        if (Option.isSome(threadId)) {
          const pending = (pendingOf.get(conversationId) ?? []).map((item) => ({
            id: ApprovalId.make(item.id),
            kind: item.kind,
            askedAt: item.askedAt,
            route: item.route,
            origin: Option.map(Option.fromNullOr(item.mirrorOf), (mirror) =>
              ThreadId.make(mirror.threadId)
            ),
          }));

          states.push({
            threadId: threadId.value,
            conversationId: ConversationId.make(conversationId),
            runId: found.runId,
            queueLength: found.queueLength,
            pendingApprovals: pending,
          });
        }
      }

      return states;
    });

    const seam = HarnessSeam.of({
      ensureThread,
      configure: configureThread,
      submit,
      stop,
      withdraw,
      respond,
      write,
      compact,
      watch: watchThread,
      document,
      whenEnsured,
      history,
      entry,
      entryImage,
      events: feed.events,
      inspect,
      capabilities: { durable: true, live: true },
    });

    return Context.make(HarnessSeam, seam).pipe(
      Context.add(
        PendingApprovals,
        PendingApprovals.of({ conversations: pendingConversations })
      )
    );
  })
);

/**
 * The seam over pi-durable, and `PendingApprovals` beside it. `layer` puts the brain under it and
 * also exposes `Brain` (boot resumes it after its repairs); it needs the models, the extension set
 * and the brain's directory from the composition root.
 */
export const PiDurableHarness = {
  layerNoDeps,
  layer: layerNoDeps.pipe(
    Layer.provide(CommitFeed.layerNoDeps),
    Layer.provideMerge(
      Brain.layerNoDeps.pipe(
        Layer.provide(BrainStore.layer),
        Layer.provide(Arms.layer)
      )
    )
  ),
};
