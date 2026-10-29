// Ported from cairn-v1, apps/server/src/Push.ts (`make`: delivery, retries, the needs-sign-in push)
// at 1a5cd4a. Kept: every push goes to every stored subscription in parallel; a 2xx records the
// delivery, a 404 or 410 deletes the subscription (only while its keys are the ones sent to), and a
// 429, a 5xx or a network failure is resent twice with the delay doubling from one second; a push is
// claimed in the database before it is sent, so a restart or a replay never sends it twice; every
// push is shown on the device, collapsed by its tag. Changed: v1 pushed approvals from its approval
// queue; here pushes follow the shell event log. The notifier reads `thread.activity-updated` events
// after a durable cursor (`push_cursor`), and for each one looks at the thread's row as it stands: a
// run that ended (failed, or ran longer than 20 seconds) while no visible page reported showing the
// thread in the last 30 seconds is pushed once, claimed in `notified_runs` under the thread and the
// run's end time. Executor's needs-sign-in push is sent once until the link is signed in again.
// A subagent's run end is never pushed (its result reaches its parent as a note, ADR 0028), and a
// push is suppressed while a visible page shows its thread or any ancestor of it (`isWatchedTree`).

import type { ThreadId } from "@cairn/protocol/Ids";
import type { PushSubscriptionInput } from "@cairn/protocol/Push";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { MAX_SUBAGENT_DEPTH } from "@cairn/protocol/Subagents";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import { EventStore } from "../shell/EventStore.ts";
import type { StoredShellEvent } from "../shell/EventStore.ts";
import { isLiveThread, ThreadRows } from "../shell/ThreadRows.ts";
import { Presence } from "./Presence.ts";
import { endpointHost, PushSubscriptions } from "./PushSubscriptions.ts";
import type { PushStoreError } from "./PushSubscriptions.ts";
import { WebPush } from "./WebPush.ts";
import type { PushResponse, SendOptions, WebPushError } from "./WebPush.ts";

/** What the service worker shows (`apps/web/public/sw.js`). Encrypted end to end to the device. */
export const PushMessage = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  /** Notifications with the same tag replace each other on the device. */
  tag: Schema.String,
  /** The same-origin path a tap opens. */
  url: Schema.String,
  /** The app icon's badge: threads with a result the user has not seen. */
  badge: Schema.Int,
});

/** A push message. */
export type PushMessage = typeof PushMessage.Type;

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(PushMessage));

/** The notifier's timings and limits. */
export interface NotifierSettings {
  /** A run that ends without failing is pushed only when it ran longer than this. */
  readonly minRunDuration: Duration.Duration;
  /** A run that ended longer ago than this is never pushed (a brain that was down for a while). */
  readonly staleAfter: Duration.Duration;
  /** The first resend's delay; each later one doubles it. */
  readonly retryBase: Duration.Duration;
  /** Resends after the first attempt. */
  readonly retries: number;
  /** How long a push service may hold a push for an offline device. */
  readonly ttl: Duration.Duration;
  /** How long `notified_runs` keeps a claim. */
  readonly claimRetention: Duration.Duration;
}

/** The notifier's settings; tests shorten them. */
export const NotifierSettings = Context.Reference<NotifierSettings>(
  "cairn/server/push/Notifier/NotifierSettings",
  {
    defaultValue: () => ({
      minRunDuration: Duration.seconds(20),
      staleAfter: Duration.minutes(10),
      retryBase: Duration.seconds(1),
      retries: 2,
      ttl: Duration.hours(6),
      claimRetention: Duration.days(30),
    }),
  }
);

/** The largest encoded message the notifier sends, well inside one 4 KB record. */
export const MAX_MESSAGE_BYTES = 3500;

const TITLE_LIMIT = 80;

const BODY_LIMIT = 240;

