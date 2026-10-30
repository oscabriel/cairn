// The bridge's projector signals through the real shell projector and shell store, over the bridge
// on a scripted Claude Code (`BridgeProvider.layerTest`):
//
// - five concurrent bridge threads with four generation permits show exactly one row waiting for a
//   Claude slot, and that row stops waiting when a permit frees;
// - a run that fails on a spent plan window gets the window's reset time on its row, and a run that
//   fails on a Codex or OpenCode Go limit does not, even while a Claude window is spent.
//
// The pure helpers are judged first.

import { claudeModels, DEFAULT_LONG_CONTEXT } from "@cairn/bridge/ClaudeModels";
import { providerContext } from "@cairn/bridge/ClaudeProvider";
import {
  initEvent,
  SCRIPT_SESSION,
  textTurn,
} from "@cairn/bridge/ClaudeScriptKit";
import type { FakeScript } from "@cairn/bridge/ClaudeSdk";
import { ClaudeSdkScripts } from "@cairn/bridge/ClaudeSdk";
import { INITIAL_READING } from "@cairn/bridge/ClaudeUsage";
import type { UsageWindow } from "@cairn/bridge/ClaudeUsage";
import { RunId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Stream,
} from "effect";

import { HarnessSeam, RunStarted, RunTerminal } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { BridgeProvider } from "../models/BridgeProvider.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ShellProjector } from "../shell/ShellProjector.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import {
  applyWait,
  ClaudeSignals,
  spentWindowsResetAt,
} from "./ClaudeSignals.ts";

const window = (
  id: string,
  usedPercent: number,
  resetsAt: Option.Option<number>,
  exhausted = false
): UsageWindow => ({
  id,
  kind: "session",
  label: id,
  windowDurationMins: Option.none(),
  usedPercent,
  resetsAt,
  observedAt: 0,
  exhausted,
});

describe("the bridge's signal helpers", () => {
  it("reports a thread waiting only when its first session starts waiting, and free when its last stops", () => {
    const thread = testThreadId(1);
    const [first, one] = applyWait(new Map(), thread, "a", true);
    const [second, two] = applyWait(one, thread, "b", true);
    const [third, three] = applyWait(two, thread, "a", false);
    const [fourth, none] = applyWait(three, thread, "b", false);

    assert.deepStrictEqual(
      [first, second, third, fourth],
      [
        Option.some("claude_slot"),
        Option.none(),
        Option.none(),
        Option.some("none"),
      ]
    );
    assert.strictEqual(none.size, 0);
  });

  it("takes the latest reset among spent windows and ignores the others", () => {
    const reading = {
      ...INITIAL_READING,
      windows: [
        window("five_hour", 100, Option.some(5000)),
        window("seven_day", 40, Option.some(9000)),
        window("seven_day_opus", 80, Option.some(7000), true),
        window("monthly_spend", 100, Option.none()),
      ],
    };

    assert.deepStrictEqual(
      spentWindowsResetAt(reading),
      Option.some(DateTime.makeUnsafe(7000))
    );
    assert.deepStrictEqual(
      spentWindowsResetAt({ ...INITIAL_READING, windows: [] }),
      Option.none()
    );
  });
});

/** The harness events the test publishes. */
class Events extends Context.Service<
  Events,
  { readonly pubsub: PubSub.PubSub<HarnessEvent> }
>()("cairn/server/usage/ClaudeSignals.test/Events") {}

const unsupported = () => Effect.die("not used by this test");

const FakeHarness = Layer.effectContext(
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<HarnessEvent>();

    return Context.make(Events, Events.of({ pubsub })).pipe(
      Context.add(
        HarnessSeam,
        HarnessSeam.of({
          ensureThread: unsupported,
          configure: unsupported,
          submit: unsupported,
          stop: unsupported,
          withdraw: unsupported,
          respond: unsupported,
          write: unsupported,
          compact: unsupported,
          watch: () => Stream.die("not used by this test"),
          whenEnsured: unsupported,
          document: unsupported,
          history: unsupported,
          entry: unsupported,
          entryImage: unsupported,
          events: Stream.fromPubSub(pubsub),
          inspect: Effect.succeed([]),
          retry: unsupported,
          capabilities: { durable: false, live: false },
        })
      )
    );
  })
);

