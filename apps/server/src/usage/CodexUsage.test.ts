// Codex plan windows, judged on bodies in `fixtures/wham-usage/` and through the service over a fake
// `HttpClient`. The endpoint has not been called yet (no Codex login exists), so the bodies are built
// from the shape MonoCode's parser and its test read (`rate_limit.primary_window` and
// `secondary_window` with `used_percent`, `limit_window_seconds`, `reset_at` in epoch seconds),
// with the neighbouring fields the Codex backend sends (`plan_type`, `allowed`, `limit_reached`,
// `reset_after_seconds`, `credits`). Files named `no-windows-*` are a plan that answered with no
// windows, read as unsupported. Files named `changed-*` are shapes the endpoint might drift to; each
// must read as unreadable, never as a number. The live read, the package's second judge, waits on
// the user's Codex login (`ops/wizards/phase-2.sh 1`). Only the brain holding the OAuth lock
// (`cairn.service`) can read that login, so a standalone judge would always be signed out: the read
// goes through the deployed brain's `usage.subscribe`, which must show an `openai-codex` row whose
// `reading` is `read`, and the body it got is saved here with the tokens and account id removed.

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

import {
  CodexAccess,
  CodexAccessError,
  parseCodexCredential,
} from "../models/CodexAccess.ts";
import { CODEX_PROVIDER } from "../models/CredentialStore.ts";
import {
  CODEX_USAGE_URL,
  CodexUsage,
  MAX_BODY_BYTES,
  readingOf,
  readUsageBody,
  toProviderUsage,
  USER_AGENT,
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
    // A plan with no windows answers so; it is not a changed shape.
    ["no-windows-free-plan.json", []],
    ["no-windows-both-null.json", []],
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
    assert.isAtLeast(changed.length, 8);
  });

  it.each(changed)("reads %s as unreadable", (file) => {
    assert.isTrue(Option.isNone(readUsageBody(body(file))));
  });

  it("reads a body past the size bound as unreadable, even when it would decode", () => {
    const padded = body("plus-two-windows.json").replace(
      '"plan_type": "plus"',
      `"plan_type": "${"x".repeat(MAX_BODY_BYTES)}"`
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

/** Marks an answer whose body runs far past the bound. */
const LONG = Symbol("long");

interface Answer {
  readonly status: number;
  /** A text body, or `LONG` for a body of `LONG_BODY_BYTES` spaces. */
  readonly body: string | typeof LONG;
}

const CHUNK_BYTES = 64 * 1024;

/**
 * How long the `LONG` body is: a fixed ceiling, not a multiple of `MAX_BODY_BYTES`, so a reader
 * whose bound is broken (even set to `Infinity`) reads it whole, finishes, and fails the test
 * instead of running out of memory.
 */
const LONG_BODY_BYTES = 16 * 1024 * 1024;

/** A body that sends 64 KiB chunks of spaces up to `LONG_BODY_BYTES`, counting what it sent. */
const longBody = (pulled: Ref.Ref<number>) =>
  new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const sent = Effect.runSync(
        Ref.updateAndGet(pulled, (bytes) => bytes + CHUNK_BYTES)
      );

      controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x20));

      if (sent >= LONG_BODY_BYTES) {
        controller.close();
      }
    },
  });

/** One request the reader sent, with the headers it must carry. */
interface Sent {
  readonly url: string;
  readonly authorization: string;
  readonly account: string;
  readonly userAgent: string;
}

interface Endpoint {
  readonly requests: Ref.Ref<ReadonlyArray<Sent>>;
  /** What the next request gets; `none` never answers. */
  readonly next: Ref.Ref<Option.Option<Answer>>;
  /** Bytes of `LONG` bodies handed to the reader. */
  readonly pulled: Ref.Ref<number>;
}

