// Ported from github.com/HazAT/ultimate, extensions/health/store.ts at
// 8b26338680fc5bc970b68c281c4e9b03a09887c1. Kept: an error is stored as words from a fixed
// vocabulary so no credential can reach storage; failures are sorted into auth, capacity and
// transient by those words; only failures newer than the last success count, so writes merged out of
// order still count right; capacity failures never mark a provider. Changed: Cairn's rule from
// docs/phase-2/notes/models.md (failing after an auth failure newer than the last success, or three
// transient failures inside five minutes with no success between), a usage limit as its own state
// (`limited` until the reset a Codex limit names; a limit that names none, as OpenCode Go's and the
// Claude plan's, lifts at the next success or after `UNSTATED_LIMIT_MS`, so role resolution sends one
// request an hour to find out); request-specific failures (bad request, unknown model, context
// overflow) as their own kind that never counts; the record kept in memory and in `cairn.sqlite`
// instead of a JSON file, and time from `Clock`. Ultimate's `reset` on a login change is kept as
// `ModelHealth.reset`, which the login and logout RPCs call.
//
// MIT License. Copyright (c) 2026 Daniel Griesser
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Clock,
  Context,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";

import { usageLimitOf } from "../brain/RunFailure.ts";

/** Transient failures that turn a provider failing when they fall inside `STREAK_WINDOW_MS`. */
export const STREAK = 3;

/** The span `STREAK` transient failures must fall inside, with no success between. */
export const STREAK_WINDOW_MS = 5 * 60_000;

/**
 * How long a usage limit that names no reset holds without a success. OpenCode Go's monthly limit
 * and a spent Claude window say nothing about when they lift, and role resolution never sends to a
 * limited provider, so without this ceiling no success would ever come to clear one. After it the
 * provider reads as it did before the limit; one more limited answer marks it again.
 */
export const UNSTATED_LIMIT_MS = 60 * 60_000;

/**
 * The only words a stored error may contain: provider and OAuth error codes, network errors, plan
 * limit names and a few plain words. A fixed list, so nothing from a credential can pass.
 */
const KNOWN: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_client",
  "invalid_request",
  "invalid_api_key",
  "unauthorized_client",
  "access_denied",
  "authentication_error",
  "permission_error",
  "insufficient_quota",
  "rate_limit_error",
  "rate_limit_exceeded",
  "usage_limit_reached",
  "usage_not_included",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "overloaded_error",
  "api_error",
  "server_error",
  "not_found_error",
  "model_not_found",
  "invalid_request_error",
  "context_length_exceeded",
  "request_too_large",
  "unauthorized",
  "forbidden",
  "expired",
  "revoked",
  "overloaded",
  "timeout",
  "terminated",
  "aborted",
  "quota",
  "unavailable",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/** Each known word by its lower case, so `Unauthorized` is stored as `unauthorized`. */
const KNOWN_LOWER: ReadonlyMap<string, string> = new Map(
  [...KNOWN].map((word) => [word.toLowerCase(), word])
);

