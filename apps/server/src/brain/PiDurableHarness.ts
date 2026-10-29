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
//   on with a new snapshot of the new Session, because a snapshot is legal at any point.
// - whenEnsured: subscribes to this process's ensures, then reads the receipt, so an ensure that
//   lands in between is not missed. Only `ensureThread` writes receipts, and only in this process.
// - events: the commit feed, plus parked tasks from the Harness's reports.
//
// The submit, watch and abort wrappers follow cairn-v1, apps/server/src/Harnesses.ts at 1a5cd4a.

import { Buffer } from "node:buffer";

import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
  SubmissionId,
  TaskId,
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
  InputSubmissionDraft,
  JsonObject,
  LiveState,
  TaskId as PiTaskId,
} from "@earendil-works/pi-durable";
import {
  ConversationBusy,
  configure,
  InboxDoc,
  LiveDoc,
} from "@earendil-works/pi-durable";
import {
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
  Stream,
} from "effect";

import { BriefFaults } from "../subagents/BriefFaults.ts";
import { ChildDoc, SubagentsDoc } from "../subagents/SubagentDocs.ts";
import { answerBrief, steerReporter } from "../subagents/Subagents.ts";
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
  ThreadMeta,
  ThreadReceipt,
  writeMode,
} from "./CairnDocs.ts";
import { CommitFeed, RUN_TASK } from "./CommitFeed.ts";
import { durable, errorText, handOff } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import { HarnessError, HarnessSeam, TaskParked } from "./HarnessSeam.ts";
import type {
  ApprovalAnswerInput,
  EnsureThread,
  HarnessEvent,
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
import { Parked } from "./Parked.ts";
import {
  piConversationId,
  piEntryId,
  piSubmissionId,
  piTaskId,
} from "./PiIds.ts";
import { WindowFrame, windowedProjector } from "./ThreadWindow.ts";
import type { WindowedView } from "./ThreadWindow.ts";
import { entryImages, projectEntry } from "./ThreadWire.ts";
import type { ThreadWireError } from "./ThreadWire.ts";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

type Writable<A> = { -readonly [K in keyof A]: A[K] };

/**
 * The `cairn.*` documents the thread stream carries beside pi-durable's own view documents: every
 * `cairn.*` kind of `VISIBLE_DOCUMENTS` that a token exists for. A package that defines another
 * visible document adds its token here, and the stream watches it with no other edit.
 */
const STREAM_DOCUMENTS: ReadonlyArray<ConversationDocToken<JsonObject>> = [
  Approvals,
  Permissions,
  SubagentsDoc,
  ChildDoc,
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

/** pi-durable's rejection of `retryTask` for a task it does not have (scheduler.js, `retry`). */
const isMissingTask = (cause: unknown) =>
  /^Task \S+ does not exist$/u.test(errorText(cause));

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

/** Whether entries exist before the first one the view holds. */
const hasOlder = (
  threadId: ThreadId,
  conversation: Conversation,
  view: PiConversationView
) => {
  const [first] = view.entries;

  if (first === undefined || first.id <= 1) {
    return Effect.succeed(false);
  }

  return call(Option.some(threadId), "entries", async (context) => {
    const page = await conversation.entries(
      { maxEntryId: piEntryId(EntryId.make(first.id - 1)) },
      1,
      undefined,
      context
    );

    return page.items.length > 0;
  });
};

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

const layerNoDeps = Layer.effect(
  HarnessSeam,
  Effect.gen(function* () {
    const brain = yield* Brain;
    const feed = yield* CommitFeed;
    const parked = yield* Parked;
    // Where a judge brain kills itself inside a brief's Go commit; none elsewhere.
    const briefAnswered = answerBrief(yield* BriefFaults);
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
      yield* steerReporter(session.harness, conversation.id, draft).pipe(
        Effect.mapError(fromDurable(Option.some(threadId)))
      );

      const record = yield* call(
        Option.some(threadId),
        "submit",
        async (context) => {
          const submission = await conversation.submit(draft, context);

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
     * (`cancelAbandonedApprovalsAtBoot`) cancels them at the next start.
     */
    const cancelHeld = Effect.fn("PiDurableHarness.cancelHeld")(function* (
      session: BrainSession,
      threadId: ThreadId,
      conversationId: PiConversationId,
      stopped: ReadonlyArray<PiTaskId>
    ) {
      if (stopped.length === 0) {
        return yield* Effect.void;
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

    /** The stop's aborts, then the cancellation of what the run held. */
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

          return yield* cancelHeld(
            session,
            threadId,
            conversation.id,
            Option.toArray(Option.map(run, (stopped) => stopped.taskId))
          );
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

        return yield* cancelHeld(session, threadId, conversation.id, stopped);
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
      Stream.runForEach((event) => placeAfterRun(event.threadId)),
      Effect.forkIn(layerScope)
    );

    /**
     * One thread's stop, in the caller's fiber: its aborts and cancellations, the notes its run left
     * queued, then with `subagents: "stop"` each child its registry names as working, queue
     * cleared, and theirs in turn (ADR 0028). `keep` leaves them working.
     */
    const stopTree = (
      threadId: ThreadId,
      options: StopOptions
    ): Effect.Effect<void, HarnessError> =>
      Effect.gen(function* () {
        const session = yield* open(Option.some(threadId));
        const conversation = yield* conversationOf(session, threadId);

        yield* abortAndCancel(session, threadId, conversation, options);
        // The notes the stopped run left queued enter the transcript now (ADR 0028).
        yield* placeAfterRun(threadId);

        if (options.subagents !== "stop") {
          return;
        }

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

        for (const item of Object.values(registry?.items ?? {})) {
          const child = decodeThreadId(item.threadId);

          if (item.status !== "settled" && Option.isSome(child)) {
            yield* stopTree(child.value, {
              clearQueue: true,
              subagents: "stop",
            });
          }
        }
      });

    /**
     * Stops a thread's run, and with Stop all its working children. The whole stop runs in the
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
        briefAnswered
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
                async (context) => await conversation.watch(context)
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
                if (value.value !== null) {
                  latestDocs.set(kind, value.value);
                }
              }
            }

            const withDocs = (): PiConversationView =>
              latestDocs.size === 0
                ? latest
                : {
                    ...latest,
                    docs: { ...latest.docs, ...Object.fromEntries(latestDocs) },
                  };

            // A window (ThreadWindow.ts) leaves older entries out; with none left out, pi-durable
            // may still hold entries before the view (a compaction moved its start).
            const snapshotItem = (
              windowed: WindowedView,
              current: PiConversationView
            ) =>
              Effect.gen(function* () {
                const hasMoreHistory =
                  windowed.entriesOffset > 0 ||
                  (yield* hasOlder(threadId, conversation, current));

                return ThreadSnapshotItem.make({
                  seq: yield* Ref.getAndUpdate(seq, (n) => n + 1),
                  view: windowed.view,
                  entriesOffset: windowed.entriesOffset,
                  hasMoreHistory,
                });
              });

            const first = yield* Effect.fromResult(
              projector.snapshot(withDocs())
            ).pipe(Effect.mapError(fromWire(Option.some(threadId))));

            yield* Queue.offer(queue, yield* snapshotItem(first, watch.value));

            // The listeners only record the newest revision and ring; with the one-frame output
            // buffer below, a slow subscriber gets one larger diff instead of a backlog.
            const ticks = yield* Queue.sliding<true>(1);

            watch.start(
              handOff((value: PiConversationView) => {
                latest = value;
                Queue.offerUnsafe(ticks, true);
              })
            );

            for (const { kind, handle } of docWatches) {
              for (const docWatch of Option.toArray(handle)) {
                docWatch.start(
                  handOff((value: Readonly<JsonObject> | null) => {
                    if (value === null) {
                      latestDocs.delete(kind);
                    } else {
                      latestDocs.set(kind, value);
                    }

                    Queue.offerUnsafe(ticks, true);
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
                      Effect.flatMap(snapshotItem(windowed, current), (item) =>
                        Queue.offer(queue, item)
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
                end.reason === "listener_error"
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

    const parkedEvents = parked.parked.pipe(
      Stream.mapEffect((task) =>
        Effect.gen(function* () {
          const session = yield* brain.session;

          const threadId = yield* threadOf(
            session,
            piConversationId(task.conversationId)
          );

          return Option.map(threadId, (found) =>
            TaskParked.make({ threadId: found, taskId: task.taskId })
          );
        }).pipe(Effect.orElseSucceed(() => Option.none<HarnessEvent>()))
      ),
      Stream.filter(Option.isSome),
      Stream.map((event) => event.value)
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
          parkedTaskIds: Array<TaskId>;
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
          parkedTaskIds: [],
        };

        byConversation.set(id, created);

        return created;
      };

      for (const task of inspection.tasks) {
        const { record, state } = task;
        const target = slot(record.conversationId);

        if (record.kind === RUN_TASK) {
          target.runId = Option.some(RunId.make(record.id));
        }

        if (state.kind === "blocked" && state.reason === "restart_limit") {
          target.parkedTaskIds.push(TaskId.make(record.id));
          yield* parked.add({
            taskId: TaskId.make(record.id),
            conversationId: ConversationId.make(record.conversationId),
            kind: record.kind,
          });
        }
      }

      // A task that ended without a retry (a stop that cleared the queue, a deleted thread) is no
      // longer parked: forget it, so the list matches what pi-durable reports (T39).
      const stillParked = new Set(
        [...byConversation.values()].flatMap((found) => found.parkedTaskIds)
      );

      for (const known of yield* parked.list) {
        if (!stillParked.has(known.taskId)) {
          yield* parked.remove(known.taskId);
        }
      }

      for (const submission of inspection.submissions) {
        if (submission.type === "input" && submission.status === "queued") {
          slot(submission.conversationId).queueLength += 1;
        }
      }

      const states: Array<LiveThreadState> = [];

      for (const [conversationId, found] of byConversation) {
        const threadId = yield* threadOf(session, conversationId);

        if (Option.isSome(threadId)) {
          const approvals = yield* call(
            threadId,
            "approvals.read",
            async (context) =>
              await session.harness.snapshot(Approvals, conversationId, context)
          );

          const pending = Object.values(approvals?.items ?? {})
            .filter((item) => item.status === "pending")
            .map((item) => ApprovalId.make(item.id));

          states.push({
            threadId: threadId.value,
            conversationId: ConversationId.make(conversationId),
            runId: found.runId,
            queueLength: found.queueLength,
            parkedTaskIds: found.parkedTaskIds,
            pendingApprovals: pending,
          });
        }
      }

      return states;
    });

    const retry = Effect.fn("PiDurableHarness.retry")(function* (
      taskId: TaskId
    ) {
      const session = yield* open(Option.none());

      yield* durable("retry-task", async (context) => {
        await session.harness.retryTask(piTaskId(taskId), context);
      }).pipe(
        // pi-durable rejects an unknown task with "Task <id> does not exist" and does nothing for one
        // that is not parked; every other rejection keeps its own classification and cause.
        Effect.mapError((error) =>
          !error.closed && isMissingTask(error.cause)
            ? failure(
                "task_not_found",
                Option.none(),
                `Task ${taskId} is not in the brain. Refresh the thread.`
              )
            : fromDurable(Option.none())(error)
        ),
        // A task the brain no longer has cannot stay parked either.
        Effect.tapError((error) =>
          error.reason === "task_not_found"
            ? parked.remove(taskId)
            : Effect.void
        )
      );
      yield* parked.remove(taskId);
    });

    return HarnessSeam.of({
      ensureThread,
      configure: configureThread,
      submit,
      stop,
      withdraw,
      respond,
      write,
      compact,
      watch: watchThread,
      whenEnsured,
      history,
      entry,
      entryImage,
      events: Stream.merge(feed.events, parkedEvents),
      inspect,
      retry,
      capabilities: { durable: true, live: true },
    });
  })
);

/**
 * The seam over pi-durable. `layer` puts the brain under it and also exposes `Brain` (boot resumes
 * it after its repairs) and `Parked`; it needs the models, the extension set and the brain's
 * directory from the composition root.
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
    ),
    Layer.provideMerge(Parked.layer)
  ),
};
