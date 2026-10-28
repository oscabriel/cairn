// J-health (docs/phase-2/notes/models.md): one auth failure turns a provider failing until a
// success; three transient failures within five minutes do, two do not, and three spread wider do
// not; capacity and request failures never count; a Codex limit holds until the reset it names and
// an OpenCode Go limit until the next success or for an hour; the stored error holds only the fixed
// vocabulary; `reset` forgets a provider; and the record survives a restart, on a migrated in-memory
// cairn.sqlite.

import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ModelHealth0008 } from "../db/migrations/0008ModelHealth.ts";
import {
  applyOutcome,
  EMPTY_HEALTH,
  HealthOutcome,
  healthState,
  ModelHealth,
  outcomeOfResponse,
  sanitizeError,
  UNSTATED_LIMIT_MS,
} from "./ModelHealth.ts";

const DbLayer = Database.layerTest({
  ...migrations,
  "0008_ModelHealth": ModelHealth0008,
});

const TestLayer = ModelHealth.layerNoDeps.pipe(Layer.provideMerge(DbLayer));

const BASE = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-10-28T12:00:00Z")
);

const MINUTE = 60_000;

const at = (minutes: number) => DateTime.makeUnsafe(BASE + minutes * MINUTE);

const ok = (minutes: number) => HealthOutcome.Succeeded({ at: at(minutes) });

const failed = (minutes: number, message: string) =>
  HealthOutcome.Failed({ at: at(minutes), message });

const TRANSIENT = "fetch failed: ECONNRESET";

/** Records `outcomes` for `provider`, sets the clock to `nowMinutes` and reads the state. */
const stateAfter = (
  provider: string,
  outcomes: ReadonlyArray<HealthOutcome>,
  nowMinutes: number
) =>
  Effect.gen(function* () {
    const health = yield* ModelHealth;

    for (const outcome of outcomes) {
      yield* health.record(provider, outcome);
    }

    yield* TestClock.setTime(BASE + nowMinutes * MINUTE);

    return yield* health.stateOf(provider);
  });

const StoredRow = Schema.Array(
  Schema.Struct({ error: Schema.NullOr(Schema.String) })
);

/** Every outcome folded into an empty record, in the order given. */
const fold = (list: ReadonlyArray<HealthOutcome>) => {
  let record = EMPTY_HEALTH;

  for (const outcome of list) {
    record = applyOutcome(record, outcome);
  }

  return record;
};

