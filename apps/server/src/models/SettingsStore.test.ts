// Judges the server settings store on a migrated in-memory cairn.sqlite: defaults before anything
// is set, a patch changes only its present keys and survives a fresh read, and a stored value that
// no longer decodes reads as its default instead of failing every read. A role table a brain
// stored before ADR 0043 removed roles stays in its row and breaks neither a read nor an update.

import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { DEFAULT_SERVER_SETTINGS, SettingsStore } from "./SettingsStore.ts";

const TestLayer = SettingsStore.layerNoDeps.pipe(
  Layer.provideMerge(Database.layerTest(migrations))
);

describe("the server settings", () => {
  it.effect("reads the defaults before anything is set", () =>
    Effect.gen(function* () {
      const store = yield* SettingsStore;

      assert.deepStrictEqual(yield* store.get, DEFAULT_SERVER_SETTINGS);
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect("changes only the patch's present keys, durably", () =>
    Effect.gen(function* () {
      const store = yield* SettingsStore;

      const updated = yield* store.update({
        autoSettleDays: Option.none(),
        titleModel: Option.some(
          Option.some({ provider: "opencode-go", modelId: "kimi-k2" })
        ),
        bridgeEnabled: Option.some(false),
        bridgeGenerationCap: Option.none(),
        defaultBudget: Option.none(),
      });

      const expected = {
        ...DEFAULT_SERVER_SETTINGS,
        titleModel: Option.some({
          provider: "opencode-go",
          modelId: "kimi-k2",
        }),
        bridgeEnabled: false,
      };

      assert.deepStrictEqual(updated, expected);
      assert.deepStrictEqual(yield* store.get, expected);

      const cleared = yield* store.update({
        autoSettleDays: Option.some(0),
        titleModel: Option.some(Option.none()),
        bridgeEnabled: Option.none(),
        bridgeGenerationCap: Option.none(),
        defaultBudget: Option.none(),
      });

      assert.strictEqual(cleared.autoSettleDays, 0);
      assert.isTrue(Option.isNone(cleared.titleModel));
      assert.isFalse(cleared.bridgeEnabled);
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect("reads a value that no longer decodes as its default", () =>
    Effect.gen(function* () {
      const store = yield* SettingsStore;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES ('bridgeGenerationCap', '"many"', 0)
      `;

      const settings = yield* store.get;

      assert.strictEqual(
        settings.bridgeGenerationCap,
        DEFAULT_SERVER_SETTINGS.bridgeGenerationCap
      );
    }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "reads and updates past a role table stored before roles were removed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // The row the role table's seed wrote on every brain before ADR 0043, as it encoded it.
        const table = JSON.stringify({
          "@worker": {
            model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
            thinkingLevel: "medium",
            fallbacks: [],
            note: null,
          },
          "@judge": {
            model: { provider: "opencode-go", modelId: "gpt-6-luna" },
            thinkingLevel: null,
            fallbacks: [],
            note: null,
          },
        });

        yield* sql`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES ('roleBindings', ${table}, 0)
        `;

        // A store built over the database, as a boot builds it.
        const built = yield* Layer.build(SettingsStore.layerNoDeps);
        const store = Context.get(built, SettingsStore);

        assert.deepStrictEqual(yield* store.get, DEFAULT_SERVER_SETTINGS);

        const updated = yield* store.update({
          autoSettleDays: Option.some(5),
          titleModel: Option.none(),
          bridgeEnabled: Option.none(),
          bridgeGenerationCap: Option.none(),
          defaultBudget: Option.none(),
        });

        assert.strictEqual(updated.autoSettleDays, 5);

        const rows = yield* sql<{
          readonly value_json: string;
        }>`SELECT value_json FROM settings WHERE key = 'roleBindings'`;

        assert.deepStrictEqual(
          rows.map((row) => row.value_json),
          [table]
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer))
  );
});
