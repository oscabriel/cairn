// Judges the notifier on a migrated in-memory cairn.sqlite with the real shell store, against a fake
// push service that answers each endpoint as the test scripts it: a run that ends is pushed once to
// every device (201), 429 and 5xx are resent with a doubling delay, 404 and 410 delete the
// subscription, the same run seen twice (or after a restart) is pushed once, a page showing the
// thread suppresses the push, short successful runs stay quiet, the payload stays under 3.5 KB, and
// Executor's needs-sign-in push goes out once per lapse. Ported in part from cairn-v1
// apps/server/test/push.test.ts at 1a5cd4a (the retry and removal cases).
import { EntryId, RunId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { PushSubscriptionInput } from "@cairn/protocol/Push";
import { ThreadRename } from "@cairn/protocol/ShellCommands";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { Database } from "../db/Database.ts";
import { Push0005 } from "../db/migrations/0005Push.ts";
import { EventSink } from "../shell/EventSink.ts";
import { EventStore } from "../shell/EventStore.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
} from "../shell/ShellCommands.ts";
import type { ThreadActivityPatch } from "../shell/ShellCommands.ts";
import { ShellStoreLayer } from "../shell/ShellLayer.ts";
import {
  createProject,
  createThread,
  shellMigrations,
  testCommandId,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import {
  EXECUTOR_SIGN_IN_KEY,
  MAX_MESSAGE_BYTES,
  Notifier,
  PushMessage,
} from "./Notifier.ts";
import { Presence } from "./Presence.ts";
import { PushEndpointRule, PushSubscriptions } from "./PushSubscriptions.ts";
import { WebPush } from "./WebPush.ts";

/** 2026-10-22T12:00:00Z. */
const NOW = 1_792_670_400_000;

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(PushMessage)
);

/** One POST the fake push service saw. */
interface Attempt {
  readonly endpoint: string;
  readonly at: number;
  readonly status: number;
  readonly message: string;
}

/** A push service that answers each endpoint's `n`th attempt as `answer` says, and records it. */
const fakePushService = (
  answer: (endpoint: string, attempt: number) => number
) => {
  const attempts: Array<Attempt> = [];

  const layer = Layer.effect(
    WebPush,
    Effect.sync(() =>
      WebPush.of({
        send: (target, message) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;

            const before = attempts.filter(
              (seen) => seen.endpoint === target.endpoint
            ).length;

            const status = answer(target.endpoint, before);

            attempts.push({ endpoint: target.endpoint, at, status, message });

            return { status, body: "" };
          }).pipe(Effect.orDie),
      })
    )
  );

  return { attempts, layer };
};

const pushMigrations = { ...shellMigrations, "0005_Push": Push0005 };

const StoreLayer = Layer.mergeAll(
  PushSubscriptions.layerNoDeps,
  Presence.layer
).pipe(
  Layer.provideMerge(ShellStoreLayer),
  Layer.provideMerge(Database.layerTest(pushMigrations))
);

const allowTestEndpoints = Effect.provideService(PushEndpointRule, {
  allows: (endpoint: string) => endpoint.startsWith("https://push.test/"),
});

const subscription = (name: string): PushSubscriptionInput => ({
  endpoint: `https://push.test/${name}`,
  keys: {
    p256dh: "B".padEnd(87, "A"),
    auth: Buffer.from(name.padEnd(16, "-").slice(0, 16)).toString("base64url"),
  },
});

const subscribe = (...names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const subscriptions = yield* PushSubscriptions;

    for (const name of names) {
      yield* subscriptions.upsert("oscabriel@github", subscription(name));
    }
  }).pipe(allowTestEndpoints);

/** Lets the notifier's fibers run until `done` holds (no time passes). */
const waitUntil = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 2000 && !done(); turn += 1) {
      yield* Effect.yieldNow;
    }

    for (let turn = 0; turn < 50; turn += 1) {
      yield* Effect.yieldNow;
    }
  });

/** Lets the notifier's fibers run a while without waiting for anything. */
const idle = waitUntil(() => false);

const at = (millis: number) => DateTime.makeUnsafe(millis);

let commandCounter = 0;

let numberCounter = 0;

const nextNumber = () => {
  numberCounter += 1;

  return numberCounter;
};

const nextCommandId = () => {
  commandCounter += 1;

  return testCommandId(50_000 + commandCounter);
};

/** Makes thread `n` in a fresh project; its title is `title`. */
const makeThread = (n: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const project = createProject(n);

    yield* sink.commitCommand(project.command);
    yield* sink.commitCommand(createThread(project.projectId, n));

    return testThreadId(n);
  });