const makeEndpoint = Effect.gen(function* () {
  const requests = yield* Ref.make<ReadonlyArray<Sent>>([]);

  const next = yield* Ref.make(
    Option.some<Answer>({ status: 200, body: body("plus-two-windows.json") })
  );

  const pulled = yield* Ref.make(0);

  return { requests, next, pulled } satisfies Endpoint;
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
          userAgent: request.headers["user-agent"] ?? "",
        },
      ]);

      const answer = yield* Ref.get(endpoint.next);

      if (Option.isNone(answer)) {
        return yield* Effect.never;
      }

      const { body: text, status } = answer.value;

      return HttpClientResponse.fromWeb(
        request,
        new Response(text === LONG ? longBody(endpoint.pulled) : text, {
          status,
        })
      );
    })
  );

const testCredential = parseCodexCredential({
  access: "test-access-token",
  accountId: "acct_test",
}).pipe(Effect.orDie);

const accessOf = (credential: CodexAccess["Service"]["credential"]) =>
  Layer.succeed(CodexAccess, CodexAccess.of({ credential }));

const signedIn = Layer.unwrap(
  Effect.map(testCredential, (credential) =>
    accessOf(Effect.succeedSome(credential))
  )
);

/** A login the test signs in and out of while the reader runs. */
const togglingAccess = (held: Ref.Ref<boolean>) =>
  Layer.unwrap(
    Effect.map(testCredential, (credential) =>
      accessOf(
        Effect.map(Ref.get(held), (on) =>
          on ? Option.some(credential) : Option.none()
        )
      )
    )
  );

