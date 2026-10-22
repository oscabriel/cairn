import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Database } from "./Database.ts";
import type { MigrationRecord } from "./Database.ts";
import { Shell0001 } from "./migrations/0001Shell.ts";

const shellOnly: MigrationRecord = { "0001_Shell": Shell0001 };

const withExtra: MigrationRecord = {
  ...shellOnly,
  "0002_Extra": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE extra (id INTEGER PRIMARY KEY)`;
  }),
};

const decodeNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String }))
);

const decodeIntegrity = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ integrity_check: Schema.String }))
);

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return (yield* decodeNames(
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  )).map((row) => row.name);
});

describe(Database, () => {
  it.live("migrates a new file, and backs it up before a later migration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const filename = path.join(directory, "cairn.sqlite");

      const first = yield* tableNames.pipe(
        Effect.provide(Database.layer({ filename, migrations: shellOnly }))
      );

      assert.includeMembers(first, [
        "command_receipts",
        "projects",
        "settings",
        "shell_events",
        "threads",
      ]);
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "backups")));

      const second = yield* tableNames.pipe(
        Effect.provide(Database.layer({ filename, migrations: withExtra }))
      );

      assert.include(second, "extra");

      const backups = yield* fileSystem.readDirectory(
        path.join(directory, "backups")
      );

      assert.strictEqual(backups.length, 1);
      assert.match(backups[0] ?? "", /^cairn-.*-before-0002\.sqlite$/u);

      const integrity = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* decodeIntegrity(yield* sql`PRAGMA integrity_check`);
      }).pipe(
        Effect.provide(
          Database.layer({
            filename: path.join(directory, "backups", backups[0] ?? ""),
            migrations: shellOnly,
          })
        )
      );

      assert.deepStrictEqual(integrity, [{ integrity_check: "ok" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
