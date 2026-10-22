// The shell projector over recorded harness event sequences: each sequence's rows are written out
// by hand from the field mapping (notes/server.md, "Shell store and the projector"); the debounce
// commits at most one activity event per thread per 50 ms window and nothing when nothing changed;
// a parked task shows and clears; and the boot reconcile repairs rows a lost event left wrong.
import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
  TaskId,
} from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ConversationView } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Random,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";

import {
  HarnessError,
  HarnessSeam,
  MessageCommitted,
  QueueChanged,
  RunStarted,
  RunTerminal,
  RuntimeRequestUpdated,
  TaskParked,
  UsageUpdated,
} from "../brain/HarnessSeam.ts";
import type { HarnessEvent, LiveThreadState } from "../brain/HarnessSeam.ts";
import { EventSink } from "./EventSink.ts";
import { EventStore } from "./EventStore.ts";
import { ProjectorSignals } from "./ProjectorSignals.ts";
import type { ProjectorSignal } from "./ProjectorSignals.ts";
import { emptyActivityPatch, ThreadActivityUpdate } from "./ShellCommands.ts";
import {
  applyHarnessEvent,
  FAILURE_TEXT,
  latestMessageOf,
  projectionOf,
  ShellProjector,
} from "./ShellProjector.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testCommandId,
  testThreadId,
} from "./ShellTestKit.ts";
import { ThreadRows } from "./ThreadRows.ts";

/** What the fake harness answers and how the test feeds it. */
class FakeHarness extends Context.Service<
  FakeHarness,
  {
    readonly events: PubSub.PubSub<HarnessEvent>;
    readonly signals: PubSub.PubSub<ProjectorSignal>;
    readonly live: Ref.Ref<ReadonlyArray<LiveThreadState>>;
    readonly views: Ref.Ref<ReadonlyMap<ThreadId, ConversationView>>;
  }
>()("cairn/server/shell/ShellProjector.test/FakeHarness") {}

const unsupported = (operation: string) =>
  Effect.die(`the fake harness does not ${operation}`);

const FakeLayer = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<HarnessEvent>();
    const signals = yield* PubSub.unbounded<ProjectorSignal>();
    const live = yield* Ref.make<ReadonlyArray<LiveThreadState>>([]);

    const views = yield* Ref.make<ReadonlyMap<ThreadId, ConversationView>>(
      new Map()
    );

    const seam = HarnessSeam.of({
      ensureThread: () => unsupported("ensure threads"),
      configure: () => unsupported("configure"),
      submit: () => unsupported("submit"),
      stop: () => unsupported("stop"),
      withdraw: () => unsupported("withdraw"),
      respond: () => unsupported("respond"),
      compact: () => unsupported("compact"),
      watch: (threadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const view = (yield* Ref.get(views)).get(threadId);

            if (view === undefined) {
              return yield* new HarnessError({
                message: "no such thread",
                reason: "thread_not_found",
                retryable: false,
                threadId: Option.some(threadId),
              });
            }

            return Stream.make({
              _tag: "Snapshot" as const,
              seq: 0,
              view,
              entriesOffset: 0,
              hasMoreHistory: false,
            });
          })
        ),
      history: () => unsupported("page history"),
      entry: () => unsupported("read entries"),
      entryImage: () => unsupported("read images"),
      events: Stream.fromPubSub(events),
      inspect: Ref.get(live),
      retry: () => unsupported("retry"),
      capabilities: { durable: false, live: false },
    });

    return Context.make(HarnessSeam, seam).pipe(
      Context.add(
        ProjectorSignals,
        ProjectorSignals.of({ signals: Stream.fromPubSub(signals) })
      ),
      Context.add(FakeHarness, FakeHarness.of({ events, signals, live, views }))
    );
  })
);

const TestLayer = ShellProjector.layer.pipe(
  Layer.provideMerge(FakeLayer),
  Layer.provideMerge(ShellTestLayer)
);