const STATUS =
  /^\s*(?<lead>[45]\d\d)\b|\b(?:status|http)[\s:=(]*(?<named>[45]\d\d)\b|\((?<paren>[45]\d\d)\)/iu;

/** The most words a stored error keeps. */
const MAX_PARTS = 5;

/**
 * A failure message reduced to what may be stored: the HTTP status when it leads or is named
 * (`401 ...`, `status 429`, `API error (403)`), then the known words it contains, in order, without
 * duplicates; anything else is dropped, and a message with nothing known is "request failed".
 */
export const sanitizeError = (message: string): string => {
  const parts: Array<string> = [];
  const status = STATUS.exec(message)?.groups;
  const code = status?.lead ?? status?.named ?? status?.paren;

  if (code !== undefined) {
    parts.push(code);
  }

  for (const word of message.split(/[^A-Za-z_]+/u)) {
    if (parts.length >= MAX_PARTS) {
      break;
    }

    const known = KNOWN_LOWER.get(word.toLowerCase());

    if (known !== undefined && !parts.includes(known)) {
      parts.push(known);
    }
  }

  return parts.length === 0 ? "request failed" : parts.join(" ");
};

const AUTH: ReadonlySet<string> = new Set([
  "401",
  "403",
  "invalid_grant",
  "invalid_token",
  "invalid_client",
  "invalid_api_key",
  "unauthorized_client",
  "access_denied",
  "authentication_error",
  "permission_error",
  "unauthorized",
  "forbidden",
  "expired",
  "revoked",
]);

const CAPACITY: ReadonlySet<string> = new Set([
  "429",
  "529",
  "overloaded_error",
  "overloaded",
  "rate_limit_error",
  "rate_limit_exceeded",
  "insufficient_quota",
  "quota",
]);

/**
 * Failures of one request, not of its provider: a bad or oversized request, an unknown model, a
 * context overflow. The words `classifyRunFailure` takes as permanent, less the auth ones.
 */
const REQUEST: ReadonlySet<string> = new Set([
  "400",
  "404",
  "413",
  "422",
  "invalid_request",
  "invalid_request_error",
  "context_length_exceeded",
  "model_not_found",
  "not_found_error",
  "request_too_large",
]);

/** What a failure says about its provider. */
export type FailureKind =
  | "limit"
  | "auth"
  | "capacity"
  | "request"
  | "transient";

/**
 * A failure's kind: `limit` for a plan's usage limit (`classifyRunFailure`'s patterns), `auth` when
 * the login is broken, `capacity` when the provider is busy or rate limited, `request` when the
 * request itself was wrong (neither of those two ever counts), and `transient` for anything else
 * (timeouts, network errors, server errors).
 *
 * pi-durable's `afterResponse` fires for every attempt, retries included, so one request whose
 * retries run out would count up to its attempt count. The feed should record a request's attempts
 * as one outcome (its last), not one per attempt.
 */
export const failureKind = (message: string, at: DateTime.Utc): FailureKind => {
  if (Option.isSome(usageLimitOf(message, at))) {
    return "limit";
  }

  const parts = sanitizeError(message).split(" ");

  if (parts.some((part) => AUTH.has(part))) {
    return "auth";
  }

  if (parts.some((part) => CAPACITY.has(part))) {
    return "capacity";
  }

  if (parts.some((part) => REQUEST.has(part))) {
    return "request";
  }

  return "transient";
};

/** A usage limit a provider is under: since `at`, until `until` or the next success. */
export interface HealthLimit {
  readonly at: number;
  readonly until: Option.Option<number>;
}

/** One provider's health record. Times are epoch milliseconds. */
export interface HealthRecord {
  readonly lastOk: Option.Option<number>;
  /** The newest failure of any kind. */
  readonly lastFail: Option.Option<number>;
  /** The newest auth failure: it alone turns the provider failing. */
  readonly lastAuth: Option.Option<number>;
  /** The newest `STREAK` transient failures, oldest first. */
  readonly transient: ReadonlyArray<number>;
  readonly limit: Option.Option<HealthLimit>;
  /** The newest failure, as `sanitizeError` words. */
  readonly error: Option.Option<string>;
}

/** A provider nothing has been heard from. */
export const EMPTY_HEALTH: HealthRecord = {
  lastOk: Option.none(),
  lastFail: Option.none(),
  lastAuth: Option.none(),
  transient: [],
  limit: Option.none(),
  error: Option.none(),
};

/** A response or run that reached a provider. */
export type HealthOutcome = Data.TaggedEnum<{
  Succeeded: { readonly at: DateTime.Utc };
  Failed: { readonly at: DateTime.Utc; readonly message: string };
}>;

/** Builds and matches `HealthOutcome` values. */
export const HealthOutcome = Data.taggedEnum<HealthOutcome>();

/** A provider's health: `unknown` before any outcome, `limited` under a plan's usage limit. */
export type HealthState = "unknown" | "ok" | "limited" | "failing";

const newest = (a: Option.Option<number>, b: Option.Option<number>) => {
  if (Option.isNone(a)) {
    return b;
  }

  if (Option.isNone(b)) {
    return a;
  }

  return Option.some(Math.max(a.value, b.value));
};

const after = (time: number, since: Option.Option<number>) =>
  Option.isNone(since) || time > since.value;

/** True for none, else whether the value passes. */
const forAll = <A>(option: Option.Option<A>, predicate: (a: A) => boolean) =>
  Option.isNone(option) || predicate(option.value);

/** `record` with one failure folded in, counted by its kind. */
const applyFailure = (
  record: HealthRecord,
  failedAt: DateTime.Utc,
  message: string
): HealthRecord => {
  const at = DateTime.toEpochMillis(failedAt);
  const kind = failureKind(message, failedAt);
  const isNewest = after(at, record.lastFail);

  const limit: Option.Option<HealthLimit> =
    kind === "limit" && forAll(record.limit, (current) => at >= current.at)
      ? Option.some({
          at,
          until: Option.map(
            Option.flatMap(
              usageLimitOf(message, failedAt),
              (found) => found.resetAt
            ),
            DateTime.toEpochMillis
          ),
        })
      : record.limit;

  return {
    lastOk: record.lastOk,
    lastFail: newest(record.lastFail, Option.some(at)),
    lastAuth:
      kind === "auth"
        ? newest(record.lastAuth, Option.some(at))
        : record.lastAuth,
    transient:
      kind === "transient"
        ? [...new Set([...record.transient, at])]
            .toSorted((a, b) => a - b)
            .slice(-STREAK)
        : record.transient,
    limit,
    error: isNewest ? Option.some(sanitizeError(message)) : record.error,
  };
};

/**
 * `record` with `outcome` folded in. Order-free: stamps keep their maximum and the transient list
 * keeps the newest `STREAK`, so outcomes applied out of order give the same record. A success clears
 * nothing; `healthState` counts only what is newer than `lastOk`.
 */
export const applyOutcome = (
  record: HealthRecord,
  outcome: HealthOutcome
): HealthRecord =>
  HealthOutcome.$match(outcome, {
    Succeeded: (success) => ({
      ...record,
      lastOk: newest(
        record.lastOk,
        Option.some(DateTime.toEpochMillis(success.at))
      ),
    }),
    Failed: (failure) => applyFailure(record, failure.at, failure.message),
  });

/**
 * The provider's state at `now`: `failing` after an auth failure newer than the last success;
 * `limited` under a usage limit newer than the last success whose reset is still ahead (when it
 * names none, for `UNSTATED_LIMIT_MS` after it);
 * `failing` after `STREAK` transient failures inside `STREAK_WINDOW_MS` with no success between;
 * otherwise `ok` once anything succeeded, else `unknown`.
 */
export const healthState = (record: HealthRecord, now: number): HealthState => {
  if (Option.exists(record.lastAuth, (at) => after(at, record.lastOk))) {
    return "failing";
  }

  if (
    Option.exists(
      record.limit,
      (limit) =>
        after(limit.at, record.lastOk) &&
        now < Option.getOrElse(limit.until, () => limit.at + UNSTATED_LIMIT_MS)
    )
  ) {
    return "limited";
  }

  const streak = record.transient.filter((at) => after(at, record.lastOk));

  if (streak.length >= STREAK) {
    const recent = streak.slice(-STREAK);
    const first = recent[0] ?? 0;
    const last = recent.at(-1) ?? 0;

    if (last - first <= STREAK_WINDOW_MS) {
      return "failing";
    }
  }

  return Option.isSome(record.lastOk) ? "ok" : "unknown";
};

/**
 * What one provider response says about its provider, for an `afterResponse` hook: an `error` stop
 * is a failure with its message, an `aborted` one says nothing (the user or a budget stopped it),
 * and anything else is a success.
 */
export const outcomeOfResponse = (
  message: Pick<
    AssistantMessage,
    "provider" | "stopReason" | "errorMessage" | "timestamp"
  >
): Option.Option<readonly [provider: string, outcome: HealthOutcome]> => {
  const at = DateTime.makeUnsafe(message.timestamp);

  if (message.stopReason === "aborted") {
    return Option.none();
  }

  if (message.stopReason === "error") {
    return Option.some([
      message.provider,
      HealthOutcome.Failed({ at, message: message.errorMessage ?? "" }),
    ]);
  }

  return Option.some([message.provider, HealthOutcome.Succeeded({ at })]);
};

/** What `ModelHealth` reports for one provider. */
export interface ProviderHealth {
  readonly provider: string;
  readonly state: HealthState;
  /**
   * When a `limited` state lifts, as the limit named it; none when it named no reset (it then lifts
   * at the next success, or `UNSTATED_LIMIT_MS` after the limit).
   */
  readonly limitedUntil: Option.Option<DateTime.Utc>;
  readonly lastOk: Option.Option<DateTime.Utc>;
  /** The newest failure, as words from the fixed vocabulary. */
  readonly error: Option.Option<string>;
}

/** The health table could not be read or written. The in-memory record is unchanged; retry. */
export class ModelHealthError extends Schema.TaggedError<ModelHealthError>()(
  "ModelHealthError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "ModelHealth.load",
      "ModelHealth.record",
      "ModelHealth.reset",
    ]),
    provider: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  }
) {}

