// Codex's plan windows, read from ChatGPT's usage endpoint (`wham/usage`) with the Codex login
// Cairn holds (ADR 0037). The endpoint is undocumented, so the body goes through a Schema decode and
// any shape the decode does not know reads as "unreadable": a meter that says it cannot read the
// plan beats one that shows a wrong number. Reads run only while a client watches, on the bridge's
// cadence (a watcher arriving after `STALE_PROBE` starts one, then one every `PROBE_EVERY`), one at a
// time, and once after a turn reports a spent Codex limit.
//
// Ported from hardbeat920/monocode src-tauri/src/pi_usage.rs at
// 26465c620977f3951d0a532a0f7db32c3c179007: the endpoint, the `Authorization` and
// `ChatGPT-Account-Id` headers, the field names (`rate_limit.primary_window`, `secondary_window`,
// `used_percent`, `limit_window_seconds`, `reset_at`), the bounded body, and the rules that a
// window's length must be whole minutes and two windows may not claim the same length. Changed: an
// Effect Schema decode instead of serde lookups, windows named by their length (a weekly primary is
// never called a session), a spent window or a refused turn marks it exhausted, and the token comes
// from Cairn's own login instead of pi's `auth.json`, which this code never reads.
//
// MIT License
//
// Copyright (c) 2026 Nick
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { PROBE_EVERY, STALE_PROBE } from "@cairn/bridge/ClaudeUsage";
import type { PlanWindow, ProviderUsage } from "@cairn/protocol/Usage";
import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { CodexAccess } from "./CodexAccess.ts";
import type { CodexCredential } from "./CodexAccess.ts";

/** The provider id Codex models run under, and the one its usage row carries. */
export const CODEX_PROVIDER = "openai-codex";

/** ChatGPT's usage endpoint for the signed-in account. Undocumented; read behind a decode. */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** How long one read may take, request to last byte. */
export const READ_TIMEOUT = Duration.seconds(10);

/** A body longer than this (in UTF-16 units) is not a usage answer and reads as unreadable. */
export const MAX_BODY_LENGTH = 1024 * 1024;

const SESSION_MINS = 5 * 60;

const WEEK_MINS = 7 * 24 * 60;

// --- The body ---

/** One window as the endpoint sends it. Times are epoch seconds. */
const WhamWindow = Schema.Struct({
  used_percent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  limit_window_seconds: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isMultipleOf(60)
  ),
  reset_at: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))
  ),
});

/** The parts of the endpoint's answer Cairn reads; every other field is ignored. */
const WhamUsage = Schema.Struct({
  rate_limit: Schema.Struct({
    limit_reached: Schema.optionalKey(Schema.Boolean),
    primary_window: Schema.optionalKey(Schema.NullOr(WhamWindow)),
    secondary_window: Schema.optionalKey(Schema.NullOr(WhamWindow)),
  }),
});

const decodeWhamUsage = Schema.decodeOption(Schema.fromJsonString(WhamUsage));

/** One Codex plan window. Percent is 0 to 100; times are epoch milliseconds. */
export interface CodexWindow {
  /** Named by length: `five_hour`, `seven_day`, else `<n>_hour`, `<n>_day` or `<n>_minute`. */
  readonly id: string;
  readonly label: string;
  readonly windowMinutes: number;
  readonly usedPercent: number;
  readonly resetsAt: Option.Option<number>;
  /** True when the window is spent: full, named by `limit_reached`, or refused a turn. */
  readonly exhausted: boolean;
}

/** A window's key and the words a meter shows for it. */
interface WindowName {
  readonly id: string;
  readonly label: string;
}

const windowName = (minutes: number): WindowName => {
  if (minutes === SESSION_MINS) {
    return { id: "five_hour", label: "Session" } satisfies WindowName;
  }

  if (minutes === WEEK_MINS) {
    return { id: "seven_day", label: "Weekly" } satisfies WindowName;
  }

  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);

    return { id: `${days}_day`, label: `${days}-day` } satisfies WindowName;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;

    return {
      id: `${hours}_hour`,
      label: `${hours}-hour`,
    } satisfies WindowName;
  }

  return {
    id: `${minutes}_minute`,
    label: `${minutes}-minute`,
  } satisfies WindowName;
};

/** The index of the fullest window, the one a refusal or `limit_reached` names. */
const fullestIndex = (
  windows: ReadonlyArray<{ readonly usedPercent: number }>
) => {
  let best = 0;

  for (const [index, window] of windows.entries()) {
    if (window.usedPercent > (windows[best]?.usedPercent ?? -1)) {
      best = index;
    }
  }

  return best;
};

