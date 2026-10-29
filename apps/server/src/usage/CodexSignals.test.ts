// A refused Codex turn marks its window spent on the Codex meter at once: faux `RunTerminal` events
// on a fake harness, into the real `CodexUsage` over a fake endpoint. A Claude or OpenCode Go limit,
// and a Codex run that failed for another reason, leave the meter alone. `UsageFeed.layer` gives
// the signal and the feed one reader, so the feed's Codex row shows the spent window.

import { RunId } from "@cairn/protocol/Ids";
import type { UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { HarnessSeam, RunTerminal } from "../brain/HarnessSeam.ts";
import type { HarnessEvent, UsageLimitPlan } from "../brain/HarnessSeam.ts";
import { BridgeProvider } from "../models/BridgeProvider.ts";
import { CodexAccess, parseCodexCredential } from "../models/CodexAccess.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { codexLimitOf, CodexSignals } from "./CodexSignals.ts";
import { CodexUsage } from "./CodexUsage.ts";
import { UsageFeed } from "./UsageFeed.ts";

/** A session window at 23 percent resetting at 1_793_178_000 s, and a weekly one at 41. */
const BODY = JSON.stringify({
  rate_limit: {
    limit_reached: false,
    primary_window: {
      used_percent: 23,
      limit_window_seconds: 18_000,
      reset_at: 1_793_178_000,
    },
    secondary_window: {
      used_percent: 41,
      limit_window_seconds: 604_800,
      reset_at: 1_793_512_800,
    },
  },
});

const terminal = (
  plan: Option.Option<UsageLimitPlan>,
  failureClass: "usage_limit" | "provider_error",
  resetAt: Option.Option<number>
): HarnessEvent =>
  RunTerminal.make({
    threadId: testThreadId(1),
    runId: RunId.make(1),
    status: "failed",
    failure: Option.some({
      class: failureClass,
      retryable: false,
      resetAt: Option.map(resetAt, (at) => DateTime.makeUnsafe(at)),
      plan,
    }),
    at: DateTime.makeUnsafe(1_793_177_000_000),
  });

describe("reading a Codex limit off a run", () => {
  it("takes a Codex usage limit with its reset, and nothing else", () => {
    assert.deepStrictEqual(
      codexLimitOf(
        terminal(Option.some("codex"), "usage_limit", Option.some(5000))
      ),
      Option.some(Option.some(5000))
    );
    assert.deepStrictEqual(
      codexLimitOf(
        terminal(Option.some("codex"), "usage_limit", Option.none())
      ),
      Option.some(Option.none())
    );
    assert.isTrue(
      Option.isNone(
        codexLimitOf(
          terminal(Option.some("claude"), "usage_limit", Option.none())
        )
      )
    );
    assert.isTrue(
      Option.isNone(
        codexLimitOf(
          terminal(Option.some("opencode-go"), "usage_limit", Option.none())
        )
      )
    );
    assert.isTrue(
      Option.isNone(
        codexLimitOf(terminal(Option.none(), "provider_error", Option.none()))
      )
    );
  });
});

/** The harness events the test publishes. */
class Events extends Context.Service<
  Events,
  { readonly pubsub: PubSub.PubSub<HarnessEvent> }
>()("cairn/server/usage/CodexSignals.test/Events") {}

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

const SignedIn = Layer.unwrap(
  Effect.map(
    parseCodexCredential({ access: "test-access-token", accountId: "acct_1" }),
    (credential) =>
      Layer.succeed(
        CodexAccess,
        CodexAccess.of({ credential: Effect.succeedSome(credential) })
      )
  ).pipe(Effect.orDie)
);

// One `CodexUsage`, shared by the signal and the test, as the root shares it with `UsageFeed`.
const Usage = CodexUsage.layerNoDeps.pipe(
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(BODY, { status: 200 })
          )
        )
      )
    )
  ),
  Layer.provide(SignedIn)
);

const TestLayer = CodexSignals.pipe(
  Layer.provideMerge(Usage),
  Layer.provideMerge(FakeHarness)
);

const spentIds = Effect.gen(function* () {
  const usage = yield* CodexUsage;

  return (yield* usage.current).windows
    .filter((window) => window.exhausted)
    .map((window) => window.id);
});