const Row = Schema.Struct({
  provider_id: Schema.String,
  last_ok: Schema.NullOr(Schema.Int),
  last_fail: Schema.NullOr(Schema.Int),
  last_auth: Schema.NullOr(Schema.Int),
  transient_json: Schema.fromJsonString(Schema.Array(Schema.Int)),
  limited_at: Schema.NullOr(Schema.Int),
  limited_until: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
});

const decodeRow = Schema.decodeUnknownEffect(Row);

const encodeTransient = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Int))
);

const recordOfRow = (row: typeof Row.Type): HealthRecord => ({
  lastOk: Option.fromNullOr(row.last_ok),
  lastFail: Option.fromNullOr(row.last_fail),
  lastAuth: Option.fromNullOr(row.last_auth),
  transient: row.transient_json.toSorted((a, b) => a - b).slice(-STREAK),
  limit: Option.map(Option.fromNullOr(row.limited_at), (at) => ({
    at,
    until: Option.fromNullOr(row.limited_until),
  })),
  // Stored words are sanitized again, so a row written by hand cannot carry text through.
  error: Option.map(Option.fromNullOr(row.error), sanitizeError),
});

const reportOf = (
  provider: string,
  record: HealthRecord,
  now: number
): ProviderHealth => {
  const state = healthState(record, now);

  return {
    provider,
    state,
    limitedUntil:
      state === "limited"
        ? Option.flatMap(record.limit, (limit) =>
            Option.map(limit.until, (until) => DateTime.makeUnsafe(until))
          )
        : Option.none(),
    lastOk: Option.map(record.lastOk, (at) => DateTime.makeUnsafe(at)),
    error: record.error,
  };
};

