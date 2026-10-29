// `cairn.sqlite`: Cairn's own tables (the shell store, launches, attachments, the Executor grant,
// push) on one `node:sqlite` connection through Effect SQL. Opening it sets the pragmas, backs the
// file up when a migration is pending (so a bad migration never costs the inbox), and migrates.
// pi-durable's transcripts live in their own store, `brain.sqlite`, never here.

import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import type { SqlClient, SqlError } from "effect/sql";

/** The migrations `cairn.sqlite` runs, keyed `<NNNN>_<Name>` (`db/Migrations.ts` owns the list). */
export type MigrationRecord = Readonly<
  Record<string, Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>>
>;

/** Where the database lives and which migrations bring it up to date. */
export interface DatabaseOptions {
  /** The SQLite file, or `:memory:` for tests. */
  readonly filename: string;
  readonly migrations: MigrationRecord;
}

/** Opening, backing up or migrating `cairn.sqlite` failed; the brain cannot start without it. */
export class DatabaseOpenError extends Schema.TaggedError<DatabaseOpenError>()(
  "DatabaseOpenError",
  {
    message: Schema.String,
    operation: Schema.Literals(["open", "backup", "migrate"]),
    filename: Schema.String,
    cause: Schema.Defect(),
  }
) {}

const MIGRATIONS_TABLE = "effect_sql_migrations";

const decodeLatestMigration = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.NullOr(Schema.Int) }))
);

const migrationKey = /^(?<id>\d+)_/u;

const latestKnownMigration = (migrations: MigrationRecord) => {
  let latest = 0;

  for (const key of Object.keys(migrations)) {
    latest = Math.max(
      latest,
      Number(migrationKey.exec(key)?.groups?.id ?? "0")
    );
  }

  return latest;
};

const openError =
  (filename: string, operation: DatabaseOpenError["operation"]) =>
  (
    // Every failure on this path (SQL, schema, migration, file system) is an Error subclass.
    cause: Error
  ) =>
    new DatabaseOpenError({
      message: `Cairn's database ${filename} failed during ${operation}. Nothing after the failing step ran; check the file, its folder and the disk, then restart the brain.`,
      operation,
      filename,
      cause,
    });

/** The open `cairn.sqlite`: its file name and an online backup. */
export class Database extends Context.Service<
  Database,
  {
    /** The file the database was opened from (`:memory:` in tests). */
    readonly filename: string;
    /** Copies the live database to `destination` with SQLite's online backup. */
    backup(destination: string): Effect.Effect<void, DatabaseOpenError>;
  }
>()("cairn/server/db/Database") {
  /**
   * Opens and migrates the database, providing `Database`, `SqlClient` and `SqliteClient`. Needs
   * a file system for the backup directory.
   */
  static readonly layerNoDeps = (options: DatabaseOptions) =>
    Layer.effect(
      Database,
      Effect.gen(function* () {
        const sqlite = yield* SqliteClient.SqliteClient;
        const fileSystem = yield* FileSystem.FileSystem;
        const { filename, migrations } = options;

        const backup = Effect.fn("Database.backup")(
          function* (destination: string) {
            yield* fileSystem.makeDirectory(path.dirname(destination), {
              recursive: true,
            });
            yield* sqlite.backup(destination);
          },
          Effect.mapError(openError(filename, "backup"))
        );

        const applied = yield* Effect.gen(function* () {
          yield* sqlite`PRAGMA foreign_keys = ON`;
          yield* sqlite`PRAGMA synchronous = NORMAL`;

          // SQLite prepares a whole statement before running it, so the ledger's existence is
          // checked before the ledger is read.
          const ledger = yield* sqlite`
            SELECT 1 AS id FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
          `.pipe(Effect.flatMap(decodeLatestMigration));

          if (ledger.length === 0) {
            return Option.none();
          }

          const rows = yield* sqlite`
            SELECT MAX(migration_id) AS id FROM ${sqlite(MIGRATIONS_TABLE)}
          `.pipe(Effect.flatMap(decodeLatestMigration));

          return Option.fromNullishOr(rows[0]?.id);
        }).pipe(Effect.mapError(openError(filename, "open")));

        const target = latestKnownMigration(migrations);

        if (
          filename !== ":memory:" &&
          Option.isSome(applied) &&
          applied.value < target
        ) {
          const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(
            ":",
            "-"
          );

          const destination = path.join(
            path.dirname(filename),
            "backups",
            `cairn-${stamp}-before-${String(target).padStart(4, "0")}.sqlite`
          );

          yield* backup(destination);
          yield* Effect.logInfo("cairn.sqlite backed up before migrating", {
            destination,
            from: applied.value,
            to: target,
          });
        }

        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord(migrations),
          table: MIGRATIONS_TABLE,
        }).pipe(Effect.mapError(openError(filename, "migrate")));

        return Database.of({ filename, backup });
      })
    ).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: options.filename })),
      // SQLite creates the file but not its folder: a first boot on a fresh data directory makes it.
      Layer.provide(
        Layer.effectDiscard(
          options.filename === ":memory:"
            ? Effect.void
            : Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem;

                yield* fileSystem.makeDirectory(
                  path.dirname(options.filename),
                  {
                    recursive: true,
                  }
                );
              }).pipe(Effect.mapError(openError(options.filename, "open")))
        )
      )
    );

  /** `layerNoDeps` with Node's file system. */
  static readonly layer = (options: DatabaseOptions) =>
    Database.layerNoDeps(options).pipe(Layer.provide(NodeServices.layer));

  /** A fresh, migrated in-memory database. */
  static readonly layerTest = (migrations: MigrationRecord) =>
    Database.layer({ filename: ":memory:", migrations });
}
