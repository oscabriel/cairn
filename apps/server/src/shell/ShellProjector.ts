// How pi-durable's state reaches the sidebar. The shell projector folds the harness events of every
// thread (and the projector signals from outside pi-durable) into the derived fields of each thread
// row, and commits them as `thread.activity-updated` commands through the event sink. Derived fields
// are recomputed, never replayed: at boot, `reconcile` reads `inspect()` and the rows, so an event
// lost to a crash (the feed never replays across a restart) cannot leave a row wrong.
//
// Rules:
// - One fiber consumes the events; one lock serializes applying an event, flushing a thread and
//   reconciling, so a flush never reads a row another flush is still writing.
// - At most one commit per thread per 50 ms window (the first change in a quiet thread commits at
//   once, later ones wait for the window to close), and only when the patch differs from the row.
// - A thread's state is loaded from its row when an event first touches it and dropped after the
//   flush. The projection remembers which fields its events set; a flush rebases those on the row
//   as it stands then and recomputes `activity` over the result, so a field another writer changed
//   in the meantime (a launch marking `idle` or `failed`) is never overwritten from a stale copy.
//
// The field mapping follows notes/server.md, "Shell store and the projector".
//
// For the durability judge only: `CAIRN_JUDGE_HOLD_PROJECTOR_MS` makes the projector log
// `projector_holding` and wait that long before committing a run's end, so a `kill -9` can land
// after pi-durable committed the run and before the shell did. Unset, nothing waits.

