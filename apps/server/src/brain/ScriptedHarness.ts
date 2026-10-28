// An independent, in-memory implementation of the harness seam that plays scripted model answers
// (plan D14, ADR 0024). It is the deterministic backend for UI tests, screenshots and the dev
// client, and the second side the replay conformance suite judges: it shares no code with
// pi-durable's loop, only the seam, the wire projection and the shapes of pi-durable's view (entry
// kinds, `pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`, `cairn.approvals`), so a client cannot tell
// the backends apart.
//
// Semantics it keeps, as the seam's contract states them:
// - A run starts when an input arrives at an idle thread; inputs that arrive while it runs queue as
//   steers (placed after the next tool round) or follow-ups (placed when the answer is final), or
//   are refused with `thread_busy`.
// - A stop ends the run as interrupted and keeps the queue; stop with `clearQueue` withdraws it too.
// - A failed answer ends the run as failed and leaves the queue for the next input.
// - A request id is admitted once per thread. Tools run in call order; a tool may ask for approval.
// - State lives in `ScriptedStore`, which outlives a harness instance: a new instance over the same
//   store is a restart, and resumes an interrupted run by asking the model again.
// - `whenEnsured` subscribes to the events before it looks in the store, so an ensure that lands in
//   between still wakes it.

import { Buffer } from "node:buffer";

import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
  SubmissionId,
  TaskId,
} from "@cairn/protocol/Ids";
import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { ThreadOpsItem, ThreadSnapshotItem } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  ConversationView as PiConversationView,
  EntryRecord,
} from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  PubSub,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import type { ApprovalRecord, ApprovalSettlement } from "./CairnDocs.ts";
import {
  applyAnswer,
  approvalIdOf,
  cancelRecord,
  copyRecord,
  heldByRun,
  refusalText,
  settlementOf,
  UNDECIDED,
} from "./CairnDocs.ts";
import { messageText } from "./CommitFeed.ts";
import {
  CompactionEnded,
  CompactionStarted,
  HarnessError,
  HarnessSeam,
  MessageCommitted,
  QueueChanged,
  RunStarted,
  RunTerminal,
  RuntimeRequestUpdated,
  ThreadEnsured,
} from "./HarnessSeam.ts";
import type {
  ApprovalAnswerInput,
  EnsureThread,
  HarnessEvent,
  RunFailureInfo,
  HarnessTurnInput,
  InputEntry,
  LiveThreadState,
  PassiveEntry,
  ThreadAgentChange,
  ThreadFrame,
} from "./HarnessSeam.ts";
import { piConversationId, piEntryId, piTaskId } from "./PiIds.ts";
import { classifyRunFailure } from "./RunFailure.ts";
import { entryImages, projectEntry, wireProjector } from "./ThreadWire.ts";

type RunStatus = (typeof RunTerminal.Type)["status"];

/** What the scripted model is asked: the thread and its model context. */
export interface ScriptedRequest {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<Message>;
}

/** An answer of the scripted model with only text. */
export const scriptedAnswer = (
  text: string,
  timestamp: number
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "scripted",
  provider: "scripted",
  model: "scripted",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp,
});

/** The scripted model: the next answer for a request. Interrupting the request abandons it. */
export class ScriptedModel extends Context.Service<
  ScriptedModel,
  { answer(request: ScriptedRequest): Effect.Effect<AssistantMessage> }
>()("cairn/server/brain/ScriptedModel") {
  /** Repeats the last user message after a short pause: the dev client's backend. */
  static readonly layerEcho = Layer.succeed(
    ScriptedModel,
    ScriptedModel.of({
      answer: (request) =>
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(400));

          const asked = request.messages.findLast(
            (message) => message.role === "user"
          );

          const now = yield* Clock.currentTimeMillis;

          return scriptedAnswer(
            `You said: ${asked === undefined ? "" : messageText(asked)}`,
            now
          );
        }),
    })
  );
}

/** What a scripted tool may ask of the harness. */
export interface ScriptedToolApi {
  /** Records an approval for this call (once; a rerun finds it) and waits for its settlement. */
  ask(summary: string): Effect.Effect<ApprovalSettlement>;
}

/** The result a scripted tool gives the model. */
export interface ScriptedToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/** The tools a scripted model may call. */
export class ScriptedTools extends Context.Service<
  ScriptedTools,
  {
    run(
      call: ToolCall,
      api: ScriptedToolApi
    ): Effect.Effect<ScriptedToolResult>;
  }