const patchThread = (threadId: ThreadId, patch: Partial<ThreadActivityPatch>) =>
  EventSink.use((sink) =>
    sink.commitCommand(
      ThreadActivityUpdate.make({
        commandId: nextCommandId(),
        threadId,
        patch: { ...emptyActivityPatch, ...patch },
      })
    )
  );

/** The projector's commits for a run: it starts at `startedAt`, then ends at `endedAt`. */
const runOnce = (
  threadId: ThreadId,
  options: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly failed?: boolean;
    readonly reply?: string;
  }
) =>
  Effect.gen(function* () {
    yield* patchThread(threadId, {
      activity: Option.some("running"),
      activeRunId: Option.some(Option.some(RunId.make(nextNumber()))),
      latestRunStartedAt: Option.some(Option.some(at(options.startedAt))),
      lastError: Option.some(Option.none()),
      lastErrorClass: Option.some(Option.none()),
    });

    const failed = options.failed === true;

    yield* patchThread(threadId, {
      activity: Option.some(failed ? "failed" : "idle"),
      activeRunId: Option.some(Option.none()),
      latestRunCompletedAt: Option.some(Option.some(at(options.endedAt))),
      lastError: Option.some(
        failed
          ? Option.some("The model provider refused the request.")
          : Option.none()
      ),
      lastErrorClass: Option.some(
        failed ? Option.some("provider_error" as const) : Option.none()
      ),
      latestVisibleMessage: Option.some(
        Option.some({
          entryId: EntryId.make(nextNumber()),
          role: "assistant" as const,
          text: options.reply ?? "All tests pass.",
          at: at(options.endedAt),
        })
      ),
    });
  });

/** Runs `body` at NOW with the store, the fake push service and a running notifier. */
const withNotifier = <A, E, R>(
  service: ReturnType<typeof fakePushService>,
  body: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);

    return yield* body.pipe(
      Effect.provide(
        Notifier.layerNoDeps.pipe(
          Layer.provideMerge(service.layer),
          Layer.provideMerge(StoreLayer)
        )
      )
    );
  });

const messagesTo = (attempts: ReadonlyArray<Attempt>, endpoint: string) =>
  attempts.flatMap((attempt) =>
    attempt.endpoint === `https://push.test/${endpoint}` &&
    attempt.status === 201
      ? [decodeMessage(attempt.message)]
      : []
  );

/** When each attempt to `name` happened, in milliseconds after NOW. */
const attemptTimes = (attempts: ReadonlyArray<Attempt>, name: string) =>
  attempts.flatMap((attempt) =>
    attempt.endpoint.endsWith(`/${name}`) ? [attempt.at - NOW] : []
  );