/**
 * The plan windows in a `wham/usage` body, shortest first; none when the body is not a shape this
 * reader knows: not JSON, longer than `MAX_BODY_LENGTH`, no `rate_limit`, a field of another type,
 * a window whose length is not whole minutes, no window at all, or two windows of the same length.
 */
export const readUsageBody = (
  body: string
): Option.Option<ReadonlyArray<CodexWindow>> => {
  if (body.length > MAX_BODY_LENGTH) {
    return Option.none();
  }

  return Option.flatMap(decodeWhamUsage(body), ({ rate_limit: limits }) => {
    const raw = [limits.primary_window, limits.secondary_window].flatMap(
      (window) => (window === undefined || window === null ? [] : [window])
    );

    const lengths = new Set(raw.map((window) => window.limit_window_seconds));

    if (raw.length === 0 || lengths.size !== raw.length) {
      return Option.none();
    }

    const windows = raw
      .map((window) => {
        const minutes = window.limit_window_seconds / 60;
        const usedPercent = Math.min(window.used_percent, 100);

        return {
          ...windowName(minutes),
          windowMinutes: minutes,
          usedPercent,
          resetsAt: Option.map(
            Option.fromNullishOr(window.reset_at),
            (seconds) => seconds * 1000
          ),
          exhausted: usedPercent >= 100,
        };
      })
      .toSorted((a, b) => a.windowMinutes - b.windowMinutes);

    if (limits.limit_reached !== true) {
      return Option.some(windows);
    }

    const spent = fullestIndex(windows);

    return Option.some(
      windows.map((window, index) =>
        index === spent ? { ...window, exhausted: true } : window
      )
    );
  });
};

// --- The reading ---

/** Where the Codex reading stands. */
export type CodexUsageState =
  /** No Codex login is held (or none was looked for yet): Codex has no usage row. */
  | "signed_out"
  /** The last read decoded. */
  | "read"
  /** The endpoint answered with a shape this reader does not know. */
  | "unreadable"
  /** The last read got no answer, or a refusal; earlier windows stay, with their old time. */
  | "failed";

/** What is known about Codex's plan windows. */
export interface CodexUsageReading {
  readonly state: CodexUsageState;
  readonly windows: ReadonlyArray<CodexWindow>;
  /** When `windows` were read; none before the first read that decoded. */
  readonly checkedAt: Option.Option<number>;
  /** Why the last read did not decode or failed, in words safe to log. */
  readonly reason: Option.Option<string>;
  /**
   * A turn reported a spent Codex limit: the window it names stays exhausted until a read after
   * `until` (or, with no reset time, the next read) says otherwise.
   */
  readonly limit: Option.Option<{ readonly until: Option.Option<number> }>;
}

/** Before any read: no login is known. */
export const INITIAL_READING: CodexUsageReading = {
  state: "signed_out",
  windows: [],
  checkedAt: Option.none(),
  reason: Option.none(),
  limit: Option.none(),
};

/** What one read came back with. */
type ReadOutcome =
  | { readonly kind: "signed_out" }
  | { readonly kind: "body"; readonly body: string }
  | { readonly kind: "failed"; readonly reason: string };

/** The window a refusal names: the one resetting nearest `until`, else the fullest. */
const limitedIndex = (
  windows: ReadonlyArray<CodexWindow>,
  until: Option.Option<number>
) =>
  Option.match(until, {
    onNone: () => fullestIndex(windows),
    onSome: (at) => {
      let nearest = Option.none<{ index: number; distance: number }>();

      for (const [index, window] of windows.entries()) {
        if (Option.isSome(window.resetsAt)) {
          const distance = Math.abs(window.resetsAt.value - at);

          if (!Option.exists(nearest, (best) => best.distance <= distance)) {
            nearest = Option.some({ index, distance });
          }
        }
      }

      return Option.match(nearest, {
        onNone: () => fullestIndex(windows),
        onSome: (best) => best.index,
      });
    },
  });

const markLimited = (
  windows: ReadonlyArray<CodexWindow>,
  limit: CodexUsageReading["limit"]
): ReadonlyArray<CodexWindow> =>
  Option.match(limit, {
    onNone: () => windows,
    onSome: ({ until }) => {
      const spent = limitedIndex(windows, until);

      return windows.map((window, index) =>
        index === spent ? { ...window, exhausted: true } : window
      );
    },
  });

