// Judges the server settings store on a migrated in-memory cairn.sqlite: defaults before anything
// is set, a patch changes only its present keys and survives a fresh read, and a stored value that
// no longer decodes reads as its default instead of failing every read.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
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
});
