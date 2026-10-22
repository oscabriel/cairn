// The brain's pi-durable store: one SQLite file, `brain.sqlite`, for every thread (ADR 0016).
//
// pi-durable migrates its SQLite schema on open, one way (1.4.0 moved to schema 2 with no way back),
// so the store is copied before the first open under a new pi-durable version or schema. The
// sidecar `brain.meta.json` records the version and schema the store was last opened with; when
// either differs from what is installed, `backups/brain-<version>-<time>.sqlite` is written first
// with SQLite's online backup. A daily rolling copy (`brain-daily-<date>.sqlite`, newest three kept)
// guards against everything else.
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { Storage } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";

import { BrainConfig } from "./BrainConfig.ts";
import { errorText } from "./Durable.ts";

/** A file operation on the brain's store failed. */
export class BrainStoreError extends Schema.TaggedError<BrainStoreError>()(
  "BrainStoreError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "version",
      "sidecar",
      "backup",
      "open",
      "prune",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** What the store was last opened with. */
const Sidecar = Schema.Struct({
  piDurableVersion: Schema.String,
  sqliteSchemaVersion: Schema.Int,
});

type Sidecar = typeof Sidecar.Type;

const decodeSidecar = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Sidecar)
);

const PackageVersion = Schema.Struct({ version: Schema.String });

const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PackageVersion)
);

/** The store's file name inside the data directory. */
export const STORE_FILE = "brain.sqlite";

/** The sidecar's file name inside the data directory. */
export const SIDECAR_FILE = "brain.meta.json";

/** Pages copied per backup step: enough to copy a store in one step, so writes never restart it. */
const ONE_STEP_PAGES = 1_000_000_000;

/** Daily copies kept. */
const DAILY_KEPT = 3;

const DAILY_PREFIX = "brain-daily-";

const fail =
  (operation: BrainStoreError["operation"], file: string) => (cause: unknown) =>
    new BrainStoreError({
      message: `The brain store's ${operation} step failed at ${file}: ${errorText(cause)}`,
      operation,
      path: file,
      cause,
    });

/** The installed pi-durable version, read from its package.json beside its entry point. */
const installedVersion = Effect.gen(function* () {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-durable")
  );

  // dist/index.js -> package root
  const manifest = path.join(path.dirname(path.dirname(entry)), "package.json");

  const text = yield* Effect.tryPromise({
    try: async () => await readFile(manifest, "utf-8"),
    catch: fail("version", manifest),
  });

  const decoded = yield* decodePackageVersion(text).pipe(
    Effect.mapError(fail("version", manifest))
  );

  return decoded.version;
});

const exists = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      await stat(file);

      return true;
    },
    catch: fail("open", file),
  }).pipe(Effect.orElseSucceed(() => false));

/** A file-name-safe UTC timestamp. */
const stamp = (now: DateTime.Utc) =>
  DateTime.formatIso(now)
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z");

/** Copies the live store to `target` in one consistent step, safe while pi-durable writes. */
const copyStore = (source: string, target: string) =>
  Effect.gen(function* () {
    yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => new DatabaseSync(source, { readOnly: true }),
        catch: fail("backup", source),
      }),
      (database) =>
        Effect.tryPromise({
          try: async () =>
            await backup(database, target, { rate: ONE_STEP_PAGES }),
          catch: fail("backup", target),
        }),
      (database) =>
        Effect.sync(() => {
          database.close();
        })
    );

    // The copy inherits WAL mode; fold it into one self-contained file.
    yield* Effect.try({
      try: () => {
        const copy = new DatabaseSync(target);

        copy.exec("PRAGMA journal_mode = DELETE");
        copy.close();
      },
      catch: fail("backup", target),
    });
  });

/** The brain's store: where it is, how to open it, and its copies. */
export class BrainStore extends Context.Service<
  BrainStore,
  {
    readonly path: string;
    /** The version and schema found before this process opened the store; none for a new store. */
    readonly previous: Option.Option<Sidecar>;
    /** Opens pi-durable storage over the store. Each Harness (and each reopen) takes a fresh one. */
    readonly open: Effect.Effect<Storage, BrainStoreError>;
    /** Writes a consistent copy under `backups/` and returns its path. */
    backup(label: string): Effect.Effect<string, BrainStoreError>;
  }