describe(Notifier, () => {
  it.effect("pushes a run that ran over 20 s once to every device", () => {
    const service = fakePushService(() => 201);

    return withNotifier(
      service,
      Effect.gen(function* () {
        yield* subscribe("phone", "laptop");
        const threadId = yield* makeThread(1);

        yield* runOnce(threadId, {
          startedAt: NOW - 192_000,
          endedAt: NOW - 1000,
          reply: "Refactored the parser.\nAll tests pass.",
        });

        yield* waitUntil(() => service.attempts.length >= 2);
        yield* Notifier.use((notifier) => notifier.settle);

        assert.strictEqual(service.attempts.length, 2);

        const [message] = messagesTo(service.attempts, "phone");

        assert.deepStrictEqual(message, {
          title: "Thread 1",
          body: "Finished after 3m 11s. Refactored the parser. All tests pass.",
          tag: `thread:${threadId}`,
          url: `/t/${threadId}`,
          badge: 1,
        });
        assert.deepStrictEqual(messagesTo(service.attempts, "laptop"), [
          message,
        ]);

        const sql = yield* SqlClient.SqlClient;

        const delivered = yield* sql<{ readonly endpoint: string }>`
          SELECT endpoint FROM push_subscriptions WHERE last_ok_at IS NOT NULL ORDER BY endpoint
        `;

        assert.deepStrictEqual(
          delivered.map((row) => row.endpoint),
          ["https://push.test/laptop", "https://push.test/phone"]
        );
      })
    );
  });

  it.effect(
    "stays quiet for a short successful run and pushes a short failed one",
    () => {
      const service = fakePushService(() => 201);

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("phone");
          const quiet = yield* makeThread(1);
          const failing = yield* makeThread(2);

          yield* runOnce(quiet, { startedAt: NOW - 20_000, endedAt: NOW });
          yield* idle;

          assert.strictEqual(service.attempts.length, 0);

          yield* runOnce(failing, {
            startedAt: NOW - 3000,
            endedAt: NOW,
            failed: true,
          });
          yield* waitUntil(() => service.attempts.length >= 1);

          const [message] = messagesTo(service.attempts, "phone");

          assert.strictEqual(message?.title, "Thread 2");
          assert.strictEqual(
            message?.body,
            "Failed after 3s. The model provider refused the request."
          );
        })
      );
    }
  );

  it.effect(
    "sends the same run once, however often its row changes or its event is handled",
    () => {
      const service = fakePushService(() => 201);

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("phone");
          const threadId = yield* makeThread(1);

          yield* runOnce(threadId, { startedAt: NOW - 60_000, endedAt: NOW });
          yield* waitUntil(() => service.attempts.length >= 1);

          // A later commit on the same thread (the queue changed) shows the same run end.
          yield* patchThread(threadId, { queueLength: Option.some(1) });
          yield* idle;

          // And the event log replayed by hand, as after a crash before the cursor moved.
          const events = yield* EventStore;
          const notifier = yield* Notifier;
          const latest = yield* events.latestSequence;

          yield* Stream.runForEach(
            events.readRange({ afterSequence: 0, throughSequence: latest }),
            (event) => notifier.handleEvent(event)
          );

          yield* notifier.settle;

          assert.strictEqual(service.attempts.length, 1);

          const sql = yield* SqlClient.SqlClient;

          const claims = yield* sql<{
            readonly outcome: string;
          }>`SELECT outcome FROM notified_runs`;

          assert.deepStrictEqual(
            claims.map((row) => row.outcome),
            ["sent"]
          );
        })
      );
    }
  );

  it.effect(
    "suppresses a run on a thread a visible page shows, for good",
    () => {
      const service = fakePushService(() => 201);

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("phone");
          const threadId = yield* makeThread(1);
          const presence = yield* Presence;

          yield* presence.report({
            deviceId: "laptop-device-1",
            visible: true,
            threadId: Option.some(threadId),
          });

          yield* runOnce(threadId, { startedAt: NOW - 60_000, endedAt: NOW });
          yield* idle;

          assert.strictEqual(service.attempts.length, 0);

          // The page goes away; a later change on the thread must not push the old result.
          yield* presence.report({
            deviceId: "laptop-device-1",
            visible: false,
            threadId: Option.none(),
          });
          yield* patchThread(threadId, { queueLength: Option.some(2) });
          yield* idle;

          assert.strictEqual(service.attempts.length, 0);
        })
      );
    }
  );

  it.effect(
    "does not count a presence report older than 30 s, nor a page showing another thread",
    () => {
      const service = fakePushService(() => 201);

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("phone");
          const stale = yield* makeThread(1);
          const other = yield* makeThread(2);
          const presence = yield* Presence;

          yield* presence.report({
            deviceId: "laptop-device-1",
            visible: true,
            threadId: Option.some(stale),
          });
          yield* presence.report({
            deviceId: "phone-device-1",
            visible: true,
            threadId: Option.some(stale),
          });
          yield* TestClock.adjust(Duration.seconds(31));
          yield* presence.report({
            deviceId: "phone-device-1",
            visible: true,
            threadId: Option.some(other),
          });

          const now = NOW + 31_000;

          yield* runOnce(stale, { startedAt: now - 60_000, endedAt: now });
          yield* waitUntil(() => service.attempts.length >= 1);

          assert.strictEqual(
            messagesTo(service.attempts, "phone")[0]?.title,
            "Thread 1"
          );
        })
      );
    }
  );

  it.effect(
    "resends 429 and 5xx with a doubling delay, deletes 404 and 410, and keeps going for the others",
    () => {
      const service = fakePushService((endpoint, attempt) => {
        if (endpoint.endsWith("/gone")) {
          return 410;
        }

        if (endpoint.endsWith("/missing")) {
          return 404;
        }

        if (endpoint.endsWith("/busy")) {
          return attempt < 2 ? 429 : 201;
        }

        if (endpoint.endsWith("/down")) {
          return 503;
        }

        return 201;
      });

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("gone", "missing", "busy", "down", "ok");
          const notifier = yield* Notifier;

          const sending = yield* Effect.forkChild(
            notifier.sendToAll({
              title: "t",
              body: "b",
              tag: "x",
              url: "/",
              badge: 0,
            })
          );

          yield* idle;
          yield* TestClock.adjust(Duration.millis(999));
          yield* idle;

          assert.deepStrictEqual(attemptTimes(service.attempts, "busy"), [0]);

          yield* TestClock.adjust(Duration.millis(1));
          yield* idle;

          assert.deepStrictEqual(
            attemptTimes(service.attempts, "busy"),
            [0, 1000]
          );

          yield* TestClock.adjust(Duration.millis(2000));
          yield* idle;

          const outcomes = yield* Fiber.await(sending);

          assert.deepStrictEqual(
            attemptTimes(service.attempts, "busy"),
            [0, 1000, 3000]
          );

          assert.strictEqual(attemptTimes(service.attempts, "gone").length, 1);
          assert.strictEqual(
            attemptTimes(service.attempts, "missing").length,
            1
          );
          assert.strictEqual(attemptTimes(service.attempts, "down").length, 3);
          assert.strictEqual(attemptTimes(service.attempts, "ok").length, 1);
          assert.isTrue(Exit.isSuccess(outcomes));

          const subscriptions = yield* PushSubscriptions;
          const left = yield* subscriptions.list;

          assert.deepStrictEqual(
            left.map((row) => row.endpoint),
            [
              "https://push.test/busy",
              "https://push.test/down",
              "https://push.test/ok",
            ]
          );
        })
      );
    }
  );

  it.effect(
    "keeps a run's payload under 3.5 KB however long its title and reply",
    () => {
      const service = fakePushService(() => 201);

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("phone");
          const threadId = yield* makeThread(1);

          yield* EventSink.use((sink) =>
            sink.commitCommand(
              ThreadRename.make({
                commandId: nextCommandId(),
                threadId,
                title: "Ü".repeat(2000),
              })
            )
          );

          yield* runOnce(threadId, {
            startedAt: NOW - 60_000,
            endedAt: NOW,
            reply: "🪨 ".repeat(1300),
          });
          yield* waitUntil(() => service.attempts.length >= 1);

          const [attempt] = service.attempts;

          assert.isDefined(attempt);
          assert.isBelow(
            Buffer.byteLength(attempt?.message ?? ""),
            MAX_MESSAGE_BYTES
          );
          assert.isAtMost(
            decodeMessage(attempt?.message ?? "").body.length,
            240
          );
        })
      );
    }
  );

  it.effect(
    "pushes Executor's needs-sign-in once until it is signed in again",
    () => {
      const service = fakePushService(() => 201);

      return withNotifier(
        service,
        Effect.gen(function* () {
          yield* subscribe("phone");
          const notifier = yield* Notifier;

          yield* notifier.executorNeedsSignIn;
          yield* notifier.executorNeedsSignIn;
          yield* notifier.settle;

          assert.strictEqual(service.attempts.length, 1);
          assert.strictEqual(
            messagesTo(service.attempts, "phone")[0]?.tag,
            EXECUTOR_SIGN_IN_KEY
          );

          yield* notifier.executorSignedIn;
          yield* notifier.executorNeedsSignIn;
          yield* notifier.settle;

          assert.strictEqual(service.attempts.length, 2);
        })
      );
    }
  );

  it.effect(
    "starts at the log's end, and a restart resumes from its cursor without resending",
    () => {
      const service = fakePushService(() => 201);

      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        yield* subscribe("phone");

        // A run that ended before push existed.
        const old = yield* makeThread(1);

        yield* runOnce(old, { startedAt: NOW - 60_000, endedAt: NOW - 1000 });

        const runNotifier = <A, E, R>(body: Effect.Effect<A, E, R>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(
                Notifier.layerNoDeps.pipe(Layer.provide(service.layer))
              );

              yield* idle;

              return yield* body.pipe(Effect.provideContext(context));
            })
          );

        const fresh = yield* makeThread(2);

        yield* runNotifier(
          Effect.gen(function* () {
            assert.strictEqual(service.attempts.length, 0);

            yield* runOnce(fresh, { startedAt: NOW - 60_000, endedAt: NOW });
            yield* waitUntil(() => service.attempts.length >= 1);
            yield* Notifier.use((notifier) => notifier.settle);
          })
        );

        assert.strictEqual(service.attempts.length, 1);

        const sql = yield* SqlClient.SqlClient;
        const events = yield* EventStore;

        const cursor = yield* sql<{
          readonly sequence: number;
        }>`SELECT sequence FROM push_cursor`;

        assert.strictEqual(cursor[0]?.sequence, yield* events.latestSequence);

        // While the notifier is down a third run ends; the restarted notifier pushes it, and only it.
        const later = yield* makeThread(3);

        yield* runOnce(later, { startedAt: NOW - 60_000, endedAt: NOW });

        yield* runNotifier(
          Effect.gen(function* () {
            yield* waitUntil(() => service.attempts.length >= 2);
            yield* Notifier.use((notifier) => notifier.settle);
          })
        );

        assert.deepStrictEqual(
          service.attempts.map(
            (attempt) => decodeMessage(attempt.message).title
          ),
          ["Thread 2", "Thread 3"]
        );
      }).pipe(Effect.provide(StoreLayer));
    }
  );
});