/**
 * Each provider's health, fed by the outcomes of its responses and runs, so role resolution can
 * pass over a provider that is failing or limited. Kept in memory and in `model_health`, so a
 * restart does not forget a revoked login or a spent plan.
 */
export class ModelHealth extends Context.Service<
  ModelHealth,
  {
    /** Folds one outcome into the provider's record and stores it. */
    record(
      provider: string,
      outcome: HealthOutcome
    ): Effect.Effect<void, ModelHealthError>;
    /** The provider's health now; `unknown` for a provider never heard from. */
    stateOf(provider: string): Effect.Effect<ProviderHealth>;
    /** Every provider heard from, by id. */
    readonly all: Effect.Effect<ReadonlyArray<ProviderHealth>>;
    /**
     * Forgets everything heard from the provider, for a login or logout: a new login mends a broken
     * one and may lift a limit, so the old record says nothing about it.
     */
    reset(provider: string): Effect.Effect<void, ModelHealthError>;
  }
>()("cairn/server/models/ModelHealth") {
  /** Loads `model_health` through the ambient `SqlClient`; a row that does not decode is skipped. */
  static readonly layerNoDeps = Layer.effect(
    ModelHealth,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql`SELECT * FROM model_health`.pipe(
        Effect.mapError(
          (cause) =>
            new ModelHealthError({
              message:
                "ModelHealth.load could not read the model_health table. The brain did not start; check cairn.sqlite.",
              operation: "ModelHealth.load",
              cause,
            })
        )
      );

      const loaded = new Map<string, HealthRecord>();

      for (const raw of rows) {
        const row = yield* decodeRow(raw).pipe(
          Effect.asSome,
          Effect.catchTag("SchemaError", () =>
            Effect.logWarning("stored model health no longer decodes").pipe(
              Effect.annotateLogs({ event: "model_health_reset" }),
              Effect.as(Option.none<typeof Row.Type>())
            )
          )
        );

        if (Option.isSome(row)) {
          loaded.set(row.value.provider_id, recordOfRow(row.value));
        }
      }

      const records =
        yield* Ref.make<ReadonlyMap<string, HealthRecord>>(loaded);

      const writes = yield* Semaphore.make(1);

      const record = Effect.fn("ModelHealth.record")(
        function* (provider: string, outcome: HealthOutcome) {
          yield* writes.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* Ref.get(records);

              const next = applyOutcome(
                current.get(provider) ?? EMPTY_HEALTH,
                outcome
              );

              const now = yield* Clock.currentTimeMillis;

              yield* sql`
                INSERT INTO model_health (
                  provider_id, last_ok, last_fail, last_auth, transient_json,
                  limited_at, limited_until, error, updated_at
                ) VALUES (
                  ${provider},
                  ${Option.getOrNull(next.lastOk)},
                  ${Option.getOrNull(next.lastFail)},
                  ${Option.getOrNull(next.lastAuth)},
                  ${encodeTransient(next.transient)},
                  ${Option.getOrNull(Option.map(next.limit, (limit) => limit.at))},
                  ${Option.getOrNull(Option.flatMap(next.limit, (limit) => limit.until))},
                  ${Option.getOrNull(next.error)},
                  ${now}
                )
                ON CONFLICT (provider_id) DO UPDATE SET
                  last_ok = excluded.last_ok,
                  last_fail = excluded.last_fail,
                  last_auth = excluded.last_auth,
                  transient_json = excluded.transient_json,
                  limited_at = excluded.limited_at,
                  limited_until = excluded.limited_until,
                  error = excluded.error,
                  updated_at = excluded.updated_at
              `;

              yield* Ref.set(records, new Map(current).set(provider, next));
            })
          );
        },
        (effect, provider) =>
          effect.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                new ModelHealthError({
                  message: `ModelHealth.record could not store the health of provider ${provider}. The stored and in-memory records are unchanged; the next outcome writes again.`,
                  operation: "ModelHealth.record",
                  provider,
                  cause,
                })
              )
            )
          )
      );

      const stateOf = Effect.fn("ModelHealth.stateOf")(function* (
        provider: string
      ) {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(records);

        return reportOf(provider, current.get(provider) ?? EMPTY_HEALTH, now);
      });

      const all = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(records);

        return [...current.entries()]
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([provider, health]) => reportOf(provider, health, now));
      }).pipe(Effect.withSpan("ModelHealth.all"));

      const reset = Effect.fn("ModelHealth.reset")(
        function* (provider: string) {
          yield* writes.withPermits(1)(
            Effect.gen(function* () {
              yield* sql`DELETE FROM model_health WHERE provider_id = ${provider}`;

              yield* Ref.update(records, (current) => {
                const next = new Map(current);
                next.delete(provider);

                return next;
              });
            })
          );
        },
        (effect, provider) =>
          effect.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                new ModelHealthError({
                  message: `ModelHealth.reset could not forget the health of provider ${provider}. The stored and in-memory records are unchanged; reset again.`,
                  operation: "ModelHealth.reset",
                  provider,
                  cause,
                })
              )
            )
          )
      );

      return ModelHealth.of({ record, stateOf, all, reset });
    })
  );
}