>()("cairn/server/brain/BrainStore") {
  static readonly layerNoDeps = Layer.effect(
    BrainStore,
    Effect.gen(function* () {
      const { dataDir } = yield* BrainConfig;
      const storePath = path.join(dataDir, STORE_FILE);
      const sidecarPath = path.join(dataDir, SIDECAR_FILE);
      const backups = path.join(dataDir, "backups");

      yield* Effect.tryPromise({
        try: async () => await mkdir(backups, { recursive: true }),
        catch: fail("backup", backups),
      });

      const backupTo = Effect.fn("BrainStore.backup")(function* (
        label: string
      ) {
        const now = yield* DateTime.now;
        const target = path.join(backups, `${label}-${stamp(now)}.sqlite`);

        yield* copyStore(storePath, target);
        yield* Effect.logInfo("brain store copied").pipe(
          Effect.annotateLogs({ target })
        );

        return target;
      });

      const installed: Sidecar = {
        piDurableVersion: yield* installedVersion,
        sqliteSchemaVersion: CURRENT_SQLITE_SCHEMA_VERSION,
      };

      const previous = yield* Effect.tryPromise({
        try: async () => await readFile(sidecarPath, "utf-8"),
        catch: fail("sidecar", sidecarPath),
      }).pipe(
        Effect.flatMap((text) => decodeSidecar(text)),
        Effect.option
      );

      const storeExists = yield* exists(storePath);

      const changed = Option.match(previous, {
        onNone: () => true,
        onSome: (found) =>
          found.piDurableVersion !== installed.piDurableVersion ||
          found.sqliteSchemaVersion !== installed.sqliteSchemaVersion,
      });

      if (storeExists && changed) {
        const label = Option.match(previous, {
          onNone: () => "brain-unknown",
          onSome: (found) => `brain-${found.piDurableVersion}`,
        });

        yield* backupTo(label);
      }

      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(sidecarPath, `${JSON.stringify(installed)}\n`);
        },
        catch: fail("sidecar", sidecarPath),
      });

      const open = Effect.tryPromise({
        try: async () => await openNodeSqliteStorage(storePath),
        catch: fail("open", storePath),
      });

      // Keeps the newest DAILY_KEPT daily copies.
      const prune = Effect.gen(function* () {
        const names = yield* Effect.tryPromise({
          try: async () => await readdir(backups),
          catch: fail("prune", backups),
        });

        const dailies = names
          .filter(
            (name) => name.startsWith(DAILY_PREFIX) && name.endsWith(".sqlite")
          )
          .toSorted()
          .toReversed();

        yield* Effect.forEach(
          dailies.slice(DAILY_KEPT),
          (name) =>
            Effect.tryPromise({
              try: async () => {
                await rm(path.join(backups, name), { force: true });
              },
              catch: fail("prune", path.join(backups, name)),
            }),
          { discard: true }
        );
      });

      const daily = Effect.gen(function* () {
        if (yield* exists(storePath)) {
          const now = yield* Clock.currentTimeMillis;

          yield* backupTo(
            `${DAILY_PREFIX}${stamp(DateTime.makeUnsafe(now)).slice(0, 10)}`
          );
          yield* prune;
        }
      }).pipe(
        Effect.catchTag("BrainStoreError", (failure) =>
          Effect.logWarning("daily brain store copy failed").pipe(
            Effect.annotateLogs({ error: failure.message })
          )
        )
      );

      yield* daily.pipe(
        Effect.delay(Duration.hours(24)),
        Effect.repeat(Schedule.spaced(Duration.hours(24))),
        Effect.forkScoped
      );

      return BrainStore.of({
        path: storePath,
        previous,
        open,
        backup: backupTo,
      });
    })
  );

  static readonly layer = this.layerNoDeps;
}
