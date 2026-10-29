// The usage feed beyond the bridge: a Codex login adds Codex's row, an unreadable Codex answer is a
// row with no windows, with no login the frame is unchanged from the bridge-only feed, and with both
// sources the rows come Claude first and a change in either keeps the other's row. The bridge's own
// rows are judged in `models/BridgeProvider.test.ts`.

import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import type { ProviderUsage, UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { BridgeProvider } from "../models/BridgeProvider.ts";
import { CodexAccess, parseCodexCredential } from "../models/CodexAccess.ts";
import { CODEX_PROVIDER, CodexUsage } from "./CodexUsage.ts";
import { UsageFeed } from "./UsageFeed.ts";

const SESSION_AND_WEEK = JSON.stringify({
  rate_limit: {
    limit_reached: false,
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 18_000,
      reset_at: 1_793_178_000,
    },
    secondary_window: {
      used_percent: 50,
      limit_window_seconds: 604_800,
      reset_at: 1_793_512_800,
    },
  },
});

const answering = (body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
      )
    )
  );

const signedIn = Layer.unwrap(
  Effect.map(
    parseCodexCredential({
      access: "test-access-token",
      accountId: "acct_test",
    }),
    (credential) =>
      Layer.succeed(
        CodexAccess,
        CodexAccess.of({ credential: Effect.succeedSome(credential) })
      )
  ).pipe(Effect.orDie)
);

const feedOver = (body: string) =>
  UsageFeed.layerNoDeps.pipe(
    Layer.provide(CodexUsage.layerNoDeps),
    Layer.provide(answering(body)),
    Layer.provide(signedIn)
  );

/** Claude's row with one session window `used` full. */
const claudeRows = (used: number): ReadonlyArray<ProviderUsage> => [
  {
    provider: "claude-bridge",
    reading: "read",
    windows: [
      {
        id: "five_hour",
        label: "Session",
        used: Option.some(used),
        resetsAt: Option.none(),
        exhausted: false,
      },
    ],
    checkedAt: Option.none(),
  },
];

const notUsed = Effect.die("not used by this test");

/** A bridge whose usage watch is `rows`; nothing else of it is used. */
const bridgeOver = (
  rows: SubscriptionRef.SubscriptionRef<ReadonlyArray<ProviderUsage>>
) =>
  Layer.succeed(BridgeProvider, {
    claude: Option.none(),
    usage: Option.some(
      ClaudeUsage.of({
        current: notUsed,
        changes: Stream.die("not used by this test"),
        watch: SubscriptionRef.changes(rows),
        observe: () => notUsed,
        probe: notUsed,
      })
    ),
  });

/** Each row as `[provider, [[window id, used]]]`. */
const summary = (frame: UsageSnapshot) =>
  frame.providers.map((row) => [
    row.provider,
    row.windows.map((window) => [window.id, window.used]),
  ]);

/** The first frame in which some provider has a check time. */
const firstChecked = Effect.gen(function* () {
  const feed = yield* UsageFeed;

  return yield* feed.snapshots.pipe(
    Stream.filter((snapshot: UsageSnapshot) =>
      snapshot.providers.some((provider) => Option.isSome(provider.checkedAt))
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  );
});

/** The next frame off `frames` that `done` accepts. */
const nextFrame = (
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

/** Whether a frame carries a Codex row that has been read. */
const codexRead = (frame: UsageSnapshot) =>
  frame.providers.some(
    (row) => row.provider === CODEX_PROVIDER && Option.isSome(row.checkedAt)
  );

describe("the usage feed beyond the bridge", () => {
  it.effect("adds Codex's windows once the Codex login is held", () =>
    Effect.gen(function* () {
      const frame = yield* firstChecked;

      assert.deepStrictEqual(
        frame.providers.map((provider) => [
          provider.provider,
          provider.windows.map((window) => [window.id, window.used]),
        ]),
        [
          [
            CODEX_PROVIDER,
            [
              ["five_hour", Option.some(0.1)],
              ["seven_day", Option.some(0.5)],
            ],
          ],
        ]
      );
    }).pipe(Effect.provide(feedOver(SESSION_AND_WEEK)))
  );

  it.effect("shows an unreadable Codex answer as a row with no windows", () =>
    Effect.gen(function* () {
      const frame = yield* firstChecked;

      assert.deepStrictEqual(
        frame.providers.map((provider) => [
          provider.provider,
          provider.windows.length,
        ]),
        [[CODEX_PROVIDER, 0]]
      );
    }).pipe(Effect.provide(feedOver(`{"rate_limit":{"windows":[]}}`)))
  );

  it.effect(
    "sends Claude's row then Codex's, and keeps one source's row when the other changes",
    () =>
      Effect.gen(function* () {
        const claude = yield* SubscriptionRef.make(claudeRows(0.2));
        const frames = yield* Queue.unbounded<UsageSnapshot>();

        yield* Effect.gen(function* () {
          const feed = yield* UsageFeed;

          const watcher = yield* Effect.forkChild(
            feed.snapshots.pipe(
              Stream.runForEach((frame) => Queue.offer(frames, frame))
            )
          );

          const both = yield* nextFrame(frames, codexRead);

          assert.deepStrictEqual(summary(both), [
            ["claude-bridge", [["five_hour", Option.some(0.2)]]],
            [
              CODEX_PROVIDER,
              [
                ["five_hour", Option.some(0.1)],
                ["seven_day", Option.some(0.5)],
              ],
            ],
          ]);

          // Claude changes; Codex's row stays as it was.
          yield* SubscriptionRef.set(claude, claudeRows(0.7));

          const changed = yield* nextFrame(frames, (frame) =>
            frame.providers.some((row) =>
              row.windows.some((window) => Option.contains(window.used, 0.7))
            )
          );

          assert.deepStrictEqual(summary(changed), [
            ["claude-bridge", [["five_hour", Option.some(0.7)]]],
            [
              CODEX_PROVIDER,
              [
                ["five_hour", Option.some(0.1)],
                ["seven_day", Option.some(0.5)],
              ],
            ],
          ]);
          assert.deepStrictEqual(changed.providers[1], both.providers[1]);

          yield* Fiber.interrupt(watcher);
        }).pipe(
          Effect.provide(
            UsageFeed.layerNoDeps.pipe(
              Layer.provide(CodexUsage.layerNoDeps),
              Layer.provide(answering(SESSION_AND_WEEK)),
              Layer.provide(signedIn),
              Layer.provide(bridgeOver(claude))
            )
          )
        );
      })
  );
});
