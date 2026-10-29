// Codex plan windows, judged on bodies in `fixtures/wham-usage/` and through the service over a fake
// `HttpClient`. The endpoint has not been called yet (no Codex login exists), so the bodies are built
// from the shape MonoCode's parser and its test read (`rate_limit.primary_window` and
// `secondary_window` with `used_percent`, `limit_window_seconds`, `reset_at` in epoch seconds),
// with the neighbouring fields the Codex backend sends (`plan_type`, `allowed`, `limit_reached`,
// `reset_after_seconds`, `credits`). Files named `changed-*` are shapes the endpoint might drift to;
// each must read as unreadable, never as a number. The first live read after the login adds its
// body here.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { CodexAccess, parseCodexCredential } from "./CodexAccess.ts";
import {
  CODEX_PROVIDER,
  CODEX_USAGE_URL,
  CodexUsage,
  MAX_BODY_LENGTH,
  readingOf,
  readUsageBody,
} from "./CodexUsage.ts";
import type { CodexWindow } from "./CodexUsage.ts";

const BODIES = path.join(import.meta.dirname, "fixtures", "wham-usage");

const body = (file: string) => readFileSync(path.join(BODIES, file), "utf-8");

/** The windows as `[id, usedPercent, resetsAt ms or null, exhausted]`, for one readable comparison. */
const summary = (windows: ReadonlyArray<CodexWindow>) =>
  windows.map((window) => [
    window.id,
    window.label,
    window.usedPercent,
    Option.getOrNull(window.resetsAt),
    window.exhausted,
  ]);

describe("reading recorded usage bodies", () => {
  const readable: ReadonlyArray<
    readonly [string, ReadonlyArray<ReadonlyArray<unknown>>]
  > = [
    [
      "plus-two-windows.json",
      [
        ["five_hour", "Session", 23, 1_793_178_000_000, false],
        ["seven_day", "Weekly", 41, 1_793_512_800_000, false],
      ],
    ],
    // A weekly primary is weekly, never a session (MonoCode's regression).
    [
      "weekly-primary-only.json",
      [["seven_day", "Weekly", 32, 1_790_700_198_000, false]],
    ],
    [
      "limit-reached.json",
      [
        ["five_hour", "Session", 100, 1_793_170_800_000, true],
        ["seven_day", "Weekly", 64, 1_793_512_800_000, false],
      ],
    ],
    // `limit_reached` with no window at 100: the fullest is the spent one.
    [
      "limit-reached-below-full.json",
      [
        ["five_hour", "Session", 87.5, 1_793_170_800_000, false],
        ["seven_day", "Weekly", 99.6, 1_793_253_600_000, true],
      ],
    ],
    // Zero is a reading, not a missing one; a null reset is unknown.
    ["fresh-window-no-reset.json", [["five_hour", "Session", 0, null, false]]],
  ];

  it.each(readable.map(([file, expected]) => ({ file, expected })))(
    "reads $file",
    ({ file, expected }) => {
      const windows = readUsageBody(body(file));

      assert.isTrue(Option.isSome(windows), `${file} should decode`);
      assert.deepStrictEqual(
        summary(Option.getOrElse(windows, () => [])),
        expected
      );
    }
  );

  const changed = readdirSync(BODIES).filter((file) =>
    file.startsWith("changed-")
  );

  it("has changed shapes to judge", () => {
    assert.isAtLeast(changed.length, 10);
  });

  it.each(changed)("reads %s as unreadable", (file) => {
    assert.isTrue(Option.isNone(readUsageBody(body(file))));
  });

  it("reads a body past the size bound as unreadable, even when it would decode", () => {
    const padded = body("plus-two-windows.json").replace(
      '"plan_type": "plus"',
      `"plan_type": "${"x".repeat(MAX_BODY_LENGTH)}"`
    );

    assert.isTrue(Option.isNone(readUsageBody(padded)));
  });

  it("names a window of another length by its length", () => {
    const windows = readUsageBody(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 5,
            limit_window_seconds: 3 * 3600,
            reset_at: null,
          },
          secondary_window: {
            used_percent: 130,
            limit_window_seconds: 30 * 86_400,
            reset_at: null,
          },
        },
      })
    );

    assert.deepStrictEqual(summary(Option.getOrElse(windows, () => [])), [
      ["3_hour", "3-hour", 5, null, false],
      ["30_day", "30-day", 100, null, true],
    ]);
  });
});

