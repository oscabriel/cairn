// The harness seam over pi-durable: every thread is an ownerless conversation in the brain's one
// store (ADR 0016), found through its `cairn.thread` receipt.
//
// - ensureThread: receipt, `createConversation`, `configure` and `cairn.thread-meta` in one
//   commit that reads no table first, so concurrent calls for one thread land once.
// - stop keeps the queue (`abortTask` on the run task); `clearQueue` aborts the conversation, which
//   also withdraws queued inputs (plan D16).
// - watch: a fresh projected snapshot, then ops; after a reopen of the Session the stream carries
//   on with a new snapshot of the new Session, because a snapshot is legal at any point.
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
import type { ApprovalDecision } from "@cairn/protocol/Policy";
import {
  FULL_ENTRY_LIMIT_BYTES,
  ThreadOpsItem,
  ThreadSnapshotItem,
} from "@cairn/protocol/Thread";
import type {
  AgentChange,
  Conversation,
  ConversationId as PiConversationId,
  ConversationView as PiConversationView,
  EntryRecord,
  InputSubmissionDraft,
} from "@earendil-works/pi-durable";
import {
  ConversationBusy,
  configure,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";

import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession, BrainUnavailable } from "./Brain.ts";
import { BrainStore } from "./BrainStore.ts";
import {
  answerApproval,
  Approvals,
  ThreadMeta,
  ThreadReceipt,
} from "./CairnDocs.ts";
import type { ApprovalsState } from "./CairnDocs.ts";
import { CommitFeed, RUN_TASK } from "./CommitFeed.ts";
import { durable, handOff } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import { HarnessError, HarnessSeam, TaskParked } from "./HarnessSeam.ts";
import type {
  EnsureThread,
  HarnessEvent,
  HarnessTurnInput,
  HistoryQuery,
  LiveThreadState,
  StopOptions,
  ThreadAgentChange,
  ThreadFrame,
} from "./HarnessSeam.ts";
import { Parked } from "./Parked.ts";
import {
  piConversationId,
  piEntryId,
  piSubmissionId,
  piTaskId,
} from "./PiIds.ts";
import { projectEntry, wireProjector } from "./ThreadWire.ts";
import type { ThreadWireError } from "./ThreadWire.ts";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

type Writable<A> = { -readonly [K in keyof A]: A[K] };

const APPROVALS_KIND = Approvals.definition.kind;

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