/** The ids of the windows a frame shows spent. */
const spentOnFeed = (frame: UsageSnapshot) =>
  frame.providers.flatMap((row) =>
    row.windows.filter((window) => window.exhausted).map((window) => window.id)
  );

/** The next frame off `frames` that `done` accepts. */
const takeUntil = (
  frames: Queue.Dequeue<UsageSnapshot>,
  done: (frame: UsageSnapshot) => boolean
) =>
  Effect.gen(function* () {
    for (;;) {
      const frame = yield* Queue.take(frames);

      if (done(frame)) {
        return frame;
      }
    }
  });

/** Lets the signal's fiber and the read it starts run. */
const settle = Effect.gen(function* () {
  for (const _ of [1, 2, 3, 4, 5]) {
    yield* Effect.yieldNow;
  }
});

describe("Codex signals", () => {
  it.effect(
    "marks the window a refused Codex turn names, and only for a Codex limit",
    () =>
      Effect.gen(function* () {
        const usage = yield* CodexUsage;
        const { pubsub } = yield* Events;

        yield* usage.read;
        assert.deepStrictEqual(yield* spentIds, []);

        yield* PubSub.publish(
          pubsub,
          terminal(Option.some("claude"), "usage_limit", Option.none())
        );
        yield* PubSub.publish(
          pubsub,
          terminal(Option.some("opencode-go"), "usage_limit", Option.none())
        );
        yield* settle;
        assert.deepStrictEqual(yield* spentIds, []);

        // Codex named a reset near the session window's.
        yield* PubSub.publish(
          pubsub,
          terminal(
            Option.some("codex"),
            "usage_limit",
            Option.some(1_793_178_060_000)
          )
        );
        yield* settle;
        assert.deepStrictEqual(yield* spentIds, ["five_hour"]);
      }).pipe(
        Effect.provide(TestLayer),
        // Near the windows' times, set before the reader starts.
        (test) => Effect.andThen(TestClock.setTime(1_793_177_000_000), test)
      )
  );
});

describe("the usage feed with Codex signals", () => {
  it.effect(
    "shows a refused Codex turn's window spent on the feed's Codex row",
    () =>
      Effect.gen(function* () {
        const feed = yield* UsageFeed;
        const { pubsub } = yield* Events;

        const frames = yield* Queue.unbounded<UsageSnapshot>();

        yield* Effect.forkChild(
          feed.snapshots.pipe(
            Stream.runForEach((frame) => Queue.offer(frames, frame))
          )
        );

        const firstRead = yield* takeUntil(frames, (frame) =>
          frame.providers.some((row) => Option.isSome(row.checkedAt))
        );

        assert.deepStrictEqual(spentOnFeed(firstRead), []);

        yield* PubSub.publish(
          pubsub,
          terminal(
            Option.some("codex"),
            "usage_limit",
            Option.some(1_793_178_060_000)
          )
        );

        const marked = yield* takeUntil(
          frames,
          (frame) => spentOnFeed(frame).length > 0
        );

        assert.deepStrictEqual(spentOnFeed(marked), ["five_hour"]);
      }).pipe(
        Effect.provide(
          Layer.merge(UsageFeed.layerNoDeps, CodexSignals).pipe(
            Layer.provide(Usage),
            Layer.provideMerge(FakeHarness),
            Layer.provide(BridgeProvider.layerOff)
          )
        ),
        (test) => Effect.andThen(TestClock.setTime(1_793_177_000_000), test)
      )
  );

  it.effect(
    "says there are no providers with neither the bridge nor a Codex login",
    () =>
      Effect.gen(function* () {
        const feed = yield* UsageFeed;

        const first = yield* feed.snapshots.pipe(Stream.runHead);

        assert.deepStrictEqual(Option.getOrNull(first), { providers: [] });
      }).pipe(
        // The deployed layer: with no `OAuthStore` in reach, the Codex login is not held.
        Effect.provide(
          UsageFeed.layer.pipe(
            Layer.provide(FakeHarness),
            Layer.provide(BridgeProvider.layerOff)
          )
        )
      )
  );
});