// --- The service over a fake endpoint ---

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** One request the reader sent, with the two headers it must carry. */
interface Sent {
  readonly url: string;
  readonly authorization: string;
  readonly account: string;
}

interface Endpoint {
  readonly requests: Ref.Ref<ReadonlyArray<Sent>>;
  /** What the next request gets; `none` never answers. */
  readonly next: Ref.Ref<Option.Option<Answer>>;
}

const makeEndpoint = Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<Sent>>([]);

  const next = yield* Ref.make(
    Option.some<Answer>({ status: 200, body: body("plus-two-windows.json") })
  );

  return { requests, next } satisfies Endpoint;
});

const clientOver = (endpoint: Endpoint) =>
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      yield* Ref.update(endpoint.requests, (all) => [
        ...all,
        {
          url: request.url,
          authorization: request.headers.authorization ?? "",
          account: request.headers["chatgpt-account-id"] ?? "",
        },
      ]);

      const answer = yield* Ref.get(endpoint.next);

      if (Option.isNone(answer)) {
        return yield* Effect.never;
      }

      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.value.body, { status: answer.value.status })
      );
    })
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

const usageOver = (endpoint: Endpoint, access: Layer.Layer<never>) =>
  CodexUsage.layerNoDeps.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, clientOver(endpoint))),
    Layer.provide(access)
  );

/** Watches until a reading satisfies `done`, then stops watching. */
const watchUntil = (done: (state: string) => boolean) =>
  Effect.gen(function* () {
    const usage = yield* CodexUsage;

    return yield* usage.changes.pipe(
      Stream.filter((reading) => done(reading.state)),
      Stream.take(1),
      Stream.runHead,
      Effect.map(Option.getOrThrow)
    );
  });