import { isAddedUserPart } from "@cairn/protocol/Attachments";
import type { ApprovalId, TaskId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import type {
  LatestVisibleMessage,
  PendingRuntimeRequest,
  RunFailureClass,
  ThreadActivity,
} from "@cairn/protocol/Shell";
import type { ConversationView } from "@cairn/protocol/Thread";
import {
  Array as Arr,
  Clock,
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { Equivalence } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type {
  HarnessError,
  HarnessEvent,
  LiveThreadState,
  RunFailureInfo,
} from "../brain/HarnessSeam.ts";
import { EventSink } from "./EventSink.ts";
import { ProjectorSignals } from "./ProjectorSignals.ts";
import type { ProjectorSignal } from "./ProjectorSignals.ts";
import { emptyActivityPatch, ThreadActivityUpdate } from "./ShellCommands.ts";
import type { ThreadActivityPatch } from "./ShellCommands.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";
import { isLiveThread, ThreadRows } from "./ThreadRows.ts";

/** The debounce window: at most one activity commit per thread inside it. */
export const PROJECTOR_WINDOW = Duration.millis(50);

/** How long a flush the store refused waits before it tries again. */
const FLUSH_RETRY_DELAY = Duration.seconds(1);

/** The longest preview text a row holds (`DisplayText`). */
const PREVIEW_LIMIT = 4096;

/** The row fields the projector derives from pi-durable and the projector signals. */
export type DerivedFields = Pick<
  ThreadShell,
  | "activity"
  | "activeRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "queueLength"
  | "lastError"
  | "lastErrorClass"
  | "usageLimitResetAt"
  | "waitingFor"
  | "pendingRuntimeRequest"
  | "pendingCount"
  | "latestVisibleMessage"
  | "latestUserMessageAt"
  | "parkedTaskIds"
>;

/** How the newest run this projection saw ended. */
export type RunOutcome = "completed" | "interrupted" | "failed";

/** One thread as the projector folds it: the derived fields and what they are computed from. */
export interface ThreadProjection {
  /** The derived fields; `activity` is the row's until `activityOf` recomputes it. */
  readonly fields: DerivedFields;
  /** The fields events set since the projection was loaded; a flush writes only these. */
  readonly changed: Partial<DerivedFields>;
  /** How the newest run ended, when one ended since the projection was loaded. */
  readonly outcome: Option.Option<RunOutcome>;
  /** Every pending approval, oldest first; the row shows the first and counts them (`pendingCount`). */
  readonly approvals: ReadonlyArray<PendingRuntimeRequest>;
}

/** What `lastError` says for each failure class; the harness event carries the class, not the text. */
export const FAILURE_TEXT: Readonly<Record<RunFailureClass, string>> = {
  usage_limit:
    "The model plan's usage limit was reached. The thread can run again when the limit resets.",
  provider_error:
    "The model provider refused the request. Send again to retry.",
  transport_error:
    "The model provider could not be reached. Send again to retry.",
  unknown: "The run failed. Send again to retry.",
};

const BUSY: ReadonlySet<ThreadActivity> = new Set([
  "running",
  "waiting",
  "parked",
]);

/** A thread's projection as its row stands. */
export const projectionOf = (
  shell: ThreadShell,
  approvals: Option.Option<ReadonlyArray<PendingRuntimeRequest>> = Option.none()
): ThreadProjection => ({
  fields: {
    activity: shell.activity,
    activeRunId: shell.activeRunId,
    latestRunRequestedAt: shell.latestRunRequestedAt,
    latestRunStartedAt: shell.latestRunStartedAt,
    latestRunCompletedAt: shell.latestRunCompletedAt,
    queueLength: shell.queueLength,
    lastError: shell.lastError,
    lastErrorClass: shell.lastErrorClass,
    usageLimitResetAt: shell.usageLimitResetAt,
    waitingFor: shell.waitingFor,
    pendingRuntimeRequest: shell.pendingRuntimeRequest,
    pendingCount: shell.pendingCount,
    latestVisibleMessage: shell.latestVisibleMessage,
    latestUserMessageAt: shell.latestUserMessageAt,
    parkedTaskIds: shell.parkedTaskIds,
  },
  changed: {},
  outcome: Option.none(),
  approvals: Option.getOrElse(approvals, () =>
    Option.toArray(shell.pendingRuntimeRequest)
  ),
});

/**
 * The activity the fields mean: parked over everything, then a live run (waiting while an approval
 * is pending), then how the newest run ended; with none of those, a busy row has gone idle and any
 * other row (idle, preparing, failed) keeps its activity.
 */
export const activityOf = (projection: ThreadProjection): ThreadActivity => {
  const { fields, outcome } = projection;

  if (fields.parkedTaskIds.length > 0) {
    return "parked";
  }

  if (Option.isSome(fields.activeRunId)) {
    return Option.isSome(fields.pendingRuntimeRequest) ? "waiting" : "running";
  }

  if (Option.isSome(outcome)) {
    return outcome.value === "failed" ? "failed" : "idle";
  }

  return BUSY.has(fields.activity) ? "idle" : fields.activity;
};

const withFields = (
  projection: ThreadProjection,
  changes: Partial<DerivedFields>
): ThreadProjection => {
  const next = {
    ...projection,
    fields: { ...projection.fields, ...changes },
    changed: { ...projection.changed, ...changes },
  };

  return { ...next, fields: { ...next.fields, activity: activityOf(next) } };
};

const withApprovals = (
  projection: ThreadProjection,
  approvals: ReadonlyArray<PendingRuntimeRequest>
): ThreadProjection =>
  withFields(
    { ...projection, approvals },
    {
      pendingRuntimeRequest: Option.fromUndefinedOr(approvals[0]),
      pendingCount: approvals.length,
    }
  );

const preview = (text: string) => text.slice(0, PREVIEW_LIMIT);

const isLater = (
  candidate: DateTime.Utc,
  current: Option.Option<DateTime.Utc>
) =>
  Option.match(current, {
    onNone: () => true,
    onSome: (time) => DateTime.isGreaterThanOrEqualTo(candidate, time),
  });

const failureFields = (
  projection: ThreadProjection,
  failure: Option.Option<RunFailureInfo>
): Partial<DerivedFields> => {
  const info = Option.getOrElse(failure, () => ({
    class: "unknown" as const,
    retryable: false,
    resetAt: Option.none<DateTime.Utc>(),
    plan: Option.none(),
  }));

  return {
    lastError: Option.some(FAILURE_TEXT[info.class]),
    lastErrorClass: Option.some(info.class),
    usageLimitResetAt: Option.orElse(
      info.resetAt,
      () => projection.fields.usageLimitResetAt
    ),
  };
};

/** One harness event folded into a thread's projection; `now` dates a newly pending approval. */
export const applyHarnessEvent = (
  projection: ThreadProjection,
  event: HarnessEvent,
  now: DateTime.Utc
): ThreadProjection =>
  Match.valueTags(event, {
    ThreadEnsured: () => projection,
    // A parent's tally of its children is derived at the row's next reconcile.
    SubagentUpdated: () => projection,
    RunStarted: (started) =>
      withFields(
        { ...projection, outcome: Option.none() },
        {
          activeRunId: Option.some(started.runId),
          latestRunStartedAt: Option.some(started.at),
          latestRunRequestedAt: isLater(
            started.at,
            projection.fields.latestRunRequestedAt
          )
            ? Option.some(started.at)
            : projection.fields.latestRunRequestedAt,
          lastError: Option.none(),
          lastErrorClass: Option.none(),
          usageLimitResetAt: Option.none(),
        }
      ),
    RunTerminal: (ended) => {
      const errorFields =
        ended.status === "failed"
          ? failureFields(projection, ended.failure)
          : {
              lastError: Option.none(),
              lastErrorClass: Option.none(),
              usageLimitResetAt: projection.fields.usageLimitResetAt,
            };

      return withFields(
        { ...projection, outcome: Option.some(ended.status) },
        {
          activeRunId: Option.none(),
          latestRunCompletedAt: Option.some(ended.at),
          waitingFor: "none",
          ...errorFields,
        }
      );
    },
    MessageCommitted: (message) =>
      withFields(projection, {
        latestVisibleMessage: Option.some({
          entryId: message.entryId,
          role: message.role,
          text: preview(message.text),
          at: message.at,
        }),
        latestUserMessageAt:
          message.role === "user"
            ? Option.some(message.at)
            : projection.fields.latestUserMessageAt,
        latestRunRequestedAt:
          message.role === "user"
            ? Option.some(message.at)
            : projection.fields.latestRunRequestedAt,
      }),
    QueueChanged: (queue) =>
      withFields(projection, { queueLength: queue.length }),
    RuntimeRequestUpdated: (update) => {
      const others = projection.approvals.filter(
        (approval) => approval.id !== update.id
      );

      if (update.status !== "pending") {
        return withApprovals(projection, others);
      }

      return projection.approvals.some((approval) => approval.id === update.id)
        ? projection
        : withApprovals(projection, [
            ...projection.approvals,
            {
              id: update.id,
              kind: update.kind,
              createdAt: now,
              origin: Option.none(),
            },
          ]);
    },
    UsageUpdated: () => projection,
    TaskParked: (parked) =>
      projection.fields.parkedTaskIds.includes(parked.taskId)
        ? projection
        : withFields(projection, {
            parkedTaskIds: [...projection.fields.parkedTaskIds, parked.taskId],
          }),
    CompactionStarted: () => projection,
    CompactionEnded: () => projection,
  });

/** One projector signal folded in: a none leaves the field alone. */
export const applySignal = (
  projection: ThreadProjection,
  signal: ProjectorSignal
): ThreadProjection =>
  withFields(projection, {
    waitingFor: Option.getOrElse(
      signal.patch.waitingFor,
      () => projection.fields.waitingFor
    ),
    usageLimitResetAt: Option.getOrElse(
      signal.patch.usageLimitResetAt,
      () => projection.fields.usageLimitResetAt
    ),
  });

/**
 * A thread's projection set from what pi-durable holds now. `live` is the thread's entry in
 * `inspect()`; none means no run, no queue, no approval and no parked task. A row that was busy
 * with no live run left ends now: the run ended while nothing watched it. An approval the row does
 * not name yet is shown as a tool call, because `inspect()` carries only its id.
 */
export const reconcileProjection = (
  projection: ThreadProjection,
  live: Option.Option<LiveThreadState>,
  now: DateTime.Utc
): ThreadProjection => {
  const { fields } = projection;

  const runId = Option.flatMap(live, (state) => state.runId);

  const pendingIds = Option.match(live, {
    onNone: (): ReadonlyArray<ApprovalId> => [],
    onSome: (state) => state.pendingApprovals,
  });

  const known = new Map(
    projection.approvals.map((approval) => [approval.id, approval])
  );

  const approvals = pendingIds.map(
    (id): PendingRuntimeRequest =>
      known.get(id) ?? {
        id,
        kind: "tool-call",
        createdAt: now,
        origin: Option.none(),
      }
  );

  const endedUnseen =
    Option.isNone(runId) &&
    (BUSY.has(fields.activity) || Option.isSome(fields.activeRunId));

  return withApprovals(
    withFields(
      { ...projection, outcome: Option.none() },
      {
        activeRunId: runId,
        queueLength: Option.match(live, {
          onNone: () => 0,
          onSome: (state) => state.queueLength,
        }),
        parkedTaskIds: Option.match(live, {
          onNone: (): ReadonlyArray<TaskId> => [],
          onSome: (state) => state.parkedTaskIds,
        }),
        waitingFor: "none",
        latestRunCompletedAt: endedUnseen
          ? Option.some(now)
          : fields.latestRunCompletedAt,
      }
    ),
    approvals
  );
};

const { fields: shellFields } = ThreadShell;

const same = {
  activity: Schema.toEquivalence(shellFields.activity),
  activeRunId: Schema.toEquivalence(shellFields.activeRunId),
  time: Schema.toEquivalence(shellFields.latestRunStartedAt),
  queueLength: Schema.toEquivalence(shellFields.queueLength),
  lastError: Schema.toEquivalence(shellFields.lastError),
  lastErrorClass: Schema.toEquivalence(shellFields.lastErrorClass),
  waitingFor: Schema.toEquivalence(shellFields.waitingFor),
  pendingRuntimeRequest: Schema.toEquivalence(
    shellFields.pendingRuntimeRequest
  ),
  pendingCount: Schema.toEquivalence(shellFields.pendingCount),
  latestVisibleMessage: Schema.toEquivalence(shellFields.latestVisibleMessage),
  parkedTaskIds: Schema.toEquivalence(shellFields.parkedTaskIds),
};

const diff = <A>(
  equivalent: Equivalence.Equivalence<A>,
  before: A,
  after: A
): Option.Option<A> =>
  equivalent(before, after) ? Option.none() : Option.some(after);

/**
 * The projection rebased on `row` as it stands now: the fields its events set laid over the row's,
 * and `activity` recomputed over them. A projection that set nothing is the row unchanged.
 */
export const rebase = (
  row: ThreadShell,
  projection: ThreadProjection
): ThreadProjection => {
  const fresh = projectionOf(row, Option.some(projection.approvals));

  if (Object.keys(projection.changed).length === 0) {
    return fresh;
  }

  const rebased: ThreadProjection = {
    ...projection,
    fields: { ...fresh.fields, ...projection.changed, activity: row.activity },
  };

  return {
    ...rebased,
    fields: { ...rebased.fields, activity: activityOf(rebased) },
  };
};

/** The patch that brings `row` to the projection's fields; none when nothing differs. */
export const patchFor = (
  row: ThreadShell,
  projection: ThreadProjection
): Option.Option<ThreadActivityPatch> => {
  const { fields } = projection;

  const patch: ThreadActivityPatch = {
    ...emptyActivityPatch,
    activity: diff(same.activity, row.activity, fields.activity),
    activeRunId: diff(same.activeRunId, row.activeRunId, fields.activeRunId),
    latestRunRequestedAt: diff(
      same.time,
      row.latestRunRequestedAt,
      fields.latestRunRequestedAt
    ),
    latestRunStartedAt: diff(
      same.time,
      row.latestRunStartedAt,
      fields.latestRunStartedAt
    ),
    latestRunCompletedAt: diff(
      same.time,
      row.latestRunCompletedAt,
      fields.latestRunCompletedAt
    ),
    queueLength: diff(same.queueLength, row.queueLength, fields.queueLength),
    lastError: diff(same.lastError, row.lastError, fields.lastError),
    lastErrorClass: diff(
      same.lastErrorClass,
      row.lastErrorClass,
      fields.lastErrorClass
    ),
    usageLimitResetAt: diff(
      same.time,
      row.usageLimitResetAt,
      fields.usageLimitResetAt
    ),
    waitingFor: diff(same.waitingFor, row.waitingFor, fields.waitingFor),
    pendingRuntimeRequest: diff(
      same.pendingRuntimeRequest,
      row.pendingRuntimeRequest,
      fields.pendingRuntimeRequest
    ),
    pendingCount: diff(
      same.pendingCount,
      row.pendingCount,
      fields.pendingCount
    ),
    latestVisibleMessage: diff(
      same.latestVisibleMessage,
      row.latestVisibleMessage,
      fields.latestVisibleMessage
    ),
    latestUserMessageAt: diff(
      same.time,
      row.latestUserMessageAt,
      fields.latestUserMessageAt
    ),
    parkedTaskIds: diff(
      same.parkedTaskIds,
      row.parkedTaskIds,
      fields.parkedTaskIds
    ),
  };

  const changes: ReadonlyArray<boolean> = [
    Option.isSome(patch.activity),
    Option.isSome(patch.activeRunId),
    Option.isSome(patch.latestRunRequestedAt),
    Option.isSome(patch.latestRunStartedAt),
    Option.isSome(patch.latestRunCompletedAt),
    Option.isSome(patch.queueLength),
    Option.isSome(patch.lastError),
    Option.isSome(patch.lastErrorClass),
    Option.isSome(patch.usageLimitResetAt),
    Option.isSome(patch.waitingFor),
    Option.isSome(patch.pendingRuntimeRequest),
    Option.isSome(patch.pendingCount),
    Option.isSome(patch.latestVisibleMessage),
    Option.isSome(patch.latestUserMessageAt),
    Option.isSome(patch.parkedTaskIds),
  ];

  return changes.includes(true) ? Option.some(patch) : Option.none();
};

// The newest message of a projected view, for the boot reconcile. Entries are pi-durable's JSON;
// only the fields the preview needs are read.
const PreviewMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Union([
    Schema.String,
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optionalKey(Schema.String),
      })
    ),
  ]),
  timestamp: Schema.Finite,
});

