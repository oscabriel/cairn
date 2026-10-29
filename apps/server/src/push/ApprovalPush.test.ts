// Judges approval push (briefs note B7, the push row of its judges) on the notifier as it runs: a
// migrated in-memory cairn.sqlite with the real shell store, a fake push service, the records the
// rows' requests point at in a table the test edits, and the test clock driving the sweep. One push
// per request; none while a page shows the thread or an ancestor; a late push 60 seconds after a
// suppressed one; none when answered first; one tag per thread with a count; one reminder; no
// duplicate after a restart; an escalated question pushed once, from the parent, naming the child.

import { ApprovalId, RunId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ApprovalRecord } from "@cairn/protocol/Policy";
import type { PushSubscriptionInput } from "@cairn/protocol/Push";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { Database } from "../db/Database.ts";
import { Push0005 } from "../db/migrations/0005Push.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
  ThreadCreate,
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
import { Notifier, PushMessage } from "./Notifier.ts";
import { Presence } from "./Presence.ts";
import { PushEndpointRule, PushSubscriptions } from "./PushSubscriptions.ts";
import { RequestRecords } from "./RequestRecords.ts";
import {
  escalatedQuestion,
  pendingBrief,
  pendingQuestion,
  pendingRecord,
  question,
} from "./RequestTestKit.ts";
import { WebPush } from "./WebPush.ts";

/** 2026-10-22T12:00:00Z. */
const NOW = 1_792_670_400_000;

const decodeMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(PushMessage)
);

/** Every message the fake push service accepted, in order. */
const fakePushService = () => {
  const messages: Array<PushMessage> = [];

  const layer = Layer.succeed(
    WebPush,
    WebPush.of({
      send: (_target, message) =>
        Effect.sync(() => {
          messages.push(decodeMessage(message));

          return { status: 201, body: "" };
        }),
    })
  );

  return { messages, layer };
};

/** The records each thread's conversation holds; a test edits it as requests come and go. */
const recordTable = () => {
  const table = new Map<ThreadId, ReadonlyArray<ApprovalRecord>>();

  return {
    set: (threadId: ThreadId, records: ReadonlyArray<ApprovalRecord>) =>
      Effect.sync(() => {
        table.set(threadId, records);
      }),
    layer: RequestRecords.layerFrom((threadId) => table.get(threadId) ?? []),
  };
};

const pushMigrations = { ...shellMigrations, "0005_Push": Push0005 };

const StoreLayer = Layer.mergeAll(
  PushSubscriptions.layerNoDeps,
  Presence.layer
).pipe(
  Layer.provideMerge(ShellStoreLayer),
  Layer.provideMerge(Database.layerTest(pushMigrations))
);

const phone: PushSubscriptionInput = {
  endpoint: "https://push.test/phone",
  keys: {
    p256dh: "B".padEnd(87, "A"),
    auth: Buffer.from("phone-----------").toString("base64url"),
  },
};

const subscribePhone = PushSubscriptions.use((subscriptions) =>
  subscriptions.upsert("oscabriel@github", phone)
).pipe(
  Effect.provideService(PushEndpointRule, {
    allows: (endpoint: string) => endpoint.startsWith("https://push.test/"),
  })
);

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

const idle = waitUntil(() => false);

let counter = 0;

const nextCommandId = () => {
  counter += 1;

  return testCommandId(70_000 + counter);
};

/** Makes thread `n` in project `n`, a subagent of `parent` when given. */
const makeThread = (
  n: number,
  parent: Option.Option<ThreadId> = Option.none()
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const project = createProject(n);

    yield* sink.commitCommand(project.command);
    yield* sink.commitCommand(
      ThreadCreate.make({
        ...createThread(project.projectId, n),
        lineage: Option.map(parent, (parentThreadId) => ({
          parentThreadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: parentThreadId,
        })),
      })
    );

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

/**
 * The projector's commit for a thread's requests: the row names the oldest of `records` and counts
 * them, and the table holds them.
 */
const showRequests = (
  table: ReturnType<typeof recordTable>,
  threadId: ThreadId,
  records: ReadonlyArray<ApprovalRecord>
) =>
  Effect.gen(function* () {
    yield* table.set(threadId, records);

    const pending = records.filter((record) => record.status === "pending");
    const now = yield* DateTime.now;

    yield* patchThread(threadId, {
      activity: Option.some(pending.length > 0 ? "waiting" : "idle"),
      activeRunId: Option.some(
        pending.length > 0 ? Option.some(RunId.make(1)) : Option.none()
      ),
      pendingRuntimeRequest: Option.some(
        Option.map(Option.fromUndefinedOr(pending[0]), (record) => ({
          id: ApprovalId.make(record.id),
          kind: record.kind,
          createdAt: now,
          origin: Option.none(),
        }))
      ),
      pendingCount: Option.some(pending.length),
    });
  });

const watch = (threadId: Option.Option<ThreadId>, visible = true) =>
  Presence.use((presence) =>
    presence.report({ deviceId: "laptop", visible, threadId })
  );

const now = Clock.currentTimeMillis;

/** Runs `body` at NOW with the store, the fake service, the record table and a running notifier. */
const withNotifier = <A, E, R>(
  service: ReturnType<typeof fakePushService>,
  table: ReturnType<typeof recordTable>,
  body: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);

    return yield* Effect.gen(function* () {
      yield* subscribePhone;

      return yield* body;
    }).pipe(
      Effect.provide(
        Notifier.layerNoDeps.pipe(
          Layer.provideMerge(Layer.merge(service.layer, table.layer)),
          Layer.provideMerge(StoreLayer)
        )
      )
    );
  });