/** The reading after a read finished at `now`. */
const applyOutcome = (
  current: CodexUsageReading,
  outcome: ReadOutcome,
  now: number
): CodexUsageReading => {
  if (outcome.kind === "signed_out") {
    return INITIAL_READING;
  }

  if (outcome.kind === "failed") {
    return { ...current, state: "failed", reason: Option.some(outcome.reason) };
  }

  return Option.match(readUsageBody(outcome.body), {
    onNone: (): CodexUsageReading => ({
      ...current,
      state: "unreadable",
      windows: [],
      checkedAt: Option.some(now),
      reason: Option.some(
        "the usage answer has a shape this reader does not know"
      ),
    }),
    onSome: (windows): CodexUsageReading => {
      // The endpoint agrees once it shows a spent window; a limit with a reset time holds until
      // that time passes, one without holds only until this read.
      const agrees = windows.some((window) => window.exhausted);

      const limit = Option.filter(
        current.limit,
        ({ until }) => !agrees && Option.exists(until, (at) => now < at)
      );

      return {
        state: "read",
        windows: markLimited(windows, limit),
        checkedAt: Option.some(now),
        reason: Option.none(),
        limit,
      };
    },
  });
};

/** The reading after a turn reported a spent Codex limit resetting at `until`. */
const applyLimit = (
  current: CodexUsageReading,
  until: Option.Option<number>
): CodexUsageReading => {
  const limit = Option.some({ until });

  return { ...current, windows: markLimited(current.windows, limit), limit };
};

/**
 * The Codex row for `usage.subscribe`: none while signed out. An unreadable answer is a row with no
 * windows and a check time; a failed read keeps the last windows and their old check time.
 */
export const toProviderUsage = (
  reading: CodexUsageReading
): ReadonlyArray<ProviderUsage> =>
  reading.state === "signed_out"
    ? []
    : [
        {
          provider: CODEX_PROVIDER,
          windows: reading.windows.map((window): PlanWindow => ({
            id: window.id,
            label: window.label,
            used: Option.some(window.usedPercent / 100),
            resetsAt: Option.map(window.resetsAt, (at) =>
              DateTime.makeUnsafe(at)
            ),
            exhausted: window.exhausted,
          })),
          checkedAt: Option.map(reading.checkedAt, (at) =>
            DateTime.makeUnsafe(at)
          ),
        },
      ];

/**
 * Whether the row's windows can be read, in the words `ProviderUsage.reading` will carry: a failed
 * read with windows from before still shows them; without any it reads as unreadable.
 */
export const readingOf = (reading: CodexUsageReading): "read" | "unreadable" =>
  reading.state === "read" ||
  (reading.state === "failed" && reading.windows.length > 0)
    ? "read"
    : "unreadable";

// --- The service ---

/** Codex's plan windows. */
export class CodexUsage extends Context.Service<
  CodexUsage,
  {
    /** What is known now. */
    readonly current: Effect.Effect<CodexUsageReading>;
    /** The current reading, then each change. Counts as a watcher while it runs. */
    readonly changes: Stream.Stream<CodexUsageReading>;
    /** The Codex row on the wire (none while signed out), then each change. Counts as a watcher. */
    readonly watch: Stream.Stream<ReadonlyArray<ProviderUsage>>;
    /** Reads now, or joins the read already running, and waits until it is applied. */
    readonly read: Effect.Effect<void>;
    /**
     * Marks the window a refused turn names as exhausted (the one resetting nearest `resetsAt`,
     * epoch milliseconds, else the fullest) and starts one read.
     */
    observeLimit(resetsAt: Option.Option<number>): Effect.Effect<void>;
  }