describe("provider health", () => {
  it.effect(
    "reads unknown before anything is heard and ok after a success",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* stateAfter("opencode-go", [], 0)).state,
          "unknown"
        );
        assert.strictEqual(
          (yield* stateAfter("opencode-go", [ok(0)], 1)).state,
          "ok"
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect("turns failing on one auth failure, until a success", () =>
    Effect.gen(function* () {
      const health = yield* ModelHealth;

      const broken = yield* stateAfter(
        "openai-codex",
        [ok(0), failed(1, "401 invalid_grant: refresh token revoked")],
        2
      );

      assert.strictEqual(broken.state, "failing");

      // Still failing hours later: a broken login does not mend itself.
      yield* TestClock.setTime(BASE + 600 * MINUTE);
      assert.strictEqual(
        (yield* health.stateOf("openai-codex")).state,
        "failing"
      );

      yield* health.record("openai-codex", ok(601));
      assert.strictEqual((yield* health.stateOf("openai-codex")).state, "ok");
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "turns failing on three transient failures within five minutes",
    () =>
      Effect.gen(function* () {
        const health = yield* ModelHealth;

        const state = yield* stateAfter(
          "opencode-go",
          [
            ok(0),
            failed(1, TRANSIENT),
            failed(3, TRANSIENT),
            failed(6, TRANSIENT),
          ],
          7
        );

        assert.strictEqual(state.state, "failing");

        yield* health.record("opencode-go", ok(8));
        assert.strictEqual((yield* health.stateOf("opencode-go")).state, "ok");
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect("stays ok on two transient failures", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(
        "opencode-go",
        [ok(0), failed(1, TRANSIENT), failed(2, "503 server_error")],
        3
      );

      assert.strictEqual(state.state, "ok");
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "stays ok on three transient failures spread over more than five minutes",
    () =>
      Effect.gen(function* () {
        const state = yield* stateAfter(
          "opencode-go",
          [
            ok(0),
            failed(1, TRANSIENT),
            failed(4, TRANSIENT),
            failed(7, TRANSIENT),
          ],
          8
        );

        assert.strictEqual(state.state, "ok");
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "does not count transient failures from before the last success",
    () =>
      Effect.gen(function* () {
        const state = yield* stateAfter(
          "opencode-go",
          [
            failed(1, TRANSIENT),
            failed(2, TRANSIENT),
            ok(3),
            failed(4, TRANSIENT),
          ],
          5
        );

        assert.strictEqual(state.state, "ok");
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect("never counts capacity failures", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(
        "claude-bridge",
        [
          ok(0),
          failed(1, "429 rate_limit_error"),
          failed(1.5, "529 overloaded_error"),
          failed(2, "429 Too Many Requests"),
        ],
        3
      );

      assert.strictEqual(state.state, "ok");
      assert.deepStrictEqual(state.error, Option.some("429"));
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect("holds a Codex limit until the reset it names", () =>
    Effect.gen(function* () {
      const health = yield* ModelHealth;

      const limited = yield* stateAfter(
        "openai-codex",
        [
          ok(0),
          failed(
            1,
            "You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min."
          ),
        ],
        2
      );

      assert.strictEqual(limited.state, "limited");
      assert.deepStrictEqual(limited.limitedUntil, Option.some(at(31)));

      yield* TestClock.setTime(BASE + 31 * MINUTE);
      assert.strictEqual((yield* health.stateOf("openai-codex")).state, "ok");
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "holds an OpenCode Go limit until the next success, or for an hour",
    () =>
      Effect.gen(function* () {
        const health = yield* ModelHealth;
        const hour = UNSTATED_LIMIT_MS / MINUTE;

        const limited = yield* stateAfter(
          "opencode-go",
          [
            ok(0),
            failed(
              1,
              '429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Rolling usage limit reached"}}'
            ),
          ],
          hour
        );

        assert.strictEqual(limited.state, "limited");
        assert.isTrue(Option.isNone(limited.limitedUntil));
        assert.deepStrictEqual(
          limited.error,
          Option.some("429 GoUsageLimitError")
        );

        yield* health.record("opencode-go", ok(hour));
        assert.strictEqual((yield* health.stateOf("opencode-go")).state, "ok");

        // A limit that names no reset lapses after an hour, so one request can find out; another
        // limited answer marks the provider again.
        yield* health.record(
          "opencode-go",
          failed(hour + 1, "Monthly usage limit reached")
        );
        yield* TestClock.setTime(BASE + (hour + 1) * MINUTE);
        assert.strictEqual(
          (yield* health.stateOf("opencode-go")).state,
          "limited"
        );

        yield* TestClock.setTime(BASE + (2 * hour + 1) * MINUTE);
        assert.strictEqual((yield* health.stateOf("opencode-go")).state, "ok");

        yield* health.record(
          "opencode-go",
          failed(2 * hour + 1, "Monthly usage limit reached")
        );
        assert.strictEqual(
          (yield* health.stateOf("opencode-go")).state,
          "limited"
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect("never counts a failure of the request itself", () =>
    Effect.gen(function* () {
      const state = yield* stateAfter(
        "openai-codex",
        [
          ok(0),
          failed(1, "400 context_length_exceeded"),
          failed(2, "404 model_not_found"),
          failed(3, "invalid_request_error: messages too long"),
          failed(4, "413 request_too_large"),
        ],
        5
      );

      assert.strictEqual(state.state, "ok");
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect("forgets a provider on reset, in memory and in storage", () =>
    Effect.gen(function* () {
      const fresh = ModelHealth.pipe(Effect.provide(ModelHealth.layerNoDeps));

      const before = yield* fresh;

      yield* before.record("openai-codex", ok(0));
      yield* before.record("openai-codex", failed(1, "401 invalid_grant"));
      yield* before.record("opencode-go", ok(0));
      yield* TestClock.setTime(BASE + 2 * MINUTE);

      yield* before.reset("openai-codex");
      assert.strictEqual(
        (yield* before.stateOf("openai-codex")).state,
        "unknown"
      );

      const after = yield* fresh;

      assert.strictEqual(
        (yield* after.stateOf("openai-codex")).state,
        "unknown"
      );
      assert.deepStrictEqual(
        (yield* after.all).map((health) => health.provider),
        ["opencode-go"]
      );
    }).pipe(Effect.provide(DbLayer))
  );

  it.effect("stores only words from the fixed vocabulary", () =>
    Effect.gen(function* () {
      const health = yield* ModelHealth;
      const sql = yield* SqlClient.SqlClient;

      const secret = "sk-ant-oat01-NOTAREALKEYbutLooksLikeOne";

      yield* health.record(
        "opencode-go",
        failed(
          1,
          `401 Unauthorized: invalid_api_key ${secret} for account oscar@example.com (Bearer ${secret})`
        )
      );

      const rows = yield* sql`SELECT * FROM model_health`;
      const stored = JSON.stringify(rows);

      assert.notInclude(stored, "NOTAREALKEY");
      assert.notInclude(stored, "example.com");
      assert.notInclude(stored, "Bearer");

      const [row] = yield* Schema.decodeUnknownEffect(StoredRow)(rows);

      assert.strictEqual(row?.error, "401 unauthorized invalid_api_key");
      assert.deepStrictEqual(
        (yield* health.stateOf("opencode-go")).error,
        Option.some("401 unauthorized invalid_api_key")
      );
    }).pipe(Effect.provide(TestLayer))
  );

  it("reduces a message with nothing known to a fixed phrase", () => {
    assert.strictEqual(
      sanitizeError("the key abc123 was refused by the gateway"),
      "request failed"
    );
    assert.strictEqual(
      sanitizeError("openai-codex API error (403): forbidden"),
      "403 forbidden"
    );
    assert.strictEqual(sanitizeError("status: 502 bad gateway"), "502");
  });

  it.effect("remembers a revoked login and a spent plan across a restart", () =>
    Effect.gen(function* () {
      const fresh = ModelHealth.pipe(Effect.provide(ModelHealth.layerNoDeps));

      const before = yield* fresh;

      yield* before.record("openai-codex", ok(0));
      yield* before.record("openai-codex", failed(1, "401 invalid_grant"));
      yield* before.record(
        "opencode-go",
        failed(1, "Monthly usage limit reached")
      );

      const after = yield* fresh;

      yield* TestClock.setTime(BASE + 2 * MINUTE);

      assert.strictEqual(
        (yield* after.stateOf("openai-codex")).state,
        "failing"
      );
      assert.strictEqual(
        (yield* after.stateOf("opencode-go")).state,
        "limited"
      );
      assert.deepStrictEqual(
        (yield* after.all).map((health) => health.provider),
        ["openai-codex", "opencode-go"]
      );
    }).pipe(Effect.provide(DbLayer))
  );

  it.effect("skips a stored row that no longer decodes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO model_health (provider_id, transient_json, updated_at)
        VALUES ('opencode-go', 'not json', 0)
      `;

      const health = yield* ModelHealth.pipe(
        Effect.provide(ModelHealth.layerNoDeps)
      );

      assert.strictEqual(
        (yield* health.stateOf("opencode-go")).state,
        "unknown"
      );
      yield* health.record("opencode-go", ok(0));
      assert.strictEqual((yield* health.stateOf("opencode-go")).state, "ok");
    }).pipe(Effect.provide(DbLayer))
  );

  it("gives the same state whatever order the outcomes arrive in", () => {
    const outcomes = [
      ok(0),
      failed(1, TRANSIENT),
      failed(2, TRANSIENT),
      failed(3, TRANSIENT),
      ok(4),
      failed(5, "401 unauthorized"),
    ];

    const forward = fold(outcomes);
    const backward = fold(outcomes.toReversed());

    assert.deepStrictEqual(forward, backward);
    assert.strictEqual(healthState(forward, BASE + 6 * MINUTE), "failing");
  });

  it("reads a provider response as an outcome, and an abort as none", () => {
    const timestamp = BASE;

    assert.deepStrictEqual(
      outcomeOfResponse({
        provider: "opencode-go",
        stopReason: "stop",
        timestamp,
      }),
      Option.some(["opencode-go", ok(0)] as const)
    );
    assert.deepStrictEqual(
      outcomeOfResponse({
        provider: "openai-codex",
        stopReason: "error",
        errorMessage: "401 invalid_grant",
        timestamp,
      }),
      Option.some(["openai-codex", failed(0, "401 invalid_grant")] as const)
    );
    assert.isTrue(
      Option.isNone(
        outcomeOfResponse({
          provider: "claude-bridge",
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          timestamp,
        })
      )
    );
  });
});
