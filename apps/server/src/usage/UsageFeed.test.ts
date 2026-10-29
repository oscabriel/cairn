// The usage feed beyond the bridge: a Codex login adds Codex's row, an unreadable Codex answer is a
// row with no windows, and with no login the frame is unchanged from the bridge-only feed. The
// bridge's own rows are judged in `models/BridgeProvider.test.ts`.

import type { UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { CodexAccess, parseCodexCredential } from "./CodexAccess.ts";
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

const signedIn = Layer.effect(
  CodexAccess,
  Effect.map(
    parseCodexCredential({
      access: "test-access-token",
      accountId: "acct_test",
    }),
    (credential) => ({ credential: Effect.succeedSome(credential) })
  ).pipe(Effect.orDie)
);

const feedOver = (body: string) =>
  UsageFeed.layerNoDeps.pipe(
    Layer.provide(CodexUsage.layerNoDeps),
    Layer.provide(answering(body)),
    Layer.provide(signedIn)
  );

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
    "says there are no providers with neither the bridge nor a Codex login",
    () =>
      Effect.gen(function* () {
        const feed = yield* UsageFeed;

        const first = yield* feed.snapshots.pipe(Stream.runHead);

        assert.deepStrictEqual(Option.getOrNull(first), { providers: [] });
      }).pipe(Effect.provide(UsageFeed.layer))
  );
});