/** Lets the scripted children finish, one per offer. */
class Releases extends Context.Service<
  Releases,
  { readonly queue: Queue.Queue<true> }
>()("cairn/server/usage/ClaudeSignals.test/Releases") {}

/** Each child waits for one release, then answers. */
const waitsForRelease =
  (releases: Queue.Queue<true>): FakeScript =>
  (io) =>
    Effect.gen(function* () {
      yield* io.nextPrompt;
      yield* Queue.take(releases);
      yield* io.emit(
        initEvent(SCRIPT_SESSION),
        ...textTurn("m1", "u1", "done")
      );

      return yield* Effect.never;
    });

const Scripts = Layer.effectContext(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<true>();

    const scripts = yield* ClaudeSdkScripts.make(
      Array.from({ length: 5 }, () => waitsForRelease(queue))
    );

    return Context.make(Releases, Releases.of({ queue })).pipe(
      Context.add(ClaudeSdkScripts, scripts)
    );
  })
);

const TestLayer = ShellProjector.layer.pipe(
  Layer.provide(ClaudeSignals),
  Layer.provideMerge(BridgeProvider.layerTest),
  Layer.provideMerge(Scripts),
  Layer.provideMerge(FakeHarness),
  Layer.provideMerge(ShellTestLayer)
);

const model = Option.getOrThrow(
  Option.fromNullishOr(
    claudeModels(DEFAULT_LONG_CONTEXT).find(
      (candidate) => candidate.id === "claude-haiku-5-5"
    )
  )
);

const THREADS = [1, 2, 3, 4, 5].map((n) => testThreadId(n));

const seed = Effect.gen(function* () {
  const sink = yield* EventSink;
  const project = createProject(1);

  yield* sink.commitCommand(project.command);

  for (let n = 1; n <= THREADS.length; n += 1) {
    yield* sink.commitCommand(createThread(project.projectId, n));
  }
});

const rowOf = Effect.fnUntraced(function* (threadId: ThreadId) {
  const row = yield* (yield* ThreadRows).get(threadId);

  return Option.getOrThrow(row).shell;
});

const waitingRows = Effect.gen(function* () {
  const rows = yield* Effect.forEach(THREADS, rowOf);

  return rows
    .filter((row) => row.waitingFor === "claude_slot")
    .map((row) => row.id);
});

/** Polls `check` every 20 ms until it holds, for at most 3 s. */
const eventually = <A, E>(
  read: Effect.Effect<A, E, ThreadRows>,
  check: (value: A) => boolean
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 3000;
    let value = yield* read;

    while (!check(value) && (yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(Duration.millis(20));
      value = yield* read;
    }

    return value;
  });

/** One bridge call for `threadId`, as the brain makes it after the `bridge-cwd` hook noted it. */
const call = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const bridge = yield* BridgeProvider;
    const claude = Option.getOrThrow(bridge.claude);
    const sessionId = `session-${threadId}`;

    yield* claude.noteConversation(sessionId, {
      cwd: "/",
      threadId: Option.some(threadId),
    });

    const stream = claude.provider.streamSimple(
      model,
      providerContext([{ role: "user", content: "go", timestamp: 1 }]),
      { sessionId }
    );

    return yield* Effect.promise(
      async (): Promise<AssistantMessage> => await stream.result()
    );
  });