const bodies = (service: ReturnType<typeof fakePushService>) =>
  service.messages.map((message) => message.body);

describe("approval push", () => {
  it.effect(
    "pushes a request once, tagged for its thread, and not again on later events",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const threadId = yield* makeThread(1);
          const brief = pendingBrief("brief-1", yield* now, "Fix the parser");

          yield* showRequests(table, threadId, [brief]);
          yield* waitUntil(() => service.messages.length >= 1);

          yield* patchThread(threadId, { queueLength: Option.some(1) });
          yield* showRequests(table, threadId, [brief]);
          yield* idle;

          assert.deepStrictEqual(service.messages, [
            {
              title: "Thread 1",
              body: "Go? Fix the parser",
              tag: `ask:${threadId}`,
              url: `/t/${threadId}`,
              badge: 1,
            },
          ]);
        })
      );
    }
  );

  it.effect(
    "suppresses a request a page shows, then pushes it late once 60 s old and unwatched",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const threadId = yield* makeThread(1);

          yield* watch(Option.some(threadId));
          yield* showRequests(table, threadId, [
            pendingRecord("tool-1", yield* now),
          ]);
          yield* idle;

          assert.deepStrictEqual(service.messages, []);

          // Still watched at 30 s; gone at 45 s; the sweep at 60 s owes the late push.
          yield* TestClock.adjust(Duration.seconds(30));
          yield* idle;
          yield* TestClock.adjust(Duration.seconds(15));
          yield* watch(Option.none(), false);
          yield* idle;

          assert.deepStrictEqual(service.messages, []);

          yield* TestClock.adjust(Duration.seconds(15));
          yield* waitUntil(() => service.messages.length >= 1);
          yield* TestClock.adjust(Duration.seconds(90));
          yield* idle;

          assert.deepStrictEqual(bodies(service), ["Approve bash: pnpm test"]);
        })
      );
    }
  );

  it.effect(
    "pushes nothing for a request answered before its late push",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const threadId = yield* makeThread(1);
          const asked = pendingRecord("tool-1", yield* now);

          yield* watch(Option.some(threadId));
          yield* showRequests(table, threadId, [asked]);
          yield* idle;
          yield* watch(Option.none(), false);
          yield* showRequests(table, threadId, [
            { ...asked, status: "accepted", answeredAt: (yield* now) + 1 },
          ]);
          yield* TestClock.adjust(Duration.minutes(20));
          yield* idle;

          assert.deepStrictEqual(service.messages, []);
        })
      );
    }
  );

  it.effect(
    "sends a second request on the same tag with the count, and a parent-routed question not at all",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const threadId = yield* makeThread(1);
          const first = pendingBrief("brief-1", yield* now, "Fix the parser");

          yield* showRequests(table, threadId, [first]);
          yield* waitUntil(() => service.messages.length >= 1);
          yield* TestClock.adjust(Duration.seconds(5));

          const withParentQuestion = [
            first,
            pendingQuestion(
              "q-1",
              yield* now,
              question("Scope", "All files?"),
              {
                route: "parent",
              }
            ),
          ];

          yield* showRequests(table, threadId, withParentQuestion);
          yield* idle;

          yield* TestClock.adjust(Duration.seconds(5));
          yield* showRequests(table, threadId, [
            ...withParentQuestion,
            pendingQuestion(
              "q-2",
              yield* now,
              question("Database", "Which database?")
            ),
          ]);
          yield* waitUntil(() => service.messages.length >= 2);

          assert.deepStrictEqual(
            service.messages.map((message) => [message.tag, message.body]),
            [
              [`ask:${threadId}`, "Go? Fix the parser"],
              [
                `ask:${threadId}`,
                "2 things need you. Database: Which database?",
              ],
            ]
          );
        })
      );
    }
  );

  it.effect(
    "reminds once, 15 minutes after the push, while the request waits",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const threadId = yield* makeThread(1);

          yield* showRequests(table, threadId, [
            pendingBrief("brief-1", yield* now, "Fix the parser"),
          ]);
          yield* waitUntil(() => service.messages.length >= 1);

          yield* TestClock.adjust(Duration.minutes(14));
          yield* idle;

          assert.strictEqual(service.messages.length, 1);

          yield* TestClock.adjust(Duration.minutes(1));
          yield* waitUntil(() => service.messages.length >= 2);
          yield* TestClock.adjust(Duration.hours(2));
          yield* idle;

          assert.deepStrictEqual(bodies(service), [
            "Go? Fix the parser",
            "Still waiting. Go? Fix the parser",
          ]);
        })
      );
    }
  );

  it.effect(
    "pushes an escalated question once, from the parent, naming the child, unless a page shows either",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const parent = yield* makeThread(1);
          const child = yield* makeThread(2, Option.some(parent));
          const at = yield* now;

          const escalated = escalatedQuestion(
            "q-1",
            at - 30_000,
            at,
            question("Database", "Which database?"),
            child
          );

          yield* showRequests(table, child, [escalated.child]);
          yield* showRequests(table, parent, [escalated.mirror]);
          yield* waitUntil(() => service.messages.length >= 1);
          yield* idle;

          assert.deepStrictEqual(
            service.messages.map((message) => [
              message.title,
              message.body,
              message.url,
            ]),
            [
              [
                "Thread 1",
                "Thread 2 asks: Database: Which database?",
                `/t/${parent}`,
              ],
            ]
          );

          // A second escalation while a page shows the child (its home thread) is suppressed.
          yield* watch(Option.some(child));

          const second = escalatedQuestion(
            "q-2",
            at,
            at + 1,
            question("Name", "What is it called?"),
            child
          );

          yield* showRequests(table, parent, [escalated.mirror, second.mirror]);
          yield* idle;

          assert.strictEqual(service.messages.length, 1);
        })
      );
    }
  );

  it.effect(
    "suppresses a subagent's approval while a page shows its parent",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const parent = yield* makeThread(1);
          const child = yield* makeThread(2, Option.some(parent));

          yield* watch(Option.some(parent));
          yield* showRequests(table, child, [
            pendingRecord("tool-1", yield* now),
          ]);
          yield* idle;

          assert.deepStrictEqual(service.messages, []);
        })
      );
    }
  );

  it.effect(
    "counts threads with a request in the badge, beside unseen results",
    () => {
      const service = fakePushService();
      const table = recordTable();

      return withNotifier(
        service,
        table,
        Effect.gen(function* () {
          const done = yield* makeThread(1);
          const asking = yield* makeThread(2);
          const at = yield* now;

          yield* patchThread(done, {
            latestRunStartedAt: Option.some(
              Option.some(DateTime.makeUnsafe(at - 5000))
            ),
            latestRunCompletedAt: Option.some(
              Option.some(DateTime.makeUnsafe(at - 1000))
            ),
          });
          yield* showRequests(table, asking, [pendingRecord("tool-1", at)]);
          yield* waitUntil(() => service.messages.length >= 1);

          assert.deepStrictEqual(
            service.messages.map((message) => message.badge),
            [2]
          );
        })
      );
    }
  );

  it.effect(
    "sends nothing again after a restart, and owes the late push across it",
    () => {
      const service = fakePushService();
      const table = recordTable();

      const runNotifier = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              Notifier.layerNoDeps.pipe(
                Layer.provide(Layer.merge(service.layer, table.layer))
              )
            );

            yield* idle;

            return yield* body.pipe(Effect.provideContext(context));
          })
        );

      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        yield* subscribePhone;

        const pushed = yield* makeThread(1);
        const watched = yield* makeThread(2);

        yield* runNotifier(
          Effect.gen(function* () {
            yield* showRequests(table, pushed, [
              pendingRecord("tool-1", yield* now),
            ]);
            yield* waitUntil(() => service.messages.length >= 1);
            yield* watch(Option.some(watched));
            yield* showRequests(table, watched, [
              pendingRecord("tool-2", yield* now),
            ]);
            yield* idle;
            yield* Notifier.use((notifier) => notifier.settle);
          })
        );

        assert.strictEqual(service.messages.length, 1);

        // The brain restarts 2 minutes later, when the page's report is stale: the first push stays sent, and
        // the suppressed request is owed its late push, once.
        yield* TestClock.adjust(Duration.minutes(2));

        yield* runNotifier(
          Effect.gen(function* () {
            yield* waitUntil(() => service.messages.length >= 2);
            yield* Notifier.use((notifier) => notifier.sweep);
            yield* idle;
            yield* Notifier.use((notifier) => notifier.settle);
          })
        );

        assert.deepStrictEqual(
          service.messages.map((message) => message.title),
          ["Thread 1", "Thread 2"]
        );
      }).pipe(Effect.provide(StoreLayer));
    }
  );
});