const run = <A, E>(
  body: Effect.Effect<A, E, Layer.Success<typeof TestLayer> | Scope.Scope>
) => body.pipe(Effect.scoped, Effect.provide(TestLayer));

const at = (seconds: number) =>
  DateTime.makeUnsafe(1_760_000_000_000 + seconds * 1000);

const THREAD = testThreadId(1);

/** A project and thread 1 (and more when asked) in the shell store. */
const seedThreads = Effect.fnUntraced(function* (count = 1) {
  const sink = yield* EventSink;
  const project = createProject(1);

  yield* sink.commitCommand(project.command);

  for (let n = 1; n <= count; n += 1) {
    yield* sink.commitCommand(createThread(project.projectId, n));
  }
});

/** Lets the projector's fibers take every event, then passes the window so every flush lands. */
const settle = Effect.gen(function* () {
  for (let round = 0; round < 6; round += 1) {
    yield* Effect.yieldNow;
    yield* TestClock.adjust("20 millis");
  }
});

const emit = Effect.fnUntraced(function* (events: ReadonlyArray<HarnessEvent>) {
  const fake = yield* FakeHarness;

  for (const event of events) {
    yield* PubSub.publish(fake.events, event);
  }

  yield* settle;
});

const shellOf = Effect.fnUntraced(function* (threadId: ThreadId) {
  const row = yield* (yield* ThreadRows).get(threadId);

  assert.isTrue(Option.isSome(row));

  return Option.getOrThrow(row).shell;
});

/** How many `thread.activity-updated` events the log holds for `threadId`. */
const activityEvents = Effect.fnUntraced(function* (threadId: ThreadId) {
  const store = yield* EventStore;
  const latest = yield* store.latestSequence;

  const events = yield* store
    .readRange({ afterSequence: 0, throughSequence: latest })
    .pipe(Stream.runCollect);

  return events.filter(
    (event) =>
      event.type === "thread.activity-updated" && event.aggregateId === threadId
  ).length;
});

const run7 = RunId.make(7);

const finishedView: ConversationView = {
  conversation: { id: ConversationId.make(1) },
  entries: [
    {
      id: EntryId.make(1),
      conversationId: ConversationId.make(1),
      kind: "cairn.user",
      model: [
        {
          role: "user",
          content: [{ type: "text", text: "go" }],
          timestamp: 1_760_000_001_000,
        },
      ],
    },
    {
      id: EntryId.make(2),
      conversationId: ConversationId.make(1),
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "all " },
            { type: "text", text: "done" },
          ],
          timestamp: 1_760_000_002_000,
        },
      ],
    },
    {
      id: EntryId.make(3),
      conversationId: ConversationId.make(1),
      kind: "pi.tool-result",
      model: [
        { role: "toolResult", content: [], timestamp: 1_760_000_003_000 },
      ],
    },
  ],
  docs: {},
};