>()("cairn/server/usage/CodexUsage") {
  /**
   * Needs an `HttpClient`; reads the login through `CodexAccess`. Never reads on an idle timer: only
   * when a watcher arrives and the last read is stale, every `PROBE_EVERY` while one watches, and
   * after a refusal.
   */
  static readonly layerNoDeps = Layer.effect(
    CodexUsage,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const access = yield* CodexAccess;
      const scope = yield* Effect.scope;

      const ref = yield* SubscriptionRef.make(INITIAL_READING);
      const inFlight = yield* Ref.make(Option.none<Deferred.Deferred<true>>());
      const lastStartedAt = yield* Ref.make(Option.none<number>());
      const watchers = yield* Ref.make(0);

      const fetchBody = (credential: CodexCredential) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.get(CODEX_USAGE_URL).pipe(
            HttpClientRequest.bearerToken(credential.access),
            HttpClientRequest.setHeaders({
              accept: "application/json",
              "chatgpt-account-id": credential.accountId,
            })
          );

          const response = yield* client.execute(request);

          if (response.status !== 200) {
            return {
              kind: "failed",
              reason: `the usage endpoint answered HTTP ${response.status}`,
            } satisfies ReadOutcome;
          }

          const body = yield* response.text;

          return { kind: "body", body } satisfies ReadOutcome;
        }).pipe(
          Effect.timeoutOption(READ_TIMEOUT),
          Effect.result,
          Effect.map((answer): ReadOutcome =>
            Result.match(answer, {
              onFailure: (error) => ({
                kind: "failed",
                reason: `the usage endpoint could not be reached (${error.reason._tag})`,
              }),
              onSuccess: (found) =>
                Option.getOrElse(found, (): ReadOutcome => ({
                  kind: "failed",
                  reason: `the usage endpoint timed out after ${Duration.toMillis(READ_TIMEOUT)} ms`,
                })),
            })
          )
        );

      const runRead = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;

        yield* Ref.set(lastStartedAt, Option.some(started));

        const credential = yield* access.credential;

        const outcome = yield* Option.match(credential, {
          onNone: () => Effect.succeed<ReadOutcome>({ kind: "signed_out" }),
          onSome: fetchBody,
        });

        const ended = yield* Clock.currentTimeMillis;

        const next = yield* SubscriptionRef.updateAndGet(ref, (current) =>
          applyOutcome(current, outcome, ended)
        );

        yield* Effect.logInfo("codex usage read").pipe(
          Effect.annotateLogs({
            ms: ended - started,
            state: next.state,
            reason: Option.getOrElse(next.reason, () => ""),
            windows: next.windows
              .map((window) => `${window.id}=${Math.round(window.usedPercent)}`)
              .join(" "),
          })
        );
      });

      const read = Effect.gen(function* () {
        const fresh = yield* Deferred.make<true>();

        const [flight, mine] = yield* Ref.modify(
          inFlight,
          (
            current
          ): readonly [
            readonly [Deferred.Deferred<true>, boolean],
            Option.Option<Deferred.Deferred<true>>,
          ] =>
            Option.isSome(current)
              ? [[current.value, false], current]
              : [[fresh, true], Option.some(fresh)]
        );

        if (mine) {
          // In the layer's scope, so a caller that stops waiting never cancels a read others joined.
          yield* Effect.forkIn(
            runRead.pipe(
              Effect.ensuring(
                Effect.andThen(
                  Ref.set(inFlight, Option.none()),
                  Deferred.succeed(fresh, true)
                )
              )
            ),
            scope
          );
        }

        yield* Deferred.await(flight);
      });

      const readInBackground = Effect.asVoid(Effect.forkIn(read, scope));

      const stale = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const started = yield* Ref.get(lastStartedAt);

        return Option.match(started, {
          onNone: () => true,
          onSome: (at) => now - at > Duration.toMillis(STALE_PROBE),
        });
      });

      // The tick: only while someone watches.
      yield* Effect.forkIn(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(PROBE_EVERY);

            if ((yield* Ref.get(watchers)) > 0) {
              yield* read;
            }
          })
        ),
        scope
      );

      const observeLimit = Effect.fn("CodexUsage.observeLimit")(function* (
        resetsAt: Option.Option<number>
      ) {
        yield* SubscriptionRef.update(ref, (current) =>
          applyLimit(current, resetsAt)
        );
        yield* readInBackground;
      });

      const changes = Stream.unwrap(
        Effect.as(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Ref.update(watchers, (n) => n + 1);

              if (yield* stale) {
                yield* readInBackground;
              }
            }),
            () => Ref.update(watchers, (n) => n - 1)
          ),
          SubscriptionRef.changes(ref)
        )
      );

      return CodexUsage.of({
        current: SubscriptionRef.get(ref),
        changes,
        watch: Stream.map(changes, toProviderUsage),
        read,
        observeLimit,
      });
    })
  );

  /** Over the global `fetch`; the login comes from whatever `CodexAccess` the root provides. */
  static readonly layer = CodexUsage.layerNoDeps.pipe(
    Layer.provide(FetchHttpClient.layer)
  );
}