describe("the Codex usage reader", () => {
  it.effect("reads nothing and shows no row while signed out", () =>
    Effect.gen(function* () {
      const endpoint = yield* makeEndpoint;

      yield* Effect.gen(function* () {
        const usage = yield* CodexUsage;

        yield* usage.read;

        const rows = yield* usage.watch.pipe(Stream.runHead);

        assert.deepStrictEqual(Option.getOrNull(rows), []);
        assert.deepStrictEqual(yield* Ref.get(endpoint.requests), []);
      }).pipe(
        Effect.provide(
          usageOver(
            endpoint,
            Layer.succeed(CodexAccess, {
              credential: Effect.succeedNone,
            })
          )
        )
      );
    })
  );

  it.effect(
    "reads when a watcher arrives, with the login's token and account, and shows the row",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          const reading = yield* watchUntil((state) => state === "read");
          const rows = yield* usage.watch.pipe(Stream.runHead);

          assert.deepStrictEqual(yield* Ref.get(endpoint.requests), [
            {
              url: CODEX_USAGE_URL,
              authorization: "Bearer test-access-token",
              account: "acct_test",
            },
          ]);
          assert.strictEqual(readingOf(reading), "read");

          const [row] = Option.getOrThrow(rows);

          assert.strictEqual(row?.provider, CODEX_PROVIDER);
          assert.deepStrictEqual(
            row?.windows.map((window) => [window.id, window.used]),
            [
              ["five_hour", Option.some(0.23)],
              ["seven_day", Option.some(0.41)],
            ]
          );
          assert.isTrue(Option.isSome(row?.checkedAt ?? Option.none()));
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect(
    "shows an unreadable answer as a row with no windows, never a number",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* Ref.set(
          endpoint.next,
          Option.some({ status: 200, body: body("changed-window-list.json") })
        );

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          const reading = yield* watchUntil((state) => state === "unreadable");

          const rows = Option.getOrThrow(
            yield* usage.watch.pipe(Stream.runHead)
          );

          assert.strictEqual(readingOf(reading), "unreadable");
          assert.strictEqual(rows.length, 1);
          assert.deepStrictEqual(rows[0]?.windows, []);
          assert.isTrue(Option.isSome(rows[0]?.checkedAt ?? Option.none()));
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect(
    "keeps the last windows and their time when a later read is refused",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          yield* usage.read;

          const first = yield* usage.current;

          yield* Ref.set(
            endpoint.next,
            Option.some({ status: 401, body: "{}" })
          );
          yield* TestClock.adjust(Duration.seconds(30));
          yield* usage.read;

          const after = yield* usage.current;

          assert.strictEqual(after.state, "failed");
          assert.include(
            Option.getOrElse(after.reason, () => ""),
            "HTTP 401"
          );
          assert.deepStrictEqual(after.windows, first.windows);
          assert.deepStrictEqual(after.checkedAt, first.checkedAt);
          assert.strictEqual(readingOf(after), "read");
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect("gives up on a read after the timeout and says so", () =>
    Effect.gen(function* () {
      const endpoint = yield* makeEndpoint;

      yield* Ref.set(endpoint.next, Option.none());

      yield* Effect.gen(function* () {
        const usage = yield* CodexUsage;
        const waiting = yield* Effect.forkChild(usage.read);

        yield* TestClock.adjust(Duration.seconds(11));
        yield* Fiber.join(waiting);

        const after = yield* usage.current;

        assert.strictEqual(after.state, "failed");
        assert.include(
          Option.getOrElse(after.reason, () => ""),
          "timed out"
        );
        assert.strictEqual(readingOf(after), "unreadable");
      }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
    })
  );

  it.effect(
    "marks the window a refused turn names, and keeps it spent until its reset passes",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        // Start near the windows' times, so moving past a reset is minutes of ticks, not decades.
        yield* TestClock.setTime(1_793_177_000_000);

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          yield* usage.read;

          // The session window resets at 1_793_178_000 s; the refusal names a time near it.
          yield* usage.observeLimit(Option.some(1_793_178_060_000));
          yield* usage.read;

          const spent = yield* usage.current;

          assert.deepStrictEqual(
            spent.windows.map((window) => [window.id, window.exhausted]),
            [
              ["five_hour", true],
              ["seven_day", false],
            ]
          );

          // Past the reset, the endpoint's word wins again.
          yield* TestClock.setTime(1_793_178_061_000);
          yield* usage.read;

          const cleared = yield* usage.current;

          assert.deepStrictEqual(
            cleared.windows.map((window) => window.exhausted),
            [false, false]
          );
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect(
    "reads once per stale watcher and every five minutes while watched",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          const count = Effect.map(
            Ref.get(endpoint.requests),
            (all) => all.length
          );

          yield* watchUntil((state) => state === "read");
          assert.strictEqual(yield* count, 1);

          // A second watcher inside the stale window joins what is known.
          yield* TestClock.adjust(Duration.seconds(30));
          yield* watchUntil((state) => state === "read");
          assert.strictEqual(yield* count, 1);

          // Nobody watches: the tick does not read.
          yield* TestClock.adjust(Duration.minutes(5));
          assert.strictEqual(yield* count, 1);

          // Someone watches across a tick: one read at arrival (stale), one at the tick.
          const started = yield* Deferred.make<boolean>();

          const watcher = yield* Effect.forkChild(
            usage.changes.pipe(
              Stream.tap(() => Deferred.succeed(started, true)),
              Stream.runDrain
            )
          );

          yield* Deferred.await(started);
          yield* TestClock.adjust(Duration.minutes(5));
          yield* Fiber.interrupt(watcher);

          assert.strictEqual(yield* count, 3);
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect(
    "never shows the access token in the credential's printed form",
    () =>
      Effect.gen(function* () {
        const credential = yield* parseCodexCredential({
          access: "secret-token-value",
          accountId: "acct_1",
        });

        assert.notInclude(JSON.stringify(credential), "secret-token-value");
        assert.strictEqual(
          Redacted.value(credential.access),
          "secret-token-value"
        );
      })
  );

  it.effect("refuses a credential that could not go into a header", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        parseCodexCredential({ access: "bad\r\nheader", accountId: "acct_1" })
      );

      assert.strictEqual(failed._tag, "SchemaError");
    })
  );
});
