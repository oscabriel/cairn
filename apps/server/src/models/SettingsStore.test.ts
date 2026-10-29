// Judges the server settings store on a migrated in-memory cairn.sqlite: defaults before anything
// is set, a patch changes only its present keys and survives a fresh read, and a stored value that
// no longer decodes reads as its default instead of failing every read. The role table is seeded
// once, keeps its built-ins, and refuses a table that drops one or binds a role to a role.

import type { RoleBinding } from "@cairn/protocol/Roles";
import { DEFAULT_ROLE_TABLE, RoleName } from "@cairn/protocol/Roles";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsCodecs,
  SettingsStore,
} from "./SettingsStore.ts";

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
        roleBindings: Option.none(),
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
        roleBindings: Option.none(),
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

  it.effect("seeds the role table once, so later defaults never move it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{
        readonly value_json: string;
      }>`SELECT value_json FROM settings WHERE key = 'roleBindings'`;

      assert.strictEqual(rows.length, 1);

      const seeded = yield* Schema.decodeEffect(
        ServerSettingsCodecs.roleBindings
      )(rows[0]?.value_json ?? "");

      assert.deepStrictEqual(seeded, DEFAULT_ROLE_TABLE);

      // A second store over the same database (the next boot) leaves an edited table alone.
      yield* sql`
        UPDATE settings SET value_json = ${rows[0]?.value_json.replace(
          "claude-sonnet-5-5",
          "claude-haiku-5-5"
        )} WHERE key = 'roleBindings'
      `;

      const again = yield* Layer.build(SettingsStore.layerNoDeps);
      const store = Context.get(again, SettingsStore);
      const scout = (yield* store.get).roleBindings[RoleName.make("@scout")];

      assert.strictEqual(scout?.model.modelId, "claude-haiku-5-5");
    }).pipe(Effect.scoped, Effect.provide(TestLayer))
  );

  it.effect(
    "reads a stored table missing a built-in role with its default",
    () =>
      Effect.gen(function* () {
        const store = yield* SettingsStore;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
        UPDATE settings SET value_json = '{}' WHERE key = 'roleBindings'
      `;

        assert.deepStrictEqual(
          (yield* store.get).roleBindings,
          DEFAULT_ROLE_TABLE
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "refuses a role table that drops a built-in or binds a role to a role",
    () =>
      Effect.gen(function* () {
        const store = yield* SettingsStore;

        const withoutJudge: Record<RoleName, RoleBinding> = {};

        for (const [role, binding] of Object.entries(DEFAULT_ROLE_TABLE)) {
          if (role !== "@judge") {
            withoutJudge[RoleName.make(role)] = binding;
          }
        }

        const aliased = {
          ...DEFAULT_ROLE_TABLE,
          [RoleName.make("@advisor")]: {
            model: { provider: "@judge", modelId: "x" },
            thinkingLevel: Option.none(),
            fallbacks: [],
            note: Option.none(),
          },
        };

        for (const table of [withoutJudge, aliased]) {
          const failure = yield* Effect.flip(
            store.update({
              autoSettleDays: Option.none(),
              titleModel: Option.none(),
              bridgeEnabled: Option.some(false),
              bridgeGenerationCap: Option.none(),
              roleBindings: Option.some(table),
              defaultBudget: Option.none(),
            })
          );

          assert.strictEqual(failure._tag, "SettingsInvalid");
        }

        assert.include(
          (yield* Effect.flip(
            store.update({
              autoSettleDays: Option.none(),
              titleModel: Option.none(),
              bridgeEnabled: Option.none(),
              bridgeGenerationCap: Option.none(),
              roleBindings: Option.some(aliased),
              defaultBudget: Option.none(),
            })
          )).message,
          "@advisor is bound to another role"
        );

        // Nothing changed: the refused patch's other key was not written either.
        const settings = yield* store.get;

        assert.isTrue(settings.bridgeEnabled);
        assert.deepStrictEqual(settings.roleBindings, DEFAULT_ROLE_TABLE);
      }).pipe(Effect.provide(TestLayer))
  );
});
