// The harness events of every thread, from pi-durable's commit publications (plan D15). One
// `subscribeCommits` listener covers every conversation in the store; it only enqueues, because
// pi-durable calls it synchronously after each commit and it must not block or call back in. A
// fiber turns each publication into Cairn's events, in commit order:
//
// - `cairn.thread-meta` set: ThreadEnsured (the creating commit of a thread).
// - `pi.live.run` appears: RunStarted; it goes away: RunTerminal, with the outcome of the run's
//   last generation task (a run hands over between generation tasks, one per model request, so
//   the run is `pi.live.run`, not one task), its failure classified.
// - `pi.compaction` task created and terminal: CompactionStarted and CompactionEnded.
// - `pi.user`, `cairn.user` and `pi.assistant` entries: MessageCommitted.
// - `pi.inbox` changes: QueueChanged when the number of queued inputs changed.
// - `cairn.approvals` changes: RuntimeRequestUpdated for each record whose status changed.
// - `pi.usage` changes: UsageUpdated with the conversation's token totals.
//
// Conversations that are not threads (subagents later) produce no events. After a reopen the feed
// subscribes to the new Session; events never replay, so the shell projector reconciles at boot.

import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { ApprovalStatus, RuntimeRequestKind } from "@cairn/protocol/Policy";
import type { JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type {
  CommitChange,
  CommitPublication,
  ConversationId as PiConversationId,
  EntryRecord,
  JsonObject,
  TaskRecord,
} from "@earendil-works/pi-durable";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";

import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import { ThreadMeta } from "./CairnDocs.ts";
import { durable } from "./Durable.ts";
import {
  CompactionEnded,
  CompactionStarted,
  MessageCommitted,
  QueueChanged,
  RunStarted,
  RunTerminal,
  RuntimeRequestUpdated,
  ThreadEnsured,
  UsageUpdated,
} from "./HarnessSeam.ts";
import type { HarnessEvent, RunFailureInfo } from "./HarnessSeam.ts";
import { classifyRunFailure } from "./RunFailure.ts";

/** The run task: one per run, settling the inputs it answers. */
export const RUN_TASK = "pi.generation";

/** The compaction task. */
export const COMPACTION_TASK = "pi.compaction";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const decodeApprovalId = Schema.decodeUnknownOption(ApprovalId);

const decodeApprovalStatus = Schema.decodeUnknownOption(ApprovalStatus);

const decodeRequestKind = Schema.decodeUnknownOption(RuntimeRequestKind);

/** The text a message shows: its text blocks, joined. Thinking and tool calls are left out. */
export const messageText = (message: Message): string => {
  if (message.role === "user") {
    if (Predicate.isString(message.content)) {
      return message.content;
    }

    return message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
  }

  if (message.role === "assistant") {
    return message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
  }

  return "";
};

const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

const entryRole = (entry: EntryRecord): Option.Option<"user" | "assistant"> => {
  if (USER_KINDS.has(entry.kind)) {
    return Option.some("user");
  }

  return entry.kind === "pi.assistant"
    ? Option.some("assistant")
    : Option.none();
};

/** What the feed remembers between publications, per conversation. */
interface FeedState {
  /** Conversation to thread; none for a conversation that is not a thread. */
  readonly threads: Map<PiConversationId, Option.Option<ThreadId>>;
  /** The run each busy conversation is in: its first task, and the task now leading it. */
  readonly runs: Map<
    PiConversationId,
    { readonly runId: number; lastTaskId: number }
  >;
  readonly startedCompactions: Set<number>;
  readonly queueLengths: Map<PiConversationId, number>;
  readonly approvals: Map<string, string>;
}

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const queuedInputs = (value: JsonObject | null) => {
  const items = value?.items;

  return Array.isArray(items)
    ? items.filter((item) => isRecord(item) && item.mode !== "write").length
    : 0;
};

const usageTotals = (value: JsonObject | null) => {
  let input = 0;
  let output = 0;
  const models = value?.models;

  if (isRecord(models)) {
    for (const usage of Object.values(models)) {
      if (isRecord(usage)) {
        input += Number(usage.input ?? 0);
        output += Number(usage.output ?? 0);
      }
    }
  }

  return { input, output };
};

const timeOf = (millis: number) => DateTime.makeUnsafe(millis);

type RunStatus = (typeof RunTerminal.Type)["status"];

const isRunEnd = Predicate.isTagged("RunTerminal");

const isRunStart = Predicate.isTagged("RunStarted");

/** The events of one task change. */
const taskEvents = (
  state: FeedState,
  threadId: ThreadId,
  task: TaskRecord<JsonValue, JsonValue, JsonValue>
): Array<HarnessEvent> => {
  const events: Array<HarnessEvent> = [];

  if (task.kind === COMPACTION_TASK) {
    if (!state.startedCompactions.has(task.id)) {
      state.startedCompactions.add(task.id);
      events.push(
        CompactionStarted.make({ threadId, taskId: TaskId.make(task.id) })
      );
    }

    if (task.state.status === "terminal") {
      state.startedCompactions.delete(task.id);
      events.push(
        CompactionEnded.make({
          threadId,
          taskId: TaskId.make(task.id),
          failed: task.state.outcome.status !== "completed",
        })
      );
    }
  }

  return events;
};

type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** How a run ended, from the terminal record of the task that ended it. */
const runEnd = (
  state: FeedState,
  threadId: ThreadId,
  run: { readonly runId: number; readonly lastTaskId: number },
  ended: Option.Option<AnyTask>,
  now: number
) => {
  let status: RunStatus = "completed";
  let failure = Option.none<RunFailureInfo>();
  let at = now;

  if (Option.isSome(ended) && ended.value.state.status === "terminal") {
    const { outcome } = ended.value.state;

    at = ended.value.endedAt ?? now;

    if (outcome.status === "aborted") {
      status = "interrupted";
    } else if (outcome.status !== "completed") {
      const detail = outcome.error?.detail;

      const reason =
        isRecord(detail) && Predicate.isString(detail.reason)
          ? Option.some(detail.reason)
          : Option.none<string>();

      status = "failed";
      failure = Option.some(
        classifyRunFailure({
          message: outcome.error?.message ?? outcome.reason ?? "",
          reason,
        })
      );
    }
  }

  return RunTerminal.make({
    threadId,
    runId: RunId.make(run.runId),
    status,
    failure,
    at: timeOf(at),
  });
};

/** RunStarted and RunTerminal from one `pi.live` change. */
const liveEvents = (
  state: FeedState,
  threadId: ThreadId,
  conversationId: PiConversationId,
  value: JsonObject | null,
  terminal: ReadonlyMap<number, AnyTask>,
  now: number
): Array<HarnessEvent> => {
  const run = value?.run;
  const current = state.runs.get(conversationId);

  const taskId =
    isRecord(run) && Predicate.isNumber(run.taskId)
      ? Option.some(run.taskId)
      : Option.none<number>();

  if (Option.isSome(taskId)) {
    if (current === undefined) {
      state.runs.set(conversationId, {
        runId: taskId.value,
        lastTaskId: taskId.value,
      });

      return [
        RunStarted.make({
          threadId,
          runId: RunId.make(taskId.value),
          at: timeOf(now),
        }),
      ];
    }

    current.lastTaskId = taskId.value;

    return [];
  }

  if (current === undefined) {
    // A run this feed never saw start (it was running when the Session opened) ends with its
    // last generation task.
    const last = [...terminal.values()].findLast(
      (task) => task.conversationId === conversationId
    );

    return last === undefined
      ? []
      : [
          runEnd(
            state,
            threadId,
            { runId: last.id, lastTaskId: last.id },
            Option.some(last),
            now
          ),
        ];
  }

  state.runs.delete(conversationId);

  const ended = Option.orElse(
    Option.fromUndefinedOr(terminal.get(current.lastTaskId)),
    () =>
      Option.fromUndefinedOr(
        [...terminal.values()].findLast(
          (task) => task.conversationId === conversationId
        )
      )
  );

  return [runEnd(state, threadId, current, ended, now)];
};

/** The events of one document change. */
const documentEvents = (
  state: FeedState,
  threadId: ThreadId,
  conversationId: PiConversationId,
  change: Extract<CommitChange, { readonly type: "document" }>,
  terminal: ReadonlyMap<number, AnyTask>,
  now: number
): Array<HarnessEvent> => {
  const { kind } = change.record;

  if (kind === "pi.live") {
    return liveEvents(
      state,
      threadId,
      conversationId,
      change.value,
      terminal,
      now
    );
  }

  if (kind === "pi.inbox") {
    const length = queuedInputs(change.value);

    if (state.queueLengths.get(conversationId) === length) {
      return [];
    }

    state.queueLengths.set(conversationId, length);

    return [QueueChanged.make({ threadId, length })];
  }

  if (kind === "pi.usage") {
    const totals = usageTotals(change.value);

    return [
      UsageUpdated.make({
        threadId,
        inputTokens: totals.input,
        outputTokens: totals.output,
      }),
    ];
  }

  if (kind === "cairn.approvals" && isRecord(change.value?.items)) {
    const events: Array<HarnessEvent> = [];

    for (const record of Object.values(change.value.items)) {
      if (isRecord(record)) {
        const id = decodeApprovalId(record.id);
        const status = decodeApprovalStatus(record.status);
        const requestKind = decodeRequestKind(record.kind);

        if (
          Option.isSome(id) &&
          Option.isSome(status) &&
          Option.isSome(requestKind) &&
          state.approvals.get(id.value) !== status.value
        ) {
          state.approvals.set(id.value, status.value);
          events.push(
            RuntimeRequestUpdated.make({
              threadId,
              id: id.value,
              kind: requestKind.value,
              status: status.value,
            })
          );
        }
      }
    }

    return events;
  }

  return [];
};

/** The conversation a change belongs to. */
const conversationOf = (
  change: CommitChange
): Option.Option<PiConversationId> => {
  if (change.type === "conversation") {
    return Option.some(change.value.id);
  }

  if (change.type === "document") {
    return Option.fromUndefinedOr(change.conversationId);
  }

  if (change.type === "document.copy") {
    return Option.some(change.conversationId);
  }

  return Option.some(change.value.conversationId);
};

/** Every harness event of one publication, in a fixed order. */
const publicationEvents = (
  state: FeedState,
  publication: CommitPublication,
  now: number
): Array<HarnessEvent> => {
  const ensured: Array<HarnessEvent> = [];
  const runs: Array<HarnessEvent> = [];
  const messages: Array<HarnessEvent> = [];
  const documents: Array<HarnessEvent> = [];

  // Generation tasks this commit ended, for the run that ends with them.
  const terminal = new Map<number, AnyTask>();

  for (const change of publication.changes) {
    if (
      change.type === "task" &&
      change.value.kind === RUN_TASK &&
      change.value.state.status === "terminal"
    ) {
      terminal.set(change.value.id, change.value);
    }
  }

  // Thread metadata first, so the rest of this commit can name its thread.
  for (const change of publication.changes) {
    if (
      change.type === "document" &&
      change.record.kind === ThreadMeta.definition.kind &&
      change.conversationId !== undefined
    ) {
      const threadId = decodeThreadId(change.value?.threadId);

      if (Option.isSome(threadId)) {
        state.threads.set(change.conversationId, threadId);
        ensured.push(
          ThreadEnsured.make({
            threadId: threadId.value,
            conversationId: ConversationId.make(change.conversationId),
          })
        );
      }
    }
  }

  for (const change of publication.changes) {
    const threadId = Option.flatten(
      Option.flatMap(conversationOf(change), (id) =>
        Option.fromUndefinedOr(state.threads.get(id))
      )
    );

    if (Option.isNone(threadId)) {
      continue;
    }

    if (change.type === "task") {
      runs.push(...taskEvents(state, threadId.value, change.value));
    } else if (change.type === "entry") {
      const { value: entry } = change;
      const role = entryRole(entry);
      const message = entry.model?.[0];

      if (Option.isSome(role) && message !== undefined) {
        messages.push(
          MessageCommitted.make({
            threadId: threadId.value,
            entryId: EntryId.make(entry.id),
            role: role.value,
            text: messageText(message),
            at: timeOf(message.timestamp),
          })
        );
      }
    } else if (
      change.type === "document" &&
      change.conversationId !== undefined
    ) {
      documents.push(
        ...documentEvents(
          state,
          threadId.value,
          change.conversationId,
          change,
          terminal,
          now
        )
      );
    }
  }

  // A run's start precedes its messages; its end follows them.
  const all = [...runs, ...documents];
  const starts = all.filter(isRunStart);
  const ends = all.filter(isRunEnd);
  const rest = all.filter((event) => !isRunStart(event) && !isRunEnd(event));

  return [...ensured, ...starts, ...messages, ...rest, ...ends];
};

/** Harness events of every thread, from the commits of whichever Session is open. */
export class CommitFeed extends Context.Service<
  CommitFeed,
  {
    /** Events committed after the subscriber joined. */
    readonly events: Stream.Stream<HarnessEvent>;
  }
>()("cairn/server/brain/CommitFeed") {
  static readonly layerNoDeps = Layer.effect(
    CommitFeed,
    Effect.gen(function* () {
      const brain = yield* Brain;
      const hub = yield* PubSub.unbounded<HarnessEvent>();

      const inbox = yield* Queue.unbounded<{
        readonly session: BrainSession;
        readonly publication: CommitPublication;
      }>();

      const state: FeedState = {
        threads: new Map(),
        runs: new Map(),
        startedCompactions: new Set(),
        queueLengths: new Map(),
        approvals: new Map(),
      };

      // Conversations this commit names that the feed has not met: read their metadata first.
      const learn = Effect.fn("CommitFeed.learn")(function* (
        session: BrainSession,
        publication: CommitPublication
      ) {
        const unknown = new Set<PiConversationId>();

        for (const change of publication.changes) {
          const id = conversationOf(change);

          if (Option.isSome(id) && !state.threads.has(id.value)) {
            unknown.add(id.value);
          }
        }

        yield* Effect.forEach(
          unknown,
          (id) =>
            durable(
              "thread-meta.read",
              async (context) =>
                await session.harness.snapshot(ThreadMeta, id, context)
            ).pipe(
              Effect.map((meta) =>
                Option.flatMap(Option.fromUndefinedOr(meta), (found) =>
                  decodeThreadId(found.threadId)
                )
              ),
              Effect.orElseSucceed(() => Option.none<ThreadId>()),
              Effect.tap((threadId) =>
                Effect.sync(() => {
                  // Only a thread's id is final; a conversation seen before its metadata is asked again.
                  if (Option.isSome(threadId)) {
                    state.threads.set(id, threadId);
                  }
                })
              )
            ),
          { discard: true }
        );
      });

      yield* Queue.take(inbox).pipe(
        Effect.flatMap(({ session, publication }) =>
          Effect.gen(function* () {
            yield* learn(session, publication);

            const events = publicationEvents(state, publication, brain.now());

            yield* PubSub.publishAll(hub, events);
          })
        ),
        Effect.forever,
        Effect.forkScoped
      );

      // One listener per Session; a reopened Session gets a new one.
      yield* brain.sessions.pipe(
        Stream.runForEach((session) =>
          Effect.sync(() => {
            session.harness.subscribeCommits((publication) => {
              Queue.offerUnsafe(inbox, { session, publication });
            });
          })
        ),
        Effect.forkScoped
      );

      return CommitFeed.of({ events: Stream.fromPubSub(hub) });
    })
  );
}