>()("cairn/server/brain/ScriptedTools") {
  /** `echo` returns its `text`; any other tool fails as unknown. */
  static readonly layerEcho = Layer.succeed(
    ScriptedTools,
    ScriptedTools.of({
      run: (call) => {
        const { text } = call.arguments;

        return Effect.succeed(
          call.name === "echo"
            ? { text: Predicate.isString(text) ? text : "", isError: false }
            : { text: `Tool ${call.name} not found`, isError: true }
        );
      },
    })
  );
}

interface QueuedInput {
  readonly submissionId: number;
  readonly mode: "steer" | "followUp";
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly entry: Option.Option<InputEntry>;
}

interface Submission {
  readonly id: number;
  status: "queued" | "placed" | "done" | "unanswered";
}

interface Run {
  /** The run's id: the first task id it got. */
  readonly runId: number;
  readonly inputs: Array<number>;
}

interface Agent {
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  cwd: string;
}

/** One thread as the scripted store keeps it. */
interface ScriptedThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly conversationId: number;
  agent: Agent;
  readonly entries: Array<EntryRecord>;
  /** Index into `entries` where the active range starts (after a compaction). */
  head: number;
  readonly queue: Array<QueuedInput>;
  readonly byRequest: Map<string, Submission>;
  /** Request ids of passive entries already written. */
  readonly writes: Set<string>;
  readonly byId: Map<number, Submission>;
  run: Option.Option<Run>;
  readonly approvals: Map<string, ApprovalRecord>;
  /** Tool call id to the task id its approval is keyed by, so a rerun finds its record. */
  readonly toolTasks: Map<string, number>;
  usage: { input: number; output: number };
}

/** Everything a scripted harness remembers; it outlives one instance, as a store does. */
export class ScriptedStore extends Context.Service<
  ScriptedStore,
  {
    readonly threads: Map<ThreadId, ScriptedThread>;
    readonly ids: { next: number };
  }
>()("cairn/server/brain/ScriptedStore") {
  static readonly layer = Layer.sync(ScriptedStore, () =>
    ScriptedStore.of({ threads: new Map(), ids: { next: 1 } })
  );
}

const failure = (
  reason: HarnessError["reason"],
  threadId: ThreadId,
  message: string
) =>
  new HarnessError({
    message,
    reason,
    retryable: false,
    threadId: Option.some(threadId),
  });

const queuedItems = (thread: ScriptedThread) =>
  thread.queue.map((item): JsonValue => {
    const queued = {
      id: item.submissionId,
      mode: item.mode,
      content: copyJson(item.content),
    };

    return Option.match(item.entry, {
      onNone: () => queued,
      onSome: (entry) => ({
        ...queued,
        entry: { kind: entry.kind, data: entry.data },
      }),
    });
  });

const approvalItems = (thread: ScriptedThread) => {
  const items: { [key: string]: JsonValue } = {};

  for (const [id, record] of thread.approvals) {
    items[id] = { ...record };
  }

  return items;
};

/** The thread's view in pi-durable's shape: active entries and the visible documents. */
const viewOf = (thread: ScriptedThread): PiConversationView => {
  const docs = {
    "pi.agent": {
      model: { ...thread.agent.model },
      thinkingLevel: thread.agent.thinkingLevel,
      cwd: thread.agent.cwd,
    },
    "pi.live": Option.match(thread.run, {
      onNone: () => ({}),
      onSome: (run) => ({
        run: { taskId: run.runId, inputs: [...run.inputs] },
      }),
    }),
    "pi.inbox": { items: queuedItems(thread) },
    "pi.usage": {
      models: {
        [`${thread.agent.model.provider}/${thread.agent.model.modelId}`]: {
          input: thread.usage.input,
          output: thread.usage.output,
        },
      },
      tools: {},
    },
  };

  return {
    conversation: {
      id: piConversationId(ConversationId.make(thread.conversationId)),
    },
    entries: thread.entries.slice(thread.head),
    docs:
      thread.approvals.size > 0
        ? { ...docs, "cairn.approvals": { items: approvalItems(thread) } }
        : docs,
  };
};