const decodePreviewMessage = Schema.decodeUnknownOption(PreviewMessage);

const MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "pi.user",
  "cairn.user",
  "pi.assistant",
]);

/** The newest user or assistant message in a projected view, as the sidebar previews it. */
export const latestMessageOf = (
  view: ConversationView
): Option.Option<LatestVisibleMessage> => {
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index];

    if (entry !== undefined && MESSAGE_KINDS.has(entry.kind)) {
      const message = decodePreviewMessage(entry.model?.[0]);

      if (Option.isSome(message)) {
        const { content, role, timestamp } = message.value;

        // A user turn's attachment parts are the brain's, not the user's words.
        const text = Schema.is(Schema.String)(content)
          ? content
          : content
              .flatMap((part) =>
                part.type === "text" &&
                part.text !== undefined &&
                !(role === "user" && isAddedUserPart(part.text))
                  ? [part.text]
                  : []
              )
              .join(role === "user" ? "\n\n" : "");

        return Option.some({
          entryId: entry.id,
          role,
          text: preview(text),
          at: DateTime.makeUnsafe(timestamp),
        });
      }
    }
  }

  return Option.none();
};

/** What one boot reconcile did. */
export interface ReconcileReport {
  /** Thread rows read. */
  readonly threads: number;
  /** Threads `inspect()` named as busy, queued, waiting or parked. */
  readonly live: number;
  /** Rows the reconcile changed. */
  readonly patched: number;
}

