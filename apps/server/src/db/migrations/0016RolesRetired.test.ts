// Migration 0016 (ADR 0052): the role table a brain seeded into `settings` before ADR 0043 is
// deleted, every other setting stays, and running the migration again changes nothing.

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { Database } from "../Database.ts";
import { Shell0001 } from "./0001Shell.ts";
import { RolesRetired0016 } from "./0016RolesRetired.ts";

/** The settings rows, by key. */
const settingsRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<{
    readonly key: string;
    readonly value_json: string;
  }>`SELECT key, value_json FROM settings ORDER BY key`;
});

describe("migration 0016", () => {
  it.effect(
    "deletes the role table's settings row, keeps the rest, and is safe to run twice",
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
        });

        yield* sql`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES ('roleBindings', ${table}, 0), ('autoSettleDays', '5', 0)
        `;

        yield* RolesRetired0016;

        const once = yield* settingsRows;

        yield* RolesRetired0016;

        assert.deepStrictEqual(once, [
          { key: "autoSettleDays", value_json: "5" },
        ]);
        assert.deepStrictEqual(yield* settingsRows, once);
      }).pipe(Effect.provide(Database.layerTest({ "0001_Shell": Shell0001 })))
  );
});