describe("the shell projector", () => {
  it.effect("projects a simple turn: running while it runs, idle after", () =>
    run(
      Effect.gen(function* () {
        yield* seedThreads();

        yield* emit([
          RunStarted.make({ threadId: THREAD, runId: run7, at: at(1) }),
          MessageCommitted.make({
            threadId: THREAD,
            entryId: EntryId.make(1),
            role: "user",
            text: "hello",
            at: at(1),
          }),
        ]);

        const running = yield* shellOf(THREAD);

        assert.strictEqual(running.activity, "running");
        assert.deepStrictEqual(running.activeRunId, Option.some(run7));
        assert.deepStrictEqual(running.latestRunStartedAt, Option.some(at(1)));
        assert.deepStrictEqual(running.latestUserMessageAt, Option.some(at(1)));

        yield* emit([
          QueueChanged.make({ threadId: THREAD, length: 0 }),
          MessageCommitted.make({
            threadId: THREAD,
            entryId: EntryId.make(2),
            role: "assistant",
            text: "hi there",
            at: at(2),
          }),
          RunTerminal.make({
            threadId: THREAD,
            runId: run7,
            status: "completed",
            failure: Option.none(),
            at: at(3),
          }),
        ]);

        const done = yield* shellOf(THREAD);

        assert.strictEqual(done.activity, "idle");
        assert.deepStrictEqual(done.activeRunId, Option.none());
        assert.deepStrictEqual(done.latestRunRequestedAt, Option.some(at(1)));
        assert.deepStrictEqual(done.latestRunStartedAt, Option.some(at(1)));
        assert.deepStrictEqual(done.latestRunCompletedAt, Option.some(at(3)));
        assert.deepStrictEqual(done.latestUserMessageAt, Option.some(at(1)));
        assert.deepStrictEqual(
          done.latestVisibleMessage,
          Option.some({
            entryId: EntryId.make(2),
            role: "assistant" as const,
            text: "hi there",
            at: at(2),
          })
        );
        assert.deepStrictEqual(done.lastError, Option.none());
        assert.strictEqual(done.queueLength, 0);
      })
    )
  );

  it.effect(
    "a usage-limit failure keeps the queue, says why, and clears at the next run",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedThreads();

          yield* emit([
            RunStarted.make({ threadId: THREAD, runId: run7, at: at(1) }),
            QueueChanged.make({ threadId: THREAD, length: 1 }),
            RunTerminal.make({
              threadId: THREAD,
              runId: run7,
              status: "failed",
              failure: Option.some({
                class: "usage_limit",
                retryable: false,
                resetAt: Option.some(at(3600)),
              }),
              at: at(2),
            }),
          ]);

          const failed = yield* shellOf(THREAD);

          assert.strictEqual(failed.activity, "failed");
          assert.strictEqual(failed.queueLength, 1);
          assert.deepStrictEqual(
            failed.lastErrorClass,
            Option.some("usage_limit" as const)
          );
          assert.deepStrictEqual(
            failed.lastError,
            Option.some(FAILURE_TEXT.usage_limit)
          );
          assert.deepStrictEqual(
            failed.usageLimitResetAt,
            Option.some(at(3600))
          );

          yield* emit([
            RunStarted.make({
              threadId: THREAD,
              runId: RunId.make(9),
              at: at(4000),
            }),
          ]);

          const again = yield* shellOf(THREAD);

          assert.strictEqual(again.activity, "running");
          assert.deepStrictEqual(again.lastError, Option.none());
          assert.deepStrictEqual(again.lastErrorClass, Option.none());
          assert.deepStrictEqual(again.usageLimitResetAt, Option.none());
        })
      )
  );

  it.effect(
    "an interrupted run is idle, not failed; a provider error is failed",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedThreads(2);

          yield* emit([
            RunStarted.make({ threadId: THREAD, runId: run7, at: at(1) }),
            RunTerminal.make({
              threadId: THREAD,
              runId: run7,
              status: "interrupted",
              failure: Option.none(),
              at: at(2),
            }),
            RunStarted.make({
              threadId: testThreadId(2),
              runId: RunId.make(8),
              at: at(1),
            }),
            RunTerminal.make({
              threadId: testThreadId(2),
              runId: RunId.make(8),
              status: "failed",
              failure: Option.some({
                class: "provider_error",
                retryable: true,
                resetAt: Option.none(),
              }),
              at: at(2),
            }),
          ]);

          assert.strictEqual((yield* shellOf(THREAD)).activity, "idle");

          const failed = yield* shellOf(testThreadId(2));

          assert.strictEqual(failed.activity, "failed");
          assert.deepStrictEqual(
            failed.lastErrorClass,
            Option.some("provider_error" as const)
          );
        })
      )
  );

  it.effect(
    "a pending approval makes a running thread wait, oldest first",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedThreads();

          const first = ApprovalId.make("apr_first");
          const second = ApprovalId.make("apr_second");

          yield* emit([
            RunStarted.make({ threadId: THREAD, runId: run7, at: at(1) }),
            RuntimeRequestUpdated.make({
              threadId: THREAD,
              id: first,
              kind: "executor-call",
              status: "pending",
            }),
            RuntimeRequestUpdated.make({
              threadId: THREAD,
              id: second,
              kind: "tool-call",
              status: "pending",
            }),
          ]);

          const waiting = yield* shellOf(THREAD);

          assert.strictEqual(waiting.activity, "waiting");
          assert.deepStrictEqual(
            Option.map(waiting.pendingRuntimeRequest, (request) => [
              request.id,
              request.kind,
            ]),
            Option.some([first, "executor-call"])
          );

          yield* emit([
            RuntimeRequestUpdated.make({
              threadId: THREAD,
              id: first,
              kind: "executor-call",
              status: "accepted",
            }),
          ]);

          const next = yield* shellOf(THREAD);

          assert.strictEqual(next.activity, "waiting");
          assert.deepStrictEqual(
            Option.map(next.pendingRuntimeRequest, (request) => request.id),
            Option.some(second)
          );

          yield* emit([
            RuntimeRequestUpdated.make({
              threadId: THREAD,
              id: second,
              kind: "tool-call",
              status: "declined",
            }),
          ]);

          const answered = yield* shellOf(THREAD);

          assert.strictEqual(answered.activity, "running");
          assert.deepStrictEqual(answered.pendingRuntimeRequest, Option.none());
        })
      )
  );

  it.effect(
    "a parked task parks the thread, and the next event clears it once the brain no longer has it",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedThreads();

          const fake = yield* FakeHarness;
          const task = TaskId.make(11);

          yield* emit([
            RunStarted.make({ threadId: THREAD, runId: run7, at: at(1) }),
            TaskParked.make({ threadId: THREAD, taskId: task }),
          ]);

          const parked = yield* shellOf(THREAD);

          assert.strictEqual(parked.activity, "parked");
          assert.deepStrictEqual(parked.parkedTaskIds, [task]);

          // Retried: the brain no longer lists the task, and the run goes on.
          yield* Ref.set(fake.live, [
            {
              threadId: THREAD,
              conversationId: ConversationId.make(1),
              runId: Option.some(run7),
              queueLength: 0,
              parkedTaskIds: [],
              pendingApprovals: [],
            },
          ]);

          yield* emit([
            MessageCommitted.make({
              threadId: THREAD,
              entryId: EntryId.make(5),
              role: "assistant",
              text: "back",
              at: at(9),
            }),
          ]);

          const retried = yield* shellOf(THREAD);

          assert.strictEqual(retried.activity, "running");
          assert.deepStrictEqual(retried.parkedTaskIds, []);
        })
      )
  );

  it.effect("projector signals set waitingFor and the reset time", () =>
    run(
      Effect.gen(function* () {
        yield* seedThreads();

        const fake = yield* FakeHarness;

        yield* PubSub.publish(
          fake.signals,
          ProjectorSignals.waiting(THREAD, "claude_slot")
        );
        yield* PubSub.publish(fake.signals, {
          threadId: THREAD,
          patch: {
            waitingFor: Option.none(),
            usageLimitResetAt: Option.some(Option.some(at(7200))),
          },
        });
        yield* settle;

        const row = yield* shellOf(THREAD);

        assert.strictEqual(row.waitingFor, "claude_slot");
        assert.deepStrictEqual(row.usageLimitResetAt, Option.some(at(7200)));

        // A run that ends no longer waits for a slot.
        yield* emit([
          RunStarted.make({ threadId: THREAD, runId: run7, at: at(1) }),
          RunTerminal.make({
            threadId: THREAD,
            runId: run7,
            status: "completed",
            failure: Option.none(),
            at: at(2),
          }),
        ]);

        assert.strictEqual((yield* shellOf(THREAD)).waitingFor, "none");
      })
    )
  );

  it.effect(
    "debounces: one commit leads, one trails, and a change that changes nothing commits nothing",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedThreads();

          const fake = yield* FakeHarness;
          const before = yield* activityEvents(THREAD);

          // Five messages 10 ms apart, each handled before the next arrives: the first commits at
          // once, the other four wait for the window to close and commit together.
          for (let n = 1; n <= 5; n += 1) {
            yield* PubSub.publish(
              fake.events,
              MessageCommitted.make({
                threadId: THREAD,
                entryId: EntryId.make(n),
                role: "assistant",
                text: `message ${n}`,
                at: at(n),
              })
            );

            for (let turn = 0; turn < 5; turn += 1) {
              yield* Effect.yieldNow;
            }

            if (n === 1) {
              assert.strictEqual((yield* activityEvents(THREAD)) - before, 1);
            }

            yield* TestClock.adjust("10 millis");
          }

          yield* settle;

          const commits = (yield* activityEvents(THREAD)) - before;

          assert.strictEqual(commits, 2);
          assert.deepStrictEqual(
            Option.map(
              (yield* shellOf(THREAD)).latestVisibleMessage,
              (message) => message.text
            ),
            Option.some("message 5")
          );

          // Usage and a repeated queue length change no row field.
          yield* emit([
            UsageUpdated.make({
              threadId: THREAD,
              inputTokens: 10,
              outputTokens: 20,
            }),
            QueueChanged.make({ threadId: THREAD, length: 0 }),
          ]);

          assert.strictEqual((yield* activityEvents(THREAD)) - before, commits);
        })
      )
  );

  it.effect(
    "random event streams flushed at random times end equal to one fold of the whole stream",
    () =>
      run(
        Effect.gen(function* () {
          const threads = 3;

          yield* seedThreads(threads);

          const fake = yield* FakeHarness;
          const initial = new Map<ThreadId, ReturnType<typeof projectionOf>>();

          for (let n = 1; n <= threads; n += 1) {
            initial.set(
              testThreadId(n),
              projectionOf(yield* shellOf(testThreadId(n)))
            );
          }

          const folded = new Map(initial);
          const running = new Map<ThreadId, RunId>();
          let nextRun = 100;

          for (let step = 0; step < 300; step += 1) {
            const threadId = testThreadId(
              yield* Random.nextIntBetween(1, threads)
            );

            const choice = yield* Random.nextIntBetween(0, 4);
            const now = yield* DateTime.now;
            const active = running.get(threadId);
            let event: HarnessEvent;

            if (choice === 0 && active === undefined) {
              const runId = RunId.make(nextRun);

              nextRun += 1;
              running.set(threadId, runId);
              event = RunStarted.make({ threadId, runId, at: now });
            } else if (choice === 1 && active !== undefined) {
              running.delete(threadId);
              event = RunTerminal.make({
                threadId,
                runId: active,
                status: (yield* Random.nextBoolean) ? "completed" : "failed",
                failure: Option.none(),
                at: now,
              });
            } else if (choice === 2) {
              event = QueueChanged.make({
                threadId,
                length: yield* Random.nextIntBetween(0, 4),
              });
            } else {
              event = MessageCommitted.make({
                threadId,
                entryId: EntryId.make(step + 1),
                role: (yield* Random.nextBoolean) ? "user" : "assistant",
                text: `step ${step}`,
                at: now,
              });
            }

            const current = folded.get(threadId);

            assert.isDefined(current);

            if (current !== undefined) {
              folded.set(threadId, applyHarnessEvent(current, event, now));
            }

            yield* PubSub.publish(fake.events, event);

            if ((yield* Random.nextIntBetween(0, 3)) === 0) {
              yield* Effect.yieldNow;
              yield* TestClock.adjust(
                `${yield* Random.nextIntBetween(1, 79)} millis`
              );
            }
          }

          yield* settle;

          for (const [threadId, projection] of folded) {
            const row = yield* shellOf(threadId);

            assert.deepStrictEqual(
              {
                activity: row.activity,
                activeRunId: row.activeRunId,
                queueLength: row.queueLength,
                latestVisibleMessage: row.latestVisibleMessage,
                latestRunStartedAt: row.latestRunStartedAt,
                latestRunCompletedAt: row.latestRunCompletedAt,
                lastErrorClass: row.lastErrorClass,
              },
              {
                activity: projection.fields.activity,
                activeRunId: projection.fields.activeRunId,
                queueLength: projection.fields.queueLength,
                latestVisibleMessage: projection.fields.latestVisibleMessage,
                latestRunStartedAt: projection.fields.latestRunStartedAt,
                latestRunCompletedAt: projection.fields.latestRunCompletedAt,
                lastErrorClass: projection.fields.lastErrorClass,
              }
            );
          }
        })
      )
  );

  it.effect(
    "the boot reconcile ends runs nobody saw end, starts the ones the brain still runs, and restores the preview",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedThreads(3);

          const fake = yield* FakeHarness;
          const sink = yield* EventSink;
          const projector = yield* ShellProjector;

          // Thread 1's row says running, but its run ended while the brain was down.
          yield* sink.commitCommand(
            ThreadActivityUpdate.make({
              commandId: testCommandId(900),
              threadId: THREAD,
              patch: {
                ...emptyActivityPatch,
                activity: Option.some("running"),
                activeRunId: Option.some(Option.some(run7)),
              },
            })
          );

          yield* Ref.set(fake.views, new Map([[THREAD, finishedView]]));

          yield* Ref.set(fake.live, [
            {
              threadId: testThreadId(2),
              conversationId: ConversationId.make(2),
              runId: Option.some(RunId.make(9)),
              queueLength: 2,
              parkedTaskIds: [TaskId.make(4)],
              pendingApprovals: [],
            },
            {
              threadId: testThreadId(3),
              conversationId: ConversationId.make(3),
              runId: Option.some(RunId.make(10)),
              queueLength: 0,
              parkedTaskIds: [],
              pendingApprovals: [ApprovalId.make("apr_boot")],
            },
          ]);

          yield* TestClock.adjust("1 hour");

          const report = yield* projector.reconcile;

          assert.deepStrictEqual(report, { threads: 3, live: 2, patched: 3 });

          const ended = yield* shellOf(THREAD);

          assert.strictEqual(ended.activity, "idle");
          assert.deepStrictEqual(ended.activeRunId, Option.none());
          assert.isTrue(Option.isSome(ended.latestRunCompletedAt));
          assert.deepStrictEqual(
            Option.map(ended.latestVisibleMessage, (message) => message.text),
            Option.some("all done")
          );

          const parked = yield* shellOf(testThreadId(2));

          assert.strictEqual(parked.activity, "parked");
          assert.strictEqual(parked.queueLength, 2);
          assert.deepStrictEqual(parked.parkedTaskIds, [TaskId.make(4)]);

          const waiting = yield* shellOf(testThreadId(3));

          assert.strictEqual(waiting.activity, "waiting");
          assert.deepStrictEqual(
            Option.map(waiting.pendingRuntimeRequest, (request) => request.id),
            Option.some(ApprovalId.make("apr_boot"))
          );

          // A second reconcile finds nothing to change.
          assert.strictEqual((yield* projector.reconcile).patched, 0);
        })
      )
  );
});

describe("the newest message of a view", () => {
  it("reads the newest user or assistant message, text parts joined", () => {
    assert.deepStrictEqual(
      latestMessageOf(finishedView),
      Option.some({
        entryId: EntryId.make(2),
        role: "assistant" as const,
        text: "all done",
        at: DateTime.makeUnsafe(1_760_000_002_000),
      })
    );
  });

  it("finds nothing in a view without messages", () => {
    assert.deepStrictEqual(
      latestMessageOf({ ...finishedView, entries: [] }),
      Option.none()
    );
  });
});