/** The images of an entry in the order the projection numbers them. */
const entryImages = (entry: EntryRecord) => {
  const images: Array<{ readonly mimeType: string; readonly data: string }> =
    [];

  for (const message of entry.model ?? []) {
    if (
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content)
    ) {
      for (const part of message.content) {
        if (part.type === "image") {
          images.push({ mimeType: part.mimeType, data: part.data });
        }
      }
    }
  }

  return images;
};

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

    // Receipts never change once written, so a thread's conversation is cached for good.
    const conversations = new Map<ThreadId, PiConversationId>();

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

            // Created now, so a thread stream can always watch it.
            await tx.doc(Approvals, record.id);

            meta.threadId = input.threadId;
            meta.projectId = input.projectId;
            receipt.conversationId = record.id;

            return { id: record.id, created: true };
          }, context)
      );

      const conversationId = ConversationId.make(result.id);

      conversations.set(input.threadId, piConversationId(conversationId));

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

      if (Option.isSome(change.cwd)) {
        const run = yield* liveRun(session, threadId, conversation.id);

        if (Option.isSome(run)) {
          return yield* failure(
            "invalid_input",
            Option.some(threadId),
            `Thread ${threadId} is running, so its folder cannot change now. Stop it or wait, then change the folder.`
          );
        }
      }

      return yield* call(
        Option.some(threadId),
        "configure",
        async (context) => {
          await conversation.configure(agentChange(change), context);
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

    const stop = Effect.fn("PiDurableHarness.stop")(function* (
      threadId: ThreadId,
      options: StopOptions
    ) {
      const session = yield* open(Option.some(threadId));
      const conversation = yield* conversationOf(session, threadId);

      if (options.clearQueue) {
        return yield* call(Option.some(threadId), "abort", async (context) => {
          await conversation.abort(context);
        });
      }

      const run = yield* liveRun(session, threadId, conversation.id);

      if (Option.isNone(run)) {
        return yield* Effect.void;
      }

      return yield* call(
        Option.some(threadId),
        "abort-task",
        async (context) => {
          await session.harness.abortTask(run.value.taskId, context);
        }
      );
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
      decision: ApprovalDecision
    ) {
      const session = yield* open(Option.some(threadId));
      const conversationId = yield* conversationIdOf(session, threadId);

      const outcome = yield* answerApproval(
        session.harness,
        conversationId,
        approvalId,
        decision,
        brain.now()
      ).pipe(Effect.mapError(fromDurable(Option.some(threadId))));

      if (outcome === "not_found") {
        return yield* failure(
          "approval_not_found",
          Option.some(threadId),
          `Approval ${approvalId} is not on thread ${threadId}. Refresh the thread; it may have been answered elsewhere.`
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

    /** The thread stream within one Session; ends when that Session's watch ends. */
    const watchIn = (
      session: BrainSession,
      threadId: ThreadId,
      seq: Ref.Ref<number>
    ) =>
      Stream.callback<ThreadFrame, HarnessError>((queue) =>
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

          // `cairn.approvals` is not one of pi-durable's built-in view documents; the stream adds it.
          const approvals = yield* Effect.acquireRelease(
            call(
              Option.some(threadId),
              "watch-approvals",
              async (context) =>
                await session.harness.watchDoc(
                  Approvals,
                  conversation.id,
                  context
                )
            ),
            (handle) =>
              Effect.promise(async () => {
                await handle?.stop();
              })
          );

          const projector = wireProjector();

          let latest = watch.value;
          let latestApprovals = approvals?.value ?? null;

          const withApprovals = (): PiConversationView =>
            latestApprovals === null
              ? latest
              : {
                  ...latest,
                  docs: { ...latest.docs, [APPROVALS_KIND]: latestApprovals },
                };

          const view = yield* Effect.fromResult(
            projector.snapshot(withApprovals())
          ).pipe(Effect.mapError(fromWire(Option.some(threadId))));

          const hasMoreHistory = yield* hasOlder(
            threadId,
            conversation,
            watch.value
          );

          yield* Queue.offer(
            queue,
            ThreadSnapshotItem.make({
              seq: yield* Ref.getAndUpdate(seq, (n) => n + 1),
              view,
              entriesOffset: 0,
              hasMoreHistory,
            })
          );

          // The listeners only record the newest revision and ring; a slow subscriber gets one
          // larger diff instead of a backlog.
          const ticks = yield* Queue.sliding<true>(1);

          watch.start(
            handOff((value: PiConversationView) => {
              latest = value;
              Queue.offerUnsafe(ticks, true);
            })
          );

          approvals?.start(
            handOff((value: Readonly<ApprovalsState> | null) => {
              latestApprovals = value;
              Queue.offerUnsafe(ticks, true);
            })
          );

          yield* Queue.take(ticks).pipe(
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const ops = yield* Effect.fromResult(
                  projector.advance(withApprovals())
                ).pipe(Effect.mapError(fromWire(Option.some(threadId))));

                if (ops.length > 0) {
                  yield* Queue.offer(
                    queue,
                    ThreadOpsItem.make({
                      seq: yield* Ref.getAndUpdate(seq, (n) => n + 1),
                      ops,
                    })
                  );
                }
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
        })
      );

    const watchThread = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const seq = yield* Ref.make(0);
          const session = yield* open(Option.some(threadId));

          // An unknown thread fails the subscription at once.
          yield* conversationIdOf(session, threadId);

          return brain.sessions.pipe(
            Stream.switchMap((next) => watchIn(next, threadId, seq))
          );
        })
      );

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
        Effect.mapError((error) =>
          error.closed
            ? fromDurable(Option.none())(error)
            : failure(
                "task_not_found",
                Option.none(),
                `Task ${taskId} is not in the brain. Refresh the thread.`
              )
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
      compact,
      watch: watchThread,
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