/** The model context: the active entries' messages, in order. */
const contextOf = (thread: ScriptedThread): ReadonlyArray<Message> =>
  thread.entries.slice(thread.head).flatMap((entry) => entry.model ?? []);

/** Tool calls of the newest answer that have no result yet. */
const pendingCalls = (thread: ScriptedThread): ReadonlyArray<ToolCall> => {
  const active = thread.entries.slice(thread.head);
  const lastAnswer = active.findLast((entry) => entry.kind === "pi.assistant");
  const message = lastAnswer?.model?.[0];

  if (lastAnswer === undefined || message?.role !== "assistant") {
    return [];
  }

  const answered = new Set(
    active
      .filter(
        (entry) => entry.id > lastAnswer.id && entry.kind === "pi.tool-result"
      )
      .flatMap((entry) => entry.model ?? [])
      .flatMap((result) =>
        result.role === "toolResult" ? [result.toolCallId] : []
      )
  );

  return message.content.flatMap((part) =>
    part.type === "toolCall" && !answered.has(part.id) ? [part] : []
  );
};

/** Starts the runs a restart interrupted; boot calls it once its subscribers are in place. */
export class ScriptedBoot extends Context.Service<
  ScriptedBoot,
  { readonly resume: Effect.Effect<void> }
>()("cairn/server/brain/ScriptedBoot") {}

const queueChanged = (thread: ScriptedThread) =>
  QueueChanged.make({
    threadId: thread.threadId,
    length: thread.queue.length,
  });

/** Ends the run, settling its inputs, in the calling critical section. */
const endRun = (
  thread: ScriptedThread,
  status: RunStatus,
  failureInfo: Option.Option<RunFailureInfo>,
  at: number
): ReadonlyArray<HarnessEvent> => {
  if (Option.isNone(thread.run)) {
    return [];
  }

  const run = thread.run.value;

  for (const id of run.inputs) {
    const submission = thread.byId.get(id);

    if (submission !== undefined) {
      submission.status = status === "completed" ? "done" : "unanswered";
    }
  }

  thread.run = Option.none();

  return [
    RunTerminal.make({
      threadId: thread.threadId,
      runId: RunId.make(run.runId),
      status,
      failure: failureInfo,
      at: DateTime.makeUnsafe(at),
    }),
  ];
};

