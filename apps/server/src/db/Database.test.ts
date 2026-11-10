// Judges `cairn.sqlite`'s open: migrations, the backup before a pending migration, a first boot's
// missing folder, and the daily rolling copy (through SQLite's online backup, with a second copy
// folder that gets each copy owner-only and whose failure never stops the brain).

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  References,
  Schema,
} from "effect";
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

/** `cairn.sqlite` at `filename` with its rolling copy, also written to `copyDir`. */
const withRollingCopy = (filename: string, copyDir: Option.Option<string>) =>
  Database.layerRollingCopy(copyDir).pipe(
    Layer.provideMerge(Database.layer({ filename, migrations: shellOnly }))
  );

/** Waits, in real time, up to two seconds for `folder` to hold a daily copy; answers its names. */
const dailyCopiesIn = (folder: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const names = (yield* fileSystem.exists(folder))
        ? (yield* fileSystem.readDirectory(folder)).filter((name) =>
            /^cairn-daily-.+Z\.sqlite$/u.test(name)
          )
        : [];

      if (names.length > 0) {
        return names;
      }

      yield* Effect.sleep("10 millis");
    }

    return [];
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

  it.live("makes a missing data folder on a first boot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const filename = path.join(directory, "fresh", "data", "cairn.sqlite");

      const tables = yield* tableNames.pipe(
        Effect.provide(Database.layer({ filename, migrations: shellOnly }))
      );

      assert.include(tables, "threads");
      assert.isTrue(yield* fileSystem.exists(filename));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "copies cairn.sqlite at boot through the online backup, into the second folder too, owner-only",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filename = path.join(directory, "data", "cairn.sqlite");
        const secondFolder = path.join(directory, "nas", "cairn-copies");

        // The user makes the second copy folder; the brain never does.
        yield* fileSystem.makeDirectory(secondFolder, { recursive: true });

        const [copies, copiedOut] = yield* Effect.gen(function* () {
          return [
            yield* dailyCopiesIn(path.join(directory, "data", "backups")),
            yield* dailyCopiesIn(secondFolder),
          ] as const;
        }).pipe(
          Effect.provide(withRollingCopy(filename, Option.some(secondFolder)))
        );

        assert.strictEqual(copies.length, 1, "one copy at the first boot");
        assert.deepStrictEqual(
          copiedOut,
          copies,
          "the second folder holds the same copy"
        );

        const info = yield* fileSystem.stat(
          path.join(secondFolder, copiedOut[0] ?? "")
        );

        assert.strictEqual(
          info.mode.toString(8).slice(-3),
          "600",
          "the copy holds sign-in tokens, so only the owner may read it"
        );

        for (const file of [
          path.join(directory, "data", "backups", copies[0] ?? ""),
          path.join(secondFolder, copiedOut[0] ?? ""),
        ]) {
          const copy = new DatabaseSync(file, { readOnly: true });
          const integrity = copy.prepare("PRAGMA integrity_check").get();
          const mode = copy.prepare("PRAGMA journal_mode").get();

          const tables = copy
            .prepare(
              "SELECT count(*) AS n FROM sqlite_master WHERE name = 'threads'"
            )
            .get();

          copy.close();
          assert.deepStrictEqual(integrity, { integrity_check: "ok" });
          assert.deepStrictEqual(mode, { journal_mode: "delete" });
          assert.deepStrictEqual(tables, { n: 1 });
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live(
    "a second folder that cannot be written is logged and stops nothing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filename = path.join(directory, "cairn.sqlite");
        // A file where the second folder's parent should be, like a share that is not mounted: every
        // write there fails, and nothing is made in its place.
        const blocked = path.join(directory, "not-a-folder");
        const events: Array<unknown> = [];

        const capture = Logger.make((options) => {
          events.push(
            options.fiber.getRef(References.CurrentLogAnnotations).event
          );
        });

        yield* fileSystem.writeFileString(blocked, "");

        const [copies, tables] = yield* Effect.gen(function* () {
          const made = yield* dailyCopiesIn(path.join(directory, "backups"));

          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (events.includes("rolling_copy_second_folder_failed")) {
              break;
            }

            yield* Effect.sleep("10 millis");
          }

          return [made, yield* tableNames] as const;
        }).pipe(
          Effect.provide(
            withRollingCopy(
              filename,
              Option.some(path.join(blocked, "cairn-copies"))
            ).pipe(
              Layer.provide(
                Logger.layer([capture], { mergeWithExisting: true })
              )
            )
          )
        );

        assert.strictEqual(
          copies.length,
          1,
          "the copy beside the store is made"
        );
        assert.include(tables, "threads", "the database still answers");
        assert.include(events, "rolling_copy_second_folder_failed");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("an in-memory database has no rolling copy", () =>
    Effect.gen(function* () {
      const tables = yield* tableNames.pipe(
        Effect.provide(
          Database.layerRollingCopy(Option.none()).pipe(
            Layer.provideMerge(Database.layerTest(shellOnly))
          )
        )
      );

      assert.include(tables, "threads");
    })
  );
});