/** One line, at most `max` characters, ending in an ellipsis when cut. */
export const cutText = (text: string, max: number): string => {
  const line = text.replaceAll(/\s+/gu, " ").trim();

  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "45s", "3m 12s", "1h 4m". */
export const formatRunDuration = (millis: number): string => {
  const seconds = Math.max(0, Math.round(millis / 1000));

  if (seconds < 60) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${String(minutes)}m ${String(seconds % 60)}s`;
  }

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
};

/** A run end that may deserve a push. */
export interface RunEnd {
  /** The claim key: the thread and the run's end time. */
  readonly key: string;
  readonly threadId: ThreadId;
  readonly failed: boolean;
  readonly durationMillis: number;
  readonly endedAt: DateTime.Utc;
}

/**
 * The run end a thread row shows, when it deserves a push at `now`: no run is active, the latest
 * run ended after it started, and it failed or ran longer than `minRunDuration`, and it ended no
 * longer than `staleAfter` ago.
 */
export const runEndToPush = (
  thread: ThreadShell,
  now: DateTime.Utc,
  settings: Pick<NotifierSettings, "minRunDuration" | "staleAfter">
): Option.Option<RunEnd> => {
  // A subagent's run end reaches its parent as a note, not the user's phone.
  if (Option.isSome(thread.activeRunId) || Option.isSome(thread.lineage)) {
    return Option.none();
  }

  if (
    Option.isNone(thread.latestRunStartedAt) ||
    Option.isNone(thread.latestRunCompletedAt)
  ) {
    return Option.none();
  }

  const started = DateTime.toEpochMillis(thread.latestRunStartedAt.value);
  const ended = DateTime.toEpochMillis(thread.latestRunCompletedAt.value);

  if (ended < started) {
    return Option.none();
  }

  if (
    DateTime.toEpochMillis(now) - ended >
    Duration.toMillis(settings.staleAfter)
  ) {
    return Option.none();
  }

  const failed =
    thread.activity === "failed" || Option.isSome(thread.lastErrorClass);

  const durationMillis = ended - started;

  if (!failed && durationMillis <= Duration.toMillis(settings.minRunDuration)) {
    return Option.none();
  }

  return Option.some({
    key: `run:${thread.id}:${String(ended)}`,
    threadId: thread.id,
    failed,
    durationMillis,
    endedAt: thread.latestRunCompletedAt.value,
  });
};

/** True when the thread has a result the user has not opened since it arrived. */
export const hasUnseenResult = (thread: ThreadShell): boolean =>
  Option.isNone(thread.activeRunId) &&
  Option.match(thread.latestRunCompletedAt, {
    onNone: () => false,
    onSome: (completed) =>
      Option.match(thread.lastVisitedAt, {
        onNone: () => true,
        onSome: (visited) => DateTime.isGreaterThan(completed, visited),
      }),
  });

/** The push for a run end. */
export const runMessage = (
  thread: ThreadShell,
  end: RunEnd,
  badge: number
): PushMessage => {
  const took = formatRunDuration(end.durationMillis);

  const preview = Option.match(thread.latestVisibleMessage, {
    onNone: () => "",
    onSome: (message) => (message.role === "assistant" ? message.text : ""),
  });

  const body = end.failed
    ? `Failed after ${took}. ${Option.getOrElse(thread.lastError, () => "The run did not finish.")}`
    : `Finished after ${took}.${preview === "" ? "" : ` ${preview}`}`;

  return {
    title: cutText(thread.title, TITLE_LIMIT),
    body: cutText(body, BODY_LIMIT),
    tag: `thread:${thread.id}`,
    url: `/t/${thread.id}`,
    badge,
  };
};

/** How many ancestors the presence check walks: the subagent depth cap, with room to spare. */
const ANCESTOR_HOPS = MAX_SUBAGENT_DEPTH + 2;

/**
 * True while a visible page shows `threadId` or any of its ancestors: a subagent's request shows on
 * every ancestor's thread (ADR 0027), so a page on any of them has it in front of the user.
 * `parentOf` names a thread's parent; a missing row or a loop ends the walk.
 */
export const watchedTree =
  <E, R>(
    isWatched: (threadId: ThreadId) => Effect.Effect<boolean, E, R>,
    parentOf: (
      threadId: ThreadId
    ) => Effect.Effect<Option.Option<ThreadId>, E, R>
  ) =>
  (threadId: ThreadId): Effect.Effect<boolean, E, R> =>
    Effect.gen(function* () {
      const seen = new Set<ThreadId>();
      let current = Option.some(threadId);

      while (
        Option.isSome(current) &&
        !seen.has(current.value) &&
        seen.size <= ANCESTOR_HOPS
      ) {
        if (yield* isWatched(current.value)) {
          return true;
        }

        seen.add(current.value);
        current = yield* parentOf(current.value);
      }

      return false;
    });

/** Executor's needs-sign-in push. */
export const executorSignInMessage = (badge: number): PushMessage => ({
  title: "Executor needs sign-in",
  body: "Executor refused Cairn's grant, so its tools are off. Sign in again from Settings.",
  tag: "executor-sign-in",
  url: "/",
  badge,
});

/** The claim key of the needs-sign-in push. */
export const EXECUTOR_SIGN_IN_KEY = "executor-sign-in";

/** The kind of shell event a run end arrives in. */
const RUN_EVENT = "thread.activity-updated";

const isRunEvent = (event: StoredShellEvent) =>
  event.type === RUN_EVENT && event.aggregateKind === "thread";

const CursorRows = Schema.Array(Schema.Struct({ sequence: Schema.Int }));

const decodeCursor = Schema.decodeUnknownEffect(CursorRows);

const ChangeRows = Schema.Array(Schema.Struct({ changed: Schema.Int }));

const decodeChanges = Schema.decodeUnknownEffect(ChangeRows);

const logStoreFailure = (failure: PushStoreError) =>
  Effect.logWarning("push store failed").pipe(
    Effect.annotateLogs({
      event: "push_store_failed",
      operation: failure.operation,
    })
  );

/** What one delivery ended in, for tests and logs. */
export type DeliveryOutcome = "delivered" | "removed" | "failed";

/** Sends run and Executor pushes to every subscribed device, each at most once. */
export class Notifier extends Context.Service<
  Notifier,
  {
    /**
     * Sends `message` to every subscription and waits for every delivery, resends included. Never
     * fails: a refused subscription is removed, other failures are logged.
     */
    sendToAll(
      message: PushMessage
    ): Effect.Effect<ReadonlyArray<DeliveryOutcome>>;
    /** Handles one shell event as the event loop does: pushes the run end its thread row shows. */
    handleEvent(event: StoredShellEvent): Effect.Effect<void>;
    /** Pushes "Executor needs sign-in" once, until `executorSignedIn` clears it. */
    readonly executorNeedsSignIn: Effect.Effect<void>;
    /** Executor works again: the next lapse pushes again. */
    readonly executorSignedIn: Effect.Effect<void>;
    /** Waits until every push started so far has been delivered or given up. */
    readonly settle: Effect.Effect<void>;
  }
>()("cairn/server/push/Notifier") {
  /**
   * The notifier and its event loop, which starts with the layer and stops with its scope. Needs
   * the shell store (`EventStore`, `ThreadRows`), `SqlClient`, `PushSubscriptions`, `WebPush` and
   * `Presence`.
   */
  static readonly layerNoDeps = Layer.effect(
    Notifier,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore;
      const threads = yield* ThreadRows;
      const subscriptions = yield* PushSubscriptions;
      const webPush = yield* WebPush;
      const presence = yield* Presence;
      const settings = yield* NotifierSettings;
      const sends = yield* FiberSet.make<ReadonlyArray<DeliveryOutcome>>();

      const sendOptions: SendOptions = {
        ttlSeconds: Duration.toSeconds(settings.ttl),
        urgency: "high",
      };

      /** One attempt: the push service's status, or 0 when nothing came back. */
      const attempt = (subscription: PushSubscriptionInput, json: string) =>
        webPush
          .send(subscription, json, sendOptions)
          .pipe(
            Effect.catchTag("WebPushError", (failure: WebPushError) =>
              Effect.succeed<PushResponse>({ status: 0, body: failure.message })
            )
          );

      const deliver = Effect.fn("Notifier.deliver")(function* (
        subscription: PushSubscriptionInput,
        json: string
      ) {
        const host = endpointHost(subscription.endpoint);

        for (let tries = 0; ; tries += 1) {
          const response = yield* attempt(subscription, json);
          const { status } = response;

          if (status >= 200 && status < 300) {
            yield* subscriptions
              .markDelivered(subscription.endpoint)
              .pipe(Effect.catchTag("PushStoreError", logStoreFailure));

            return "delivered" as const;
          }

          if (status === 404 || status === 410) {
            yield* subscriptions
              .removeRefused(subscription)
              .pipe(Effect.catchTag("PushStoreError", logStoreFailure));

            yield* Effect.logInfo("push subscription is gone; removed it").pipe(
              Effect.annotateLogs({
                event: "push_subscription_removed",
                host,
                status,
              })
            );

            return "removed" as const;
          }

          const retryable = status === 0 || status === 429 || status >= 500;

          if (!retryable || tries >= settings.retries) {
            yield* Effect.logWarning("push not delivered").pipe(
              Effect.annotateLogs({
                event: "push_failed",
                host,
                status,
                body: response.body,
                tries: tries + 1,
              })
            );

            return "failed" as const;
          }

          yield* Effect.sleep(Duration.times(settings.retryBase, 2 ** tries));
        }
      });

      const sendToAll = Effect.fn("Notifier.sendToAll")(function* (
        message: PushMessage
      ) {
        const json = yield* encodeMessage(message).pipe(Effect.orDie);

        if (Buffer.byteLength(json) > MAX_MESSAGE_BYTES) {
          yield* Effect.logWarning("push message too large; not sent").pipe(
            Effect.annotateLogs({ event: "push_too_large", tag: message.tag })
          );

          return [];
        }

        const targets = yield* subscriptions.list.pipe(
          Effect.catchTag("PushStoreError", (failure) =>
            logStoreFailure(failure).pipe(Effect.as([]))
          )
        );

        const outcomes = yield* Effect.forEach(
          targets,
          (subscription) => deliver(subscription, json),
          { concurrency: "unbounded" }
        );

        yield* Effect.logInfo("push sent").pipe(
          Effect.annotateLogs({
            event: "push_sent",
            tag: message.tag,
            devices: targets.length,
            delivered: outcomes.filter((outcome) => outcome === "delivered")
              .length,
          })
        );

        return outcomes;
      });

      /** Records a decision for `key`; false when one was recorded before. */
      const claim = (
        key: string,
        threadId: Option.Option<ThreadId>,
        outcome: "sent" | "suppressed"
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const rows = yield* sql`
            INSERT INTO notified_runs (key, thread_id, outcome, created_at)
            VALUES (${key}, ${Option.getOrNull(threadId)}, ${outcome}, ${now})
            ON CONFLICT (key) DO NOTHING
            RETURNING 1 AS changed
          `.pipe(Effect.flatMap(decodeChanges));

          return rows.length > 0;
        });

      const badgeCount = threads.listLive.pipe(
        Effect.map(
          (rows) => rows.filter((row) => hasUnseenResult(row.shell)).length
        ),
        Effect.orElseSucceed(() => 0)
      );

      const isWatchedTree = watchedTree(
        (threadId) => presence.isWatched(threadId),
        (threadId) =>
          threads.get(threadId).pipe(
            Effect.map(Option.flatMap((row) => row.shell.lineage)),
            Effect.map(Option.map((lineage) => lineage.parentThreadId)),
            Effect.orElseSucceed(() => Option.none<ThreadId>())
          )
      );

      /** Starts `message`'s delivery without waiting for it. */
      const startSend = (message: PushMessage) =>
        FiberSet.run(sends, sendToAll(message)).pipe(Effect.asVoid);

      const handleEvent = Effect.fn("Notifier.handleEvent")(
        function* (event: StoredShellEvent) {
          if (!isRunEvent(event) || event.aggregateKind !== "thread") {
            return;
          }

          const threadId = event.aggregateId;
          const row = yield* threads.get(threadId);

          if (Option.isNone(row) || !isLiveThread(row.value)) {
            return;
          }

          const now = yield* DateTime.now;
          const end = runEndToPush(row.value.shell, now, settings);

          if (Option.isNone(end)) {
            return;
          }

          if (yield* isWatchedTree(threadId)) {
            yield* claim(end.value.key, Option.some(threadId), "suppressed");

            return;
          }

          const claimed = yield* claim(
            end.value.key,
            Option.some(threadId),
            "sent"
          );

          if (!claimed) {
            return;
          }

          yield* startSend(
            runMessage(row.value.shell, end.value, yield* badgeCount)
          );
        },
        (effect, event) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("push decision failed", cause).pipe(
                Effect.annotateLogs({
                  event: "push_decision_failed",
                  sequence: event.sequence,
                })
              )
            )
          )
      );

      const executorNeedsSignIn = Effect.gen(function* () {
        const claimed = yield* claim(
          EXECUTOR_SIGN_IN_KEY,
          Option.none(),
          "sent"
        );

        if (claimed) {
          yield* startSend(executorSignInMessage(yield* badgeCount));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("executor sign-in push failed", cause)
        ),
        Effect.withSpan("Notifier.executorNeedsSignIn")
      );

      const executorSignedIn =
        sql`DELETE FROM notified_runs WHERE key = ${EXECUTOR_SIGN_IN_KEY}`.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("executor sign-in claim not cleared", cause)
          ),
          Effect.withSpan("Notifier.executorSignedIn")
        );

      const readCursor =
        sql`SELECT sequence FROM push_cursor WHERE id = 1`.pipe(
          Effect.flatMap(decodeCursor),
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.sequence))
        );

      const writeCursor = (sequence: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          yield* sql`
            INSERT INTO push_cursor (id, sequence, updated_at) VALUES (1, ${sequence}, ${now})
            ON CONFLICT (id) DO UPDATE SET
              sequence = excluded.sequence,
              updated_at = excluded.updated_at
          `;
        });

      // A brain's first start begins at the log's end: runs from before push existed are history.
      const startCursor = Effect.gen(function* () {
        const stored = yield* readCursor;

        if (Option.isSome(stored)) {
          return stored.value;
        }

        const latest = yield* events.latestSequence;

        yield* writeCursor(latest);

        return latest;
      });

      const pruneClaims = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const floor = now - Duration.toMillis(settings.claimRetention);

        yield* sql`
          DELETE FROM notified_runs WHERE created_at < ${floor} AND key <> ${EXECUTOR_SIGN_IN_KEY}
        `;
      });

      // The cursor is fixed while the layer builds, so nothing committed after that is missed.
      yield* startCursor.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("push cursor not set at start", cause)
        )
      );

      const loop = Effect.gen(function* () {
        yield* pruneClaims;

        const cursor = yield* startCursor;

        yield* events
          .eventsAfter(cursor, isRunEvent)
          .pipe(
            Stream.runForEach((event) =>
              handleEvent(event).pipe(
                Effect.andThen(writeCursor(event.sequence))
              )
            )
          );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("push event loop stopped; restarting", cause).pipe(
            Effect.annotateLogs({ event: "push_loop_restart" })
          )
        ),
        Effect.repeat(Schedule.spaced(Duration.seconds(1)))
      );

      yield* Effect.forkScoped(loop);

      const settle = FiberSet.awaitEmpty(sends);

      return Notifier.of({
        sendToAll: (message) => sendToAll(message),
        handleEvent,
        executorNeedsSignIn,
        executorSignedIn,
        settle,
      });
    })
  );
}