/** The scripted harness over a store, a model and tools. */
const layerNoDeps = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* ScriptedStore;
    const model = yield* ScriptedModel;
    const tools = yield* ScriptedTools;
    const events = yield* PubSub.unbounded<HarnessEvent>();
    // One mutation at a time, as pi-durable's Session line.
    const line = yield* Semaphore.make(1);

    const revisions = new Map<
      ThreadId,
      SubscriptionRef.SubscriptionRef<PiConversationView>
    >();

    const runs = new Map<ThreadId, Fiber.Fiber<void>>();
    const scope = yield* Effect.scope;

    const nextId = () => {
      const id = store.ids.next;

      store.ids.next += 1;

      return id;
    };

    const now = Clock.currentTimeMillis;

    const revision = Effect.fn("ScriptedHarness.revision")(function* (
      thread: ScriptedThread
    ) {
      const existing = revisions.get(thread.threadId);

      if (existing !== undefined) {
        return existing;
      }

      const created = yield* SubscriptionRef.make(viewOf(thread));

      revisions.set(thread.threadId, created);

      return created;
    });

    const publish = Effect.fn("ScriptedHarness.publish")(function* (
      thread: ScriptedThread,
      emitted: ReadonlyArray<HarnessEvent>
    ) {
      const ref = yield* revision(thread);

      yield* SubscriptionRef.set(ref, viewOf(thread));
      yield* PubSub.publishAll(events, emitted);
    });

    const find = (threadId: ThreadId) =>
      Effect.fromNullishOr(store.threads.get(threadId)).pipe(
        Effect.mapError(() =>
          failure(
            "thread_not_found",
            threadId,
            `Thread ${threadId} does not exist in the scripted store. Launch it before sending to it.`
          )
        )
      );

    const appendEntry = (
      thread: ScriptedThread,
      kind: string,
      fields: Omit<EntryRecord, "id" | "conversationId" | "kind">
    ) => {
      const entry: EntryRecord = {
        id: piEntryId(EntryId.make(nextId())),
        conversationId: piConversationId(
          ConversationId.make(thread.conversationId)
        ),
        kind,
        ...fields,
      };

      thread.entries.push(entry);

      return entry;
    };

    /** Places one input as an entry; returns the events it causes. */
    const place = (
      thread: ScriptedThread,
      input: QueuedInput,
      at: number
    ): ReadonlyArray<HarnessEvent> => {
      const message: Message = {
        role: "user",
        content: [...input.content],
        timestamp: at,
      };

      const entry = Option.match(input.entry, {
        onNone: () => appendEntry(thread, "pi.user", { model: [message] }),
        onSome: (custom) =>
          appendEntry(thread, custom.kind, {
            model: [message],
            data: custom.data,
          }),
      });

      const submission = thread.byId.get(input.submissionId);

      if (submission !== undefined) {
        submission.status = "placed";
      }

      if (Option.isSome(thread.run)) {
        thread.run.value.inputs.push(input.submissionId);
      }

      return [
        MessageCommitted.make({
          threadId: thread.threadId,
          entryId: EntryId.make(entry.id),
          role: "user",
          text: messageText(message),
          at: DateTime.makeUnsafe(at),
        }),
      ];
    };

    const toolApi = (
      thread: ScriptedThread,
      call: ToolCall
    ): ScriptedToolApi => ({
      ask: (summary) =>
        Effect.gen(function* () {
          const taskId =
            thread.toolTasks.get(call.id) ??
            (() => {
              const id = nextId();

              thread.toolTasks.set(call.id, id);

              return id;
            })();

          const approvalId = approvalIdOf(taskId);

          yield* line.withPermits(1)(
            Effect.gen(function* () {
              if (thread.approvals.has(approvalId)) {
                return;
              }

              const askedAt = yield* now;

              thread.approvals.set(approvalId, {
                id: approvalId,
                toolTaskId: taskId,
                tool: call.name,
                kind: "tool-call",
                summary,
                status: "pending",
                askedAt,
                expiresAt: askedAt + 86_400_000,
                answeredAt: null,
                run: null,
                executorRequestId: null,
                ...UNDECIDED,
              });

              yield* publish(thread, [
                RuntimeRequestUpdated.make({
                  threadId: thread.threadId,
                  id: ApprovalId.make(approvalId),
                  kind: "tool-call",
                  status: "pending",
                }),
              ]);
            })
          );

          const ref = yield* revision(thread);

          const settled = yield* SubscriptionRef.changes(ref).pipe(
            Stream.map(() => thread.approvals.get(approvalId)),
            Stream.filter(Predicate.isNotUndefined),
            Stream.filter((record) => record.status !== "pending"),
            Stream.runHead
          );

          return Option.match(settled, {
            onNone: (): ApprovalSettlement => ({
              status: "cancelled",
              decidedBy: Option.none(),
              reason: Option.none(),
            }),
            onSome: settlementOf,
          });
        }),
    });

    /** One run: answers, tool rounds and boundaries until the answer is final and nothing waits. */
    const runLoop = (thread: ScriptedThread): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (Option.isSome(thread.run)) {
          const calls = pendingCalls(thread);

          if (calls.length > 0) {
            for (const call of calls) {
              const result = yield* tools.run(call, toolApi(thread, call));

              yield* line.withPermits(1)(
                Effect.gen(function* () {
                  const at = yield* now;

                  appendEntry(thread, "pi.tool-result", {
                    model: [
                      {
                        role: "toolResult",
                        toolCallId: call.id,
                        toolName: call.name,
                        content: [{ type: "text", text: result.text }],
                        isError: result.isError,
                        timestamp: at,
                      },
                    ],
                    data: { diagnostics: [] },
                  });
                  yield* publish(thread, []);
                })
              );
            }

            // After the tool round: queued steers enter before the next request.
            yield* line.withPermits(1)(
              Effect.gen(function* () {
                const at = yield* now;

                const steerIndex = thread.queue.findIndex(
                  (item) => item.mode === "steer"
                );

                if (steerIndex === -1) {
                  return;
                }

                const [steer] = thread.queue.splice(steerIndex, 1);

                if (steer !== undefined) {
                  yield* publish(thread, [
                    ...place(thread, steer, at),
                    queueChanged(thread),
                  ]);
                }
              })
            );

            continue;
          }

          const answer = yield* model.answer({
            threadId: thread.threadId,
            messages: contextOf(thread),
          });

          yield* line.withPermits(1)(
            Effect.gen(function* () {
              const at = yield* now;

              const entry = appendEntry(thread, "pi.assistant", {
                model: [answer],
              });

              thread.usage = {
                input: thread.usage.input + answer.usage.input,
                output: thread.usage.output + answer.usage.output,
              };

              const emitted: Array<HarnessEvent> = [
                MessageCommitted.make({
                  threadId: thread.threadId,
                  entryId: EntryId.make(entry.id),
                  role: "assistant",
                  text: messageText(answer),
                  at: DateTime.makeUnsafe(answer.timestamp),
                }),
              ];

              if (
                answer.stopReason === "error" ||
                answer.stopReason === "aborted"
              ) {
                emitted.push(
                  ...endRun(
                    thread,
                    answer.stopReason === "error" ? "failed" : "interrupted",
                    answer.stopReason === "error"
                      ? Option.some(
                          classifyRunFailure({
                            message: answer.errorMessage ?? "",
                            reason: Option.some("model_error"),
                          })
                        )
                      : Option.none(),
                    at
                  )
                );

                return yield* publish(thread, emitted);
              }

              if (pendingCalls(thread).length > 0) {
                return yield* publish(thread, emitted);
              }

              // A final answer: the next queued input (a steer first) continues the run.
              const nextIndex = Math.max(
                thread.queue.findIndex((item) => item.mode === "steer"),
                0
              );

              const [next] =
                thread.queue.length > 0
                  ? thread.queue.splice(nextIndex, 1)
                  : [];

              if (next === undefined) {
                emitted.push(...endRun(thread, "completed", Option.none(), at));

                return yield* publish(thread, emitted);
              }

              emitted.push(...place(thread, next, at), queueChanged(thread));

              return yield* publish(thread, emitted);
            })
          );
        }
      });

    const startRun = (thread: ScriptedThread) =>
      Effect.gen(function* () {
        const fiber = yield* runLoop(thread).pipe(
          Effect.ensuring(Effect.sync(() => runs.delete(thread.threadId))),
          Effect.forkIn(scope)
        );

        runs.set(thread.threadId, fiber);
      });

    // After a restart, runs the store left in progress ask the model again, once resumed.
    const resume = Effect.forEach(
      [...store.threads.values()].filter(
        (thread) => Option.isSome(thread.run) && !runs.has(thread.threadId)
      ),
      startRun,
      { discard: true }
    );

    const ensureThread = Effect.fn("ScriptedHarness.ensureThread")(function* (
      input: EnsureThread
    ) {
      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          const existing = store.threads.get(input.threadId);

          if (existing !== undefined) {
            return {
              threadId: input.threadId,
              conversationId: ConversationId.make(existing.conversationId),
              created: false,
            };
          }

          const thread: ScriptedThread = {
            threadId: input.threadId,
            projectId: input.projectId,
            conversationId: nextId(),
            agent: {
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              cwd: input.cwd,
            },
            entries: [],
            head: 0,
            queue: [],
            byRequest: new Map(),
            writes: new Set(),
            byId: new Map(),
            run: Option.none(),
            approvals: new Map(),
            toolTasks: new Map(),
            usage: { input: 0, output: 0 },
          };

          store.threads.set(input.threadId, thread);

          const conversationId = ConversationId.make(thread.conversationId);

          yield* publish(thread, [
            ThreadEnsured.make({ threadId: input.threadId, conversationId }),
          ]);

          return { threadId: input.threadId, conversationId, created: true };
        })
      );
    });

    const configure = Effect.fn("ScriptedHarness.configure")(function* (
      threadId: ThreadId,
      change: ThreadAgentChange
    ) {
      const thread = yield* find(threadId);

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          if (Option.isSome(change.cwd) && Option.isSome(thread.run)) {
            return yield* failure(
              "invalid_input",
              threadId,
              `Thread ${threadId} is running, so its folder cannot change now. Stop it or wait, then change the folder.`
            );
          }

          thread.agent = {
            model: Option.getOrElse(change.model, () => thread.agent.model),
            thinkingLevel: Option.getOrElse(
              change.thinkingLevel,
              () => thread.agent.thinkingLevel
            ),
            cwd: Option.getOrElse(change.cwd, () => thread.agent.cwd),
          };

          return yield* publish(thread, []);
        })
      );
    });

    const submit = Effect.fn("ScriptedHarness.submit")(function* (
      threadId: ThreadId,
      input: HarnessTurnInput
    ) {
      const thread = yield* find(threadId);

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          const existing = thread.byRequest.get(input.requestId);

          if (existing !== undefined) {
            return {
              submissionId: SubmissionId.make(existing.id),
              status: existing.status,
            };
          }

          const busy = Option.isSome(thread.run);

          if (busy && input.whenBusy === "reject") {
            return yield* failure(
              "thread_busy",
              threadId,
              "The thread is running and the input asked not to queue. Send it again when the run ends, or let it queue."
            );
          }

          const submission: Submission = { id: nextId(), status: "queued" };

          thread.byRequest.set(input.requestId, submission);
          thread.byId.set(submission.id, submission);

          const queued: QueuedInput = {
            submissionId: submission.id,
            mode: input.whenBusy === "steer" ? "steer" : "followUp",
            content: input.content,
            entry: input.entry,
          };

          const at = yield* now;

          if (busy) {
            thread.queue.push(queued);
            yield* publish(thread, [queueChanged(thread)]);

            return {
              submissionId: SubmissionId.make(submission.id),
              status: submission.status,
            };
          }

          // Idle: a run starts and takes the oldest queued input first (a failed run left them).
          thread.queue.push(queued);

          const [first] = thread.queue.splice(0, 1);
          const runId = nextId();

          thread.run = Option.some({ runId, inputs: [] });

          const emitted: Array<HarnessEvent> = [
            RunStarted.make({
              threadId,
              runId: RunId.make(runId),
              at: DateTime.makeUnsafe(at),
            }),
          ];

          if (first !== undefined) {
            emitted.push(...place(thread, first, at), queueChanged(thread));
          }

          yield* publish(thread, emitted);
          yield* startRun(thread);

          return {
            submissionId: SubmissionId.make(submission.id),
            status: submission.status,
          };
        })
      );
    });

    const stop = Effect.fn("ScriptedHarness.stop")(function* (
      threadId: ThreadId,
      options: { readonly clearQueue: boolean }
    ) {
      const thread = yield* find(threadId);
      const fiber = runs.get(threadId);

      if (fiber !== undefined) {
        yield* Fiber.interrupt(fiber);
      }

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* now;
          const emitted: Array<HarnessEvent> = [];

          if (options.clearQueue) {
            for (const item of thread.queue.splice(0)) {
              const submission = thread.byId.get(item.submissionId);

              if (submission !== undefined) {
                submission.status = "unanswered";
              }
            }

            emitted.push(queueChanged(thread));
          }

          const held = Option.isSome(thread.run)
            ? [...thread.approvals.values()].filter(heldByRun)
            : [];

          emitted.push(...endRun(thread, "interrupted", Option.none(), at));

          // The run's tools waited on these; nobody can answer them now (ADR 0029).
          for (const record of held) {
            const cancelled = copyRecord(record);

            cancelRecord(cancelled, at);
            thread.approvals.set(cancelled.id, cancelled);
            emitted.push(
              RuntimeRequestUpdated.make({
                threadId,
                id: ApprovalId.make(cancelled.id),
                kind: cancelled.kind,
                status: cancelled.status,
              })
            );
          }

          return yield* publish(thread, emitted);
        })
      );
    });

    const withdraw = Effect.fn("ScriptedHarness.withdraw")(function* (
      threadId: ThreadId,
      submissionId: SubmissionId
    ) {
      const thread = yield* find(threadId);

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          const submission = thread.byId.get(submissionId);

          if (submission === undefined) {
            return yield* failure(
              "submission_not_found",
              threadId,
              `Input ${submissionId} is not queued on thread ${threadId}. Refresh the thread and try again.`
            );
          }

          const index = thread.queue.findIndex(
            (item) => item.submissionId === submissionId
          );

          if (index === -1) {
            return { withdrawn: false };
          }

          thread.queue.splice(index, 1);
          submission.status = "unanswered";
          yield* publish(thread, [queueChanged(thread)]);

          return { withdrawn: true };
        })
      );
    });

    const respond = Effect.fn("ScriptedHarness.respond")(function* (
      threadId: ThreadId,
      approvalId: ApprovalId,
      answer: ApprovalAnswerInput
    ) {
      const thread = yield* find(threadId);

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          const record = thread.approvals.get(approvalId);

          if (record === undefined) {
            return yield* failure(
              "approval_not_found",
              threadId,
              `Approval ${approvalId} is not on thread ${threadId}. Refresh the thread; it may have been answered elsewhere.`
            );
          }

          const answered = copyRecord(record);

          const outcome = applyAnswer(
            answered,
            { ...answer, by: { kind: "user" } },
            yield* now
          );

          const refused = refusalText(outcome, approvalId);

          if (Option.isSome(refused)) {
            return yield* failure("invalid_input", threadId, refused.value);
          }

          if (outcome !== "answered") {
            return yield* Effect.void;
          }

          thread.approvals.set(approvalId, answered);

          return yield* publish(thread, [
            RuntimeRequestUpdated.make({
              threadId,
              id: approvalId,
              kind: answered.kind,
              status: answered.status,
            }),
          ]);
        })
      );
    });

    const write = Effect.fn("ScriptedHarness.write")(function* (
      threadId: ThreadId,
      entry: PassiveEntry
    ) {
      const thread = yield* find(threadId);

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          if (!thread.writes.has(entry.requestId)) {
            thread.writes.add(entry.requestId);
            appendEntry(thread, entry.kind, { data: entry.data });
            yield* publish(thread, []);
          }
        })
      );
    });

    const compact = Effect.fn("ScriptedHarness.compact")(function* (
      threadId: ThreadId,
      _instructions: Option.Option<string>
    ) {
      const thread = yield* find(threadId);
      const taskId = TaskId.make(nextId());

      yield* PubSub.publish(
        events,
        CompactionStarted.make({ threadId, taskId })
      );

      const summary = yield* model.answer({
        threadId,
        messages: contextOf(thread),
      });

      return yield* line.withPermits(1)(
        Effect.gen(function* () {
          const at = yield* now;
          const kept = thread.entries.at(-1);

          const entry = appendEntry(thread, "pi.compaction", {
            model: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<summary>\n${messageText(summary)}\n</summary>`,
                  },
                ],
                timestamp: at,
              },
            ],
            data: { reason: "manual" },
          });

          // The view starts at the summary and keeps the newest entry verbatim, as pi-durable's does.
          const withHead: EntryRecord =
            kept === undefined ? entry : { ...entry, head: kept.id };

          thread.entries.pop();
          thread.entries.push(withHead);

          if (kept !== undefined) {
            thread.entries.splice(thread.entries.indexOf(kept), 1);
            thread.entries.push(kept);
          }

          thread.head = thread.entries.indexOf(withHead);

          return yield* publish(thread, [
            CompactionEnded.make({ threadId, taskId, failed: false }),
          ]);
        })
      );
    });

    const watch = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const thread = yield* find(threadId);
          const ref = yield* revision(thread);
          const projector = wireProjector();
          const seq = yield* Ref.make(0);

          return SubscriptionRef.changes(ref).pipe(
            Stream.mapEffect((view) =>
              Effect.gen(function* () {
                const next = yield* Ref.getAndUpdate(seq, (n) => n + 1);

                if (next === 0) {
                  const snapshot = yield* Effect.fromResult(
                    projector.snapshot(view)
                  );

                  return Option.some<ThreadFrame>(
                    ThreadSnapshotItem.make({
                      seq: next,
                      view: snapshot,
                      entriesOffset: 0,
                      hasMoreHistory: thread.head > 0,
                    })
                  );
                }

                const ops = yield* Effect.fromResult(projector.advance(view));

                return ops.length === 0
                  ? Option.none<ThreadFrame>()
                  : Option.some<ThreadFrame>(
                      ThreadOpsItem.make({ seq: next, ops })
                    );
              }).pipe(
                Effect.mapError((cause) =>
                  failure("internal", threadId, cause.message)
                )
              )
            ),
            Stream.filter(Option.isSome),
            Stream.map((frame) => frame.value)
          );
        })
      );

    const whenEnsured = Effect.fn("ScriptedHarness.whenEnsured")(function* (
      threadId: ThreadId
    ) {
      const wake = yield* PubSub.subscribe(events);

      if (store.threads.has(threadId)) {
        return;
      }

      yield* PubSub.take(wake).pipe(
        Effect.repeat({
          until: (event) =>
            Predicate.isTagged(event, "ThreadEnsured") &&
            event.threadId === threadId,
        })
      );
    }, Effect.scoped);

    const history = Effect.fn("ScriptedHarness.history")(function* (
      threadId: ThreadId,
      query: { readonly before: EntryId; readonly limit: number }
    ) {
      const thread = yield* find(threadId);
      const older = thread.entries.filter((entry) => entry.id < query.before);
      const kept = older.slice(-query.limit);

      const entries = yield* Effect.forEach(kept, (entry) =>
        Effect.fromResult(projectEntry(entry, "stream")).pipe(
          Effect.mapError((cause) =>
            failure("internal", threadId, cause.message)
          )
        )
      );

      return { entries, hasMore: older.length > kept.length };
    });

    const findEntry = (threadId: ThreadId, entryId: EntryId) =>
      Effect.flatMap(find(threadId), (thread) =>
        Effect.fromNullishOr(
          thread.entries.find((entry) => entry.id === piEntryId(entryId))
        ).pipe(
          Effect.mapError(() =>
            failure(
              "entry_not_found",
              threadId,
              `Entry ${entryId} is not in thread ${threadId}.`
            )
          )
        )
      );

    const entry = Effect.fn("ScriptedHarness.entry")(function* (
      threadId: ThreadId,
      entryId: EntryId
    ) {
      const found = yield* findEntry(threadId, entryId);

      const projected = yield* Effect.fromResult(
        projectEntry(found, "full")
      ).pipe(
        Effect.mapError((cause) => failure("internal", threadId, cause.message))
      );

      return { entry: projected, truncated: false };
    });

    const entryImage = Effect.fn("ScriptedHarness.entryImage")(function* (
      threadId: ThreadId,
      entryId: EntryId,
      index: number
    ) {
      const found = yield* findEntry(threadId, entryId);

      const image = entryImages(found)[index];

      if (image === undefined) {
        return yield* failure(
          "entry_not_found",
          threadId,
          `Entry ${entryId} has no image ${index}.`
        );
      }

      return {
        mimeType: image.mimeType,
        bytes: Uint8Array.from(Buffer.from(image.data, "base64")),
      };
    });

    const inspect = Effect.sync(() => {
      const states: Array<LiveThreadState> = [];

      for (const thread of store.threads.values()) {
        const pending = [...thread.approvals.values()].flatMap((record) =>
          record.status === "pending" ? [ApprovalId.make(record.id)] : []
        );

        if (
          Option.isSome(thread.run) ||
          thread.queue.length > 0 ||
          pending.length > 0
        ) {
          states.push({
            threadId: thread.threadId,
            conversationId: ConversationId.make(thread.conversationId),
            runId: Option.map(thread.run, (run) => RunId.make(run.runId)),
            queueLength: thread.queue.length,
            parkedTaskIds: [],
            pendingApprovals: pending,
          });
        }
      }

      return states;
    });

    const seam = HarnessSeam.of({
      ensureThread,
      configure,
      submit,
      stop,
      withdraw,
      respond,
      write,
      compact,
      watch,
      whenEnsured,
      history,
      entry,
      entryImage,
      events: Stream.fromPubSub(events),
      inspect,
      // Nothing parks in a scripted store.
      retry: (taskId) =>
        Effect.fail(
          new HarnessError({
            message: `Task ${taskId} is not parked; the scripted harness parks nothing.`,
            reason: "task_not_found",
            retryable: false,
            threadId: Option.none(),
          })
        ),
      capabilities: { durable: true, live: false },
    });

    return Context.make(HarnessSeam, seam).pipe(
      Context.add(ScriptedBoot, ScriptedBoot.of({ resume }))
    );
  })
);

/** The scripted harness: `layerNoDeps` over a given store, model and tools; `layer` for dev. */
export const ScriptedHarness = {
  layerNoDeps,
  /** An echoing model and an `echo` tool over a fresh store: the dev client's backend. */
  layer: Layer.effectDiscard(ScriptedBoot.use((boot) => boot.resume)).pipe(
    Layer.provideMerge(layerNoDeps),
    Layer.provide(ScriptedStore.layer),
    Layer.provide(ScriptedModel.layerEcho),
    Layer.provide(ScriptedTools.layerEcho)
  ),
};

/** Internal ids exposed for tests that need a pi-durable task id. */
export const scriptedTaskId = (id: number) => piTaskId(TaskId.make(id));