describe("the bridge's projector signals", () => {
  it.live(
    "five concurrent bridge threads with four permits show exactly one row waiting for a Claude slot, cleared when a permit frees",
    () =>
      Effect.gen(function* () {
        yield* seed;

        const calls = yield* Effect.forkChild(
          Effect.forEach(THREADS, call, { concurrency: "unbounded" })
        );

        const waiting = yield* eventually(waitingRows, (ids) => ids.length > 0);

        // Settle: no second row may join while four generate and one waits.
        yield* Effect.sleep(Duration.millis(200));

        const still = yield* waitingRows;

        assert.strictEqual(waiting.length, 1);
        assert.deepStrictEqual(still, waiting);

        // One generating child finishes; its permit goes to the waiting thread.
        const { queue } = yield* Releases;

        yield* Queue.offer(queue, true);

        const after = yield* eventually(waitingRows, (ids) => ids.length === 0);

        assert.deepStrictEqual(after, []);

        yield* Queue.offerAll(queue, [true, true, true, true]);

        const replies = yield* Fiber.join(calls);

        assert.deepStrictEqual(
          replies.map((reply) => reply.stopReason),
          THREADS.map(() => "stop")
        );
        assert.deepStrictEqual(yield* waitingRows, []);
      }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "gives a run that failed on a spent plan window the window's reset time",
    () =>
      Effect.gen(function* () {
        yield* seed;

        const bridge = yield* BridgeProvider;
        const usage = Option.getOrThrow(bridge.usage);
        const { pubsub } = yield* Events;
        const thread = THREADS[0] ?? testThreadId(1);
        const resetsAtSeconds = 1_900_000_000;

        // The rejecting turn's `rate_limit_event`, as the bridge feeds it to the usage service.
        yield* usage.observe({
          status: "rejected",
          resetsAt: resetsAtSeconds,
          rateLimitType: "five_hour",
          utilization: 1,
        });

        const at = DateTime.makeUnsafe(1_800_000_000_000);

        yield* PubSub.publish(
          pubsub,
          RunStarted.make({ threadId: thread, runId: RunId.make(1), at })
        );
        yield* PubSub.publish(
          pubsub,
          RunTerminal.make({
            threadId: thread,
            runId: RunId.make(1),
            status: "failed",
            failure: Option.some({
              class: "usage_limit",
              retryable: false,
              resetAt: Option.none(),
              plan: Option.some("claude"),
            }),
            at,
          })
        );

        const row = yield* eventually(rowOf(thread), (shell) =>
          Option.isSome(shell.usageLimitResetAt)
        );

        assert.deepStrictEqual(row.lastErrorClass, Option.some("usage_limit"));
        assert.deepStrictEqual(
          row.usageLimitResetAt,
          Option.some(DateTime.makeUnsafe(resetsAtSeconds * 1000))
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "leaves a Codex or OpenCode Go limit alone while a Claude window is spent",
    () =>
      Effect.gen(function* () {
        yield* seed;

        const bridge = yield* BridgeProvider;
        const usage = Option.getOrThrow(bridge.usage);
        const { pubsub } = yield* Events;

        const [
          claude = testThreadId(1),
          codex = testThreadId(2),
          go = testThreadId(3),
        ] = THREADS;

        const at = DateTime.makeUnsafe(1_800_000_000_000);
        const codexReset = DateTime.makeUnsafe(1_800_001_800_000);

        // A spent Claude window, so a signal for any thread would patch it without a probe.
        yield* usage.observe({
          status: "rejected",
          resetsAt: 1_900_000_000,
          rateLimitType: "five_hour",
          utilization: 1,
        });

        const failed = (
          threadId: ThreadId,
          run: number,
          plan: "claude" | "codex" | "opencode-go",
          resetAt: Option.Option<DateTime.Utc>
        ) =>
          Effect.gen(function* () {
            yield* PubSub.publish(
              pubsub,
              RunStarted.make({ threadId, runId: RunId.make(run), at })
            );
            yield* PubSub.publish(
              pubsub,
              RunTerminal.make({
                threadId,
                runId: RunId.make(run),
                status: "failed",
                failure: Option.some({
                  class: "usage_limit",
                  retryable: false,
                  resetAt,
                  plan: Option.some(plan),
                }),
                at,
              })
            );
          });

        yield* failed(codex, 1, "codex", Option.some(codexReset));
        yield* failed(go, 2, "opencode-go", Option.none());
        yield* failed(claude, 3, "claude", Option.none());

        // The Claude thread's patch comes after the other two events were read.
        yield* eventually(rowOf(claude), (shell) =>
          Option.isSome(shell.usageLimitResetAt)
        );
        yield* Effect.sleep(Duration.millis(200));

        assert.deepStrictEqual(
          (yield* rowOf(codex)).usageLimitResetAt,
          Option.some(codexReset)
        );
        assert.deepStrictEqual(
          (yield* rowOf(go)).usageLimitResetAt,
          Option.none()
        );
      }).pipe(Effect.provide(TestLayer))
  );
});