const usageOver = (endpoint: Endpoint, access: Layer.Layer<CodexAccess>) =>
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
      }).pipe(Effect.provide(usageOver(endpoint, CodexAccess.layerSignedOut)));
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
              userAgent: USER_AGENT,
            },
          ]);
          assert.strictEqual(readingOf(reading), "read");

          const [row] = Option.getOrThrow(rows);

          assert.strictEqual(row?.provider, CODEX_PROVIDER);
          assert.strictEqual(row?.reading, "read");
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
          assert.strictEqual(rows[0]?.reading, "unreadable");
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

  it.effect("shows a plan with no windows as unsupported, not unreadable", () =>
    Effect.gen(function* () {
      const endpoint = yield* makeEndpoint;

      yield* Ref.set(
        endpoint.next,
        Option.some({ status: 200, body: body("no-windows-free-plan.json") })
      );

      yield* Effect.gen(function* () {
        const usage = yield* CodexUsage;

        yield* watchUntil((state) => state === "unsupported");

        const rows = Option.getOrThrow(yield* usage.watch.pipe(Stream.runHead));

        assert.deepStrictEqual(
          rows.map((row) => [row.provider, row.reading, row.windows]),
          [[CODEX_PROVIDER, "unsupported", []]]
        );
      }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
    })
  );

  it.effect(
    "stops reading an answer one chunk past the bound and calls it unreadable",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        // Sixteen times the bound: a reader that held it whole would read every byte of it.
        yield* Ref.set(
          endpoint.next,
          Option.some<Answer>({ status: 200, body: LONG })
        );

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          yield* usage.read;

          const after = yield* usage.current;

          assert.strictEqual(after.state, "unreadable");
          assert.include(
            Option.getOrElse(after.reason, () => ""),
            `longer than ${MAX_BODY_BYTES} bytes`
          );
          // The chunk past the bound, and at most one the body queued ahead of it.
          assert.isAtMost(
            yield* Ref.get(endpoint.pulled),
            MAX_BODY_BYTES + 2 * CHUNK_BYTES
          );
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect("reads a redirect as a failed read, never following it", () =>
    Effect.gen(function* () {
      const endpoint = yield* makeEndpoint;

      yield* Ref.set(
        endpoint.next,
        Option.some<Answer>({ status: 302, body: "" })
      );

      yield* Effect.gen(function* () {
        const usage = yield* CodexUsage;

        yield* usage.read;

        const after = yield* usage.current;

        assert.strictEqual(after.state, "failed");
        assert.include(
          Option.getOrElse(after.reason, () => ""),
          "HTTP 302"
        );
        assert.strictEqual((yield* Ref.get(endpoint.requests)).length, 1);
      }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
    })
  );

  it.effect("joins a read already running instead of sending another", () =>
    Effect.gen(function* () {
      const endpoint = yield* makeEndpoint;

      // The endpoint never answers, so the first read is still running when the second starts.
      yield* Ref.set(endpoint.next, Option.none());

      yield* Effect.gen(function* () {
        const usage = yield* CodexUsage;

        const first = yield* Effect.forkChild(usage.read);

        yield* TestClock.adjust(Duration.seconds(1));

        const second = yield* Effect.forkChild(usage.read);

        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual((yield* Ref.get(endpoint.requests)).length, 1);

        yield* TestClock.adjust(Duration.seconds(10));
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        assert.strictEqual((yield* Ref.get(endpoint.requests)).length, 1);
        assert.strictEqual((yield* usage.current).state, "failed");
      }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
    })
  );

  it.effect(
    "lets a caller stop waiting without leaving later reads stuck behind it",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* Ref.set(endpoint.next, Option.none());

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          const gaveUp = yield* Effect.forkChild(
            usage.read.pipe(Effect.timeoutOption(Duration.seconds(1)))
          );

          yield* TestClock.adjust(Duration.seconds(1));
          assert.isTrue(Option.isNone(yield* Fiber.join(gaveUp)));

          // The read it started still finishes, and the next one goes to the endpoint.
          yield* TestClock.adjust(Duration.seconds(10));
          yield* Ref.set(
            endpoint.next,
            Option.some<Answer>({
              status: 200,
              body: body("plus-two-windows.json"),
            })
          );
          yield* usage.read;

          assert.strictEqual((yield* usage.current).state, "read");
          assert.strictEqual((yield* Ref.get(endpoint.requests)).length, 2);
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect(
    "drops a refused turn's mark once the endpoint shows a spent window itself",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* TestClock.setTime(1_793_170_000_000);

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          const spentIds = Effect.map(usage.current, (reading) =>
            reading.windows
              .filter((window) => window.exhausted)
              .map((window) => window.id)
          );

          yield* usage.read;
          // Naming no reset, the mark would hold for an hour on the fullest window.
          yield* usage.observeLimit(Option.none());
          yield* usage.read;
          assert.deepStrictEqual(yield* spentIds, ["seven_day"]);

          // The endpoint agrees a window is spent: its word replaces the mark.
          yield* Ref.set(
            endpoint.next,
            Option.some<Answer>({
              status: 200,
              body: body("limit-reached.json"),
            })
          );
          yield* usage.read;
          assert.isTrue(Option.isNone((yield* usage.current).limit));
          assert.deepStrictEqual(yield* spentIds, ["five_hour"]);

          // Inside the hour, a later answer with nothing spent shows nothing spent.
          yield* Ref.set(
            endpoint.next,
            Option.some<Answer>({
              status: 200,
              body: body("plus-two-windows.json"),
            })
          );
          yield* usage.read;
          assert.deepStrictEqual(yield* spentIds, []);
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect("sends no frame for a signed-out tick that changes nothing", () =>
    Effect.gen(function* () {
      const endpoint = yield* makeEndpoint;

      yield* Effect.gen(function* () {
        const usage = yield* CodexUsage;
        const frames = yield* Ref.make(0);

        const watcher = yield* Effect.forkChild(
          usage.watch.pipe(
            Stream.runForEach(() => Ref.update(frames, (n) => n + 1))
          )
        );

        yield* TestClock.adjust(Duration.minutes(16));
        yield* Fiber.interrupt(watcher);

        assert.strictEqual(yield* Ref.get(frames), 1);
      }).pipe(Effect.provide(usageOver(endpoint, CodexAccess.layerSignedOut)));
    })
  );

  it.effect(
    "does not retry a login that failed for each watcher inside the stale window",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;
        const asked = yield* Ref.make(0);

        const refused = accessOf(
          Effect.andThen(
            Ref.update(asked, (n) => n + 1),
            Effect.fail(
              new CodexAccessError({
                message:
                  "the Codex access token is stale and its refresh failed",
                reason: "refresh_failed",
              })
            )
          )
        );

        yield* Effect.gen(function* () {
          yield* watchUntil((state) => state === "failed");
          yield* TestClock.adjust(Duration.seconds(30));
          yield* watchUntil((state) => state === "failed");
          // Time for a read the second watcher might have started to ask for the login.
          yield* TestClock.adjust(Duration.seconds(1));

          assert.strictEqual(yield* Ref.get(asked), 1);
        }).pipe(Effect.provide(usageOver(endpoint, refused)));
      })
  );

  it("shows a window whose reset no date can hold as unreadable, never failing the feed", () => {
    const rows = toProviderUsage({
      state: "read",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          windowMinutes: 300,
          usedPercent: 23,
          resetsAt: Option.some(1_793_178_000_000_000_000),
          exhausted: false,
        },
      ],
      checkedAt: Option.some(1_793_170_000_000),
      reason: Option.none(),
      limit: Option.none(),
    });

    assert.deepStrictEqual(
      rows.map((row) => [row.provider, row.reading, row.windows]),
      [[CODEX_PROVIDER, "unreadable", []]]
    );
  });

  it.effect(
    "shows a login that could not be refreshed as a failed read, not as signed out",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        const refused = accessOf(
          Effect.fail(
            new CodexAccessError({
              message: "the Codex access token is stale and its refresh failed",
              reason: "refresh_failed",
            })
          )
        );

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          yield* usage.read;

          const after = yield* usage.current;

          const rows = Option.getOrThrow(
            yield* usage.watch.pipe(Stream.runHead)
          );

          assert.strictEqual(after.state, "failed");
          assert.include(
            Option.getOrElse(after.reason, () => ""),
            "refresh failed"
          );
          assert.deepStrictEqual(
            rows.map((row) => row.reading),
            ["unreadable"]
          );
          assert.deepStrictEqual(yield* Ref.get(endpoint.requests), []);
        }).pipe(Effect.provide(usageOver(endpoint, refused)));
      })
  );

  it.effect(
    "holds a refused turn's limit that names no reset for an hour, not just until the next read",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;

        yield* TestClock.setTime(1_793_170_000_000);

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          const spentIds = Effect.map(usage.current, (reading) =>
            reading.windows
              .filter((window) => window.exhausted)
              .map((window) => window.id)
          );

          yield* usage.read;
          yield* usage.observeLimit(Option.none());
          // The read the refusal starts, and one more: the endpoint does not show it spent yet.
          yield* usage.read;
          assert.deepStrictEqual(yield* spentIds, ["seven_day"]);

          yield* TestClock.adjust(Duration.minutes(30));
          yield* usage.read;
          assert.deepStrictEqual(yield* spentIds, ["seven_day"]);

          yield* TestClock.adjust(Duration.minutes(31));
          yield* usage.read;
          assert.deepStrictEqual(yield* spentIds, []);
        }).pipe(Effect.provide(usageOver(endpoint, signedIn)));
      })
  );

  it.effect(
    "does not count a read made while signed out as fresh, so a sign-in reads at the next watcher",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* makeEndpoint;
        const held = yield* Ref.make(false);

        yield* Effect.gen(function* () {
          const usage = yield* CodexUsage;

          yield* usage.read;
          assert.strictEqual((yield* usage.current).state, "signed_out");

          yield* Ref.set(held, true);
          yield* TestClock.adjust(Duration.seconds(10));

          const reading = yield* watchUntil((state) => state === "read");

          assert.strictEqual(reading.state, "read");
          assert.strictEqual((yield* Ref.get(endpoint.requests)).length, 1);
        }).pipe(Effect.provide(usageOver(endpoint, togglingAccess(held))));
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