const readFailed = (failure: ShellStoreError) =>
  Effect.logWarning("projector could not read a thread row").pipe(
    Effect.annotateLogs({
      event: "projector_read_failed",
      error: failure.message,
    })
  );

const emptyReport: ReconcileReport = { threads: 0, live: 0, patched: 0 };

const failedReconcile =
  (operation: string) => (failure: HarnessError | ShellStoreError) =>
    Effect.logError("projector reconcile failed").pipe(
      Effect.annotateLogs({
        event: "projector_reconcile_failed",
        operation,
        error: failure.message,
      }),
      Effect.as(emptyReport)
    );

/** Keeps every thread row's derived fields equal to what pi-durable holds. */
export class ShellProjector extends Context.Service<
  ShellProjector,
  {
    /**
     * Recomputes every row from `inspect()` and the rows themselves: the boot reconcile. Failures
     * are logged and reported as zero changes; boot goes on.
     */
    readonly reconcile: Effect.Effect<ReconcileReport>;
    /** Recomputes one thread's run, queue, approvals and parked tasks now, as after a retry. */
    refresh(threadId: ThreadId): Effect.Effect<void>;
    /** Commits every pending change now, ignoring the window. */
    readonly flushAll: Effect.Effect<void>;
  }
>()("cairn/server/shell/ShellProjector") {
  /**
   * Subscribes to the harness events and projector signals while the layer builds (before boot
   * resumes the harness), and consumes them for the layer's lifetime. Needs the harness seam, the
   * shell store (`EventSink`, `ThreadRows`) and `ProjectorSignals` from the composition root.
   */
  static readonly layer = Layer.effect(
    ShellProjector,
    Effect.gen(function* () {
      const harness = yield* HarnessSeam;
      const sink = yield* EventSink;
      const rows = yield* ThreadRows;
      const signals = yield* ProjectorSignals;
      const scope = yield* Effect.scope;

      const lock = yield* Semaphore.make(1);

      const hold = yield* Config.option(
        Config.Int("CAIRN_JUDGE_HOLD_PROJECTOR_MS")
      ).pipe(Effect.orElseSucceed(() => Option.none<number>()));

      /** Threads touched since their last flush. */
      const pending = new Map<ThreadId, ThreadProjection>();

      /** Threads whose parked tasks must be checked against `inspect()` at the next flush. */
      const parkedCheck = new Set<ThreadId>();
      /** Threads with a flush scheduled. */
      const scheduled = new Set<ThreadId>();
      /** When each thread last committed, in clock millis. */
      const lastCommit = new Map<ThreadId, number>();

      /** Pending approvals beyond the one the row shows, kept across flushes. */
      const approvalMemory = new Map<
        ThreadId,
        ReadonlyArray<PendingRuntimeRequest>
      >();

      const loadRow = (threadId: ThreadId) =>
        rows
          .get(threadId)
          .pipe(
            Effect.map(Option.filter((row) => Option.isNone(row.deletedAt)))
          );

      /** The thread's pending projection, else one loaded from its row; none for a missing row. */
      const load = Effect.fnUntraced(function* (threadId: ThreadId) {
        const held = pending.get(threadId);

        if (held !== undefined) {
          return Option.some(held);
        }

        const row = yield* loadRow(threadId);

        return Option.map(row, (found) =>
          projectionOf(
            found.shell,
            Option.fromUndefinedOr(approvalMemory.get(threadId))
          )
        );
      });

      const inspectLive = harness.inspect.pipe(
        Effect.map(
          (states) =>
            new Map(states.map((state) => [state.threadId, state] as const))
        )
      );

      const commit = Effect.fnUntraced(function* (
        threadId: ThreadId,
        patch: ThreadActivityPatch
      ) {
        yield* sink.commitCommand(
          ThreadActivityUpdate.make({
            commandId: yield* sink.mintCommandId,
            threadId,
            patch,
          })
        );
        lastCommit.set(threadId, yield* Clock.currentTimeMillis);
      });

      /** Writes one projection to its row when it differs. Returns whether it committed. */
      const write = Effect.fnUntraced(function* (
        threadId: ThreadId,
        projection: ThreadProjection
      ) {
        approvalMemory.set(threadId, projection.approvals);

        const row = yield* loadRow(threadId);

        if (Option.isNone(row)) {
          return false;
        }

        const patch = patchFor(
          row.value.shell,
          rebase(row.value.shell, projection)
        );

        if (Option.isNone(patch)) {
          return false;
        }

        yield* commit(threadId, patch.value);

        return true;
      });

      const ignoreRejection = <A>(
        effect: Effect.Effect<
          A,
          ShellStoreError | Effect.Error<ReturnType<typeof sink.commitCommand>>
        >,
        fallback: A
      ) =>
        effect.pipe(
          Effect.catchTags({
            ShellTargetNotFound: () => Effect.succeed(fallback),
            ProjectWorkspaceConflictError: () => Effect.succeed(fallback),
            ShellCommandInvalid: () => Effect.succeed(fallback),
            ShellCommandConflict: () => Effect.succeed(fallback),
          })
        );

      // Leaves `scheduled` alone: only the retry loop in `schedule` owns it, so a flush from
      // `flushAll` cannot make `schedule` fork a second loop for the same thread (T15).
      const flushUnlocked = Effect.fnUntraced(function* (threadId: ThreadId) {
        const held = pending.get(threadId);

        if (held === undefined) {
          return false;
        }

        pending.delete(threadId);

        let projection = held;

        if (parkedCheck.has(threadId)) {
          parkedCheck.delete(threadId);

          const live = yield* inspectLive.pipe(
            Effect.asSome,
            Effect.catchTag("HarnessError", (failure: HarnessError) =>
              Effect.logWarning(
                "projector could not inspect parked tasks"
              ).pipe(
                Effect.annotateLogs({
                  event: "projector_inspect_failed",
                  error: failure.message,
                }),
                Effect.as(Option.none())
              )
            )
          );

          if (Option.isSome(live)) {
            const parked = Option.match(
              Option.fromUndefinedOr(live.value.get(threadId)),
              {
                onNone: (): ReadonlyArray<TaskId> => [],
                onSome: (state) => state.parkedTaskIds,
              }
            );

            projection = withFields(projection, { parkedTaskIds: parked });
          }
        }

        if (Option.isSome(hold) && Option.isSome(projection.outcome)) {
          yield* Effect.logInfo("projector holding").pipe(
            Effect.annotateLogs({ event: "projector_holding", threadId })
          );
          yield* Effect.sleep(Duration.millis(hold.value));
        }

        // True when the store failed and the flush must run again.
        return yield* ignoreRejection(write(threadId, projection), false).pipe(
          Effect.as(false),
          Effect.catchTag("ShellStoreError", (failure) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("projector commit failed").pipe(
                Effect.annotateLogs({
                  event: "projector_commit_failed",
                  threadId,
                  error: failure.message,
                })
              );

              if (!pending.has(threadId)) {
                pending.set(threadId, projection);
              }

              return true;
            })
          )
        );
      });

      /**
       * Runs the thread's flush after `delay`, unless one is already scheduled, and again every
       * second while the store refuses it.
       */
      const schedule = (
        threadId: ThreadId,
        delay: Duration.Duration
      ): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (scheduled.has(threadId)) {
            return Effect.void;
          }

          scheduled.add(threadId);

          return Effect.gen(function* () {
            let wait = delay;

            while (true) {
              if (!Duration.isZero(wait)) {
                yield* Effect.sleep(wait);
              }

              const retry = yield* lock.withPermits(1)(
                Effect.suspend(() => {
                  scheduled.delete(threadId);

                  return flushUnlocked(threadId);
                })
              );

              if (!retry) {
                return;
              }

              scheduled.add(threadId);
              wait = FLUSH_RETRY_DELAY;
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("projector flush failed").pipe(
                Effect.annotateLogs({
                  event: "projector_flush_failed",
                  threadId,
                  cause: String(cause),
                }),
                Effect.andThen(
                  Effect.sync(() => {
                    scheduled.delete(threadId);
                  })
                )
              )
            ),
            Effect.forkIn(scope),
            Effect.asVoid
          );
        });

      /** Schedules a flush at the end of the thread's window, or at once in a quiet thread. */
      const touch = Effect.fnUntraced(function* (threadId: ThreadId) {
        const now = yield* Clock.currentTimeMillis;
        const last = lastCommit.get(threadId);
        const windowMillis = Duration.toMillis(PROJECTOR_WINDOW);

        const delay =
          last === undefined ? 0 : Math.max(0, last + windowMillis - now);

        yield* schedule(threadId, Duration.millis(delay));
      });

      const update = Effect.fnUntraced(function* (
        threadId: ThreadId,
        apply: (projection: ThreadProjection) => ThreadProjection,
        checkParked: boolean
      ) {
        const loaded = yield* load(threadId);

        if (Option.isNone(loaded)) {
          return;
        }

        const next = apply(loaded.value);

        pending.set(threadId, next);

        if (checkParked && next.fields.parkedTaskIds.length > 0) {
          parkedCheck.add(threadId);
        }

        yield* touch(threadId);
      });

      const onEvent = (event: HarnessEvent) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;

          yield* update(
            event.threadId,
            (projection) => applyHarnessEvent(projection, event, now),
            // A parked task leaves no event when it is retried; any later event of its thread
            // checks the parked list against the brain.
            !Predicate.isTagged(event, "TaskParked")
          );
        }).pipe(
          Effect.catchTag("ShellStoreError", readFailed),
          lock.withPermits(1)
        );

      const onSignal = (signal: ProjectorSignal) =>
        update(
          signal.threadId,
          (projection) => applySignal(projection, signal),
          false
        ).pipe(
          Effect.catchTag("ShellStoreError", readFailed),
          lock.withPermits(1)
        );

      // One pass over the threads pending now: a failed flush puts its thread back in `pending`,
      // and walking the live map would meet it again, forever while the store refuses (T15).
      // `schedule` owns the retries.
      const flushAllUnlocked = Effect.gen(function* () {
        for (const threadId of Arr.fromIterable(pending.keys())) {
          if (yield* flushUnlocked(threadId)) {
            yield* schedule(threadId, FLUSH_RETRY_DELAY);
          }
        }
      });

      /** The newest message of a thread whose row may have missed it, from a fresh snapshot. */
      const latestMessage = (threadId: ThreadId) =>
        harness.watch(threadId).pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.map((frame) =>
            Option.flatMap(frame, (item) =>
              Predicate.isTagged(item, "Snapshot")
                ? latestMessageOf(item.view)
                : Option.none()
            )
          ),
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => Option.none<LatestVisibleMessage>())
        );

      const reconcileThreads = Effect.fnUntraced(function* (
        only: Option.Option<ThreadId>,
        withMessages: boolean
      ) {
        yield* flushAllUnlocked;

        const live = yield* inspectLive;
        const now = yield* DateTime.now;

        const all = Option.match(only, {
          onNone: () => rows.listLive,
          onSome: (threadId) =>
            Effect.map(rows.get(threadId), (row) =>
              Option.toArray(Option.filter(row, isLiveThread))
            ),
        });

        const targets = yield* all;
        let patched = 0;

        for (const row of targets) {
          const threadId = row.shell.id;
          const state = Option.fromUndefinedOr(live.get(threadId));

          const before = projectionOf(
            row.shell,
            Option.fromUndefinedOr(approvalMemory.get(threadId))
          );

          let projection = reconcileProjection(before, state, now);

          const mayHaveMissed =
            BUSY.has(row.shell.activity) || Option.isSome(state);

          if (withMessages && mayHaveMissed) {
            const message = yield* latestMessage(threadId);

            if (Option.isSome(message)) {
              projection = withFields(projection, {
                latestVisibleMessage: message,
                latestUserMessageAt:
                  message.value.role === "user"
                    ? Option.some(message.value.at)
                    : projection.fields.latestUserMessageAt,
              });
            }
          }

          const wrote = yield* ignoreRejection(
            write(threadId, projection),
            false
          );

          patched += wrote ? 1 : 0;
        }

        return { threads: targets.length, live: live.size, patched };
      });

      const reconcile = reconcileThreads(Option.none(), true).pipe(
        Effect.catchTags({
          HarnessError: failedReconcile("reconcile"),
          ShellStoreError: failedReconcile("reconcile"),
        }),
        lock.withPermits(1),
        Effect.withSpan("ShellProjector.reconcile")
      );

      const refresh = Effect.fn("ShellProjector.refresh")(
        function* (threadId: ThreadId) {
          yield* reconcileThreads(Option.some(threadId), false);
        },
        Effect.catchTags({
          HarnessError: failedReconcile("refresh"),
          ShellStoreError: failedReconcile("refresh"),
        }),
        Effect.asVoid,
        lock.withPermits(1)
      );

      // Started at once, so each subscription exists before boot resumes the harness. A stream
      // that merges others subscribes from fibers of its own, so give those a turn as well.
      yield* Stream.runForEach(harness.events, onEvent).pipe(
        Effect.forkScoped({ startImmediately: true })
      );
      yield* Stream.runForEach(signals.signals, onSignal).pipe(
        Effect.forkScoped({ startImmediately: true })
      );
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      return ShellProjector.of({
        reconcile,
        refresh,
        flushAll: lock.withPermits(1)(flushAllUnlocked),
      });
    })
  );
}
