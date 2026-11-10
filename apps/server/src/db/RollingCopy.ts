// The daily rolling copy of a SQLite store (ADR 0016): `brain.sqlite` and `cairn.sqlite` each keep
// their newest three copies under `<dataDir>/backups`, named `<prefix><time>.sqlite`.
//
// Whether a copy is due is read from the files on disk, never from a timer that starts at boot: at
// boot and then every hour the newest copy's time (from its name) is compared with the clock, and a
// copy is made when it is a day old or there is none. So a brain restarted many times a day still
// copies once a day, and one that was down for a day copies as it comes up. Each copy is written to
// `<name>.part` by the store's own consistent copy (SQLite's online backup, never a file copy of the
// live file), folded into one self-contained file, then renamed, so a copy cut off midway is never
// counted.
//
// A mirror folder (`CAIRN_BACKUP_MIRROR`, off the NVMe) gets a file copy of each finished copy, with
// the same retention. The brain never creates that folder, so a share that is not mounted is a
// failure rather than copies landing on the local disk under its mount point. Writing there is best
// effort: a failure is logged at warning and retried on the next tick, and never fails the brain.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DateTime, Duration, Effect, Option, Schedule, Schema } from "effect";

/** A step of a rolling copy failed; logged, and tried again on the next tick. */
export class RollingCopyError extends Schema.TaggedError<RollingCopyError>()(
  "RollingCopyError",
  {
    message: Schema.String,
    operation: Schema.Literals(["list", "fold", "rename", "prune", "mirror"]),
    path: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** How old the newest copy may grow before the next one is due. */
export const COPY_EVERY = Duration.hours(24);

/** How often the files are looked at. */
export const COPY_TICK = Duration.hours(1);

/** Copies kept, in the backups folder and in the mirror alike. */
export const COPIES_KEPT = 3;

// A tick that lands a moment early (the previous one ran late) still copies, so the cadence stays a
// day instead of slipping a tick each time.
const DUE_AFTER = Duration.subtract(
  COPY_EVERY,
  Duration.divideUnsafe(COPY_TICK, 2)
);

const SUFFIX = ".sqlite";

const PART = ".part";

// The time at the end of a copy's name: `2026-11-09T05-01-10Z.sqlite`. Copies made before the
// rolling copy moved here carried the date twice (`brain-daily-<date>-<time>.sqlite`); the end
// still reads.
const stampAtEnd =
  /(?<date>\d{4}-\d{2}-\d{2})T(?<hours>\d{2})-(?<minutes>\d{2})-(?<seconds>\d{2})Z\.sqlite$/u;

/** A file-name-safe UTC timestamp, to the second. */
const stamp = (now: DateTime.Utc) =>
  DateTime.formatIso(now)
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z");

/** One copy on disk. */
interface Copy {
  readonly name: string;
  readonly madeAt: DateTime.Utc;
}

/** The copies under `prefix` among `names`, newest first; other files are left out. */
const copiesIn = (
  names: ReadonlyArray<string>,
  prefix: string
): ReadonlyArray<Copy> =>
  names
    .flatMap((name): ReadonlyArray<Copy> => {
      if (!name.startsWith(prefix) || !name.endsWith(SUFFIX)) {
        return [];
      }

      const groups = stampAtEnd.exec(name)?.groups;

      if (groups === undefined) {
        return [];
      }

      return Option.match(
        DateTime.make(
          `${groups.date ?? ""}T${groups.hours ?? ""}:${groups.minutes ?? ""}:${groups.seconds ?? ""}Z`
        ),
        {
          onNone: () => [],
          onSome: (madeAt) => [{ name, madeAt: DateTime.toUtc(madeAt) }],
        }
      );
    })
    .toSorted((a, b) => DateTime.Order(b.madeAt, a.madeAt));

/** Whether a copy is due at `now`, given the newest one. */
const isDue = (newest: Option.Option<Copy>, now: DateTime.Utc) =>
  Option.match(newest, {
    onNone: () => true,
    onSome: (copy) =>
      Duration.isGreaterThanOrEqualTo(
        Duration.millis(
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(copy.madeAt)
        ),
        DUE_AFTER
      ),
  });

/** What to copy, where to, and how. */
export interface RollingCopyOptions<E extends { readonly message: string }> {
  /** The live store, for the log lines and to skip a store not made yet. */
  readonly source: string;
  /** The copies' name prefix: `brain-daily-`, `cairn-daily-`. */
  readonly prefix: string;
  /** The folder the copies live in, beside the store. */
  readonly directory: string;
  /** A second folder each copy is also written to, off the NVMe. */
  readonly mirror: Option.Option<string>;
  /** Writes a consistent copy of the live store to `target`, which does not exist yet. */
  copy(target: string): Effect.Effect<void, E>;
}

const syncStep = <A>(
  operation: RollingCopyError["operation"],
  file: string,
  run: () => A
) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new RollingCopyError({
        message: `The rolling copy's ${operation} step failed at ${file}: ${String(cause)}`,
        operation,
        path: file,
        cause,
      }),
  });

/** The names in `directory`, made first when `make` (the backups folder, never the mirror). */
const namesIn = (directory: string, make: boolean) =>
  syncStep("list", directory, () => {
    if (make) {
      mkdirSync(directory, { recursive: true });
    }

    return readdirSync(directory);
  });

/** Removes every copy under `prefix` in `directory` past the newest `COPIES_KEPT`. */
const prune = (directory: string, prefix: string) =>
  Effect.gen(function* () {
    const copies = copiesIn(yield* namesIn(directory, false), prefix);

    for (const copy of copies.slice(COPIES_KEPT)) {
      const file = path.join(directory, copy.name);

      yield* syncStep("prune", file, () => {
        rmSync(file, { force: true });
      });
    }
  });

/** Clears `.part` files a copy cut off midway left behind. */
const clearParts = (
  directory: string,
  prefix: string,
  names: ReadonlyArray<string>
) =>
  Effect.forEach(
    names.filter((name) => name.startsWith(prefix) && name.endsWith(PART)),
    (name) =>
      syncStep("prune", path.join(directory, name), () => {
        rmSync(path.join(directory, name), { force: true });
      }),
    { discard: true }
  );

/** The copy inherits the store's WAL mode; fold it into one self-contained file. */
const fold = (file: string) =>
  syncStep("fold", file, () => {
    const copy = new DatabaseSync(file);

    copy.exec("PRAGMA journal_mode = DELETE");
    copy.close();
  });

/** Makes a copy when one is due. */
const copyWhenDue = <E extends { readonly message: string }>(
  options: RollingCopyOptions<E>
) =>
  Effect.gen(function* () {
    const present = yield* syncStep("list", options.source, () =>
      existsSync(options.source)
    );

    if (!present) {
      return;
    }

    const now = yield* DateTime.now;
    const names = yield* namesIn(options.directory, true);
    const newest = Option.fromNullishOr(copiesIn(names, options.prefix)[0]);

    if (!isDue(newest, now)) {
      return;
    }

    yield* clearParts(options.directory, options.prefix, names);

    const target = path.join(
      options.directory,
      `${options.prefix}${stamp(now)}${SUFFIX}`
    );

    const part = `${target}${PART}`;

    yield* options.copy(part);
    yield* fold(part);
    yield* syncStep("rename", target, () => {
      renameSync(part, target);
    });
    yield* prune(options.directory, options.prefix);
    yield* Effect.logInfo("rolling copy made").pipe(
      Effect.annotateLogs({
        event: "rolling_copy",
        store: options.source,
        target,
      })
    );
  });

/** Writes the newest copy into `mirror` when it is not there yet, then prunes the mirror. */
const mirrorNewest = (directory: string, prefix: string, mirror: string) =>
  Effect.gen(function* () {
    const [newest] = copiesIn(yield* namesIn(directory, true), prefix);

    if (newest === undefined) {
      return;
    }

    const mirrored = yield* namesIn(mirror, false);

    if (mirrored.includes(newest.name)) {
      return;
    }

    yield* clearParts(mirror, prefix, mirrored);

    const target = path.join(mirror, newest.name);
    const part = `${target}${PART}`;

    // The newest copy is a finished, closed file, so a plain file copy is sound here.
    yield* Effect.tryPromise({
      try: async () => {
        await copyFile(path.join(directory, newest.name), part);
        await rename(part, target);
      },
      catch: (cause) =>
        new RollingCopyError({
          message: `The rolling copy's mirror step failed at ${target}: ${String(cause)}`,
          operation: "mirror",
          path: target,
          cause,
        }),
    });
    yield* prune(mirror, prefix);
    yield* Effect.logInfo("rolling copy mirrored").pipe(
      Effect.annotateLogs({ event: "rolling_copy_mirrored", target })
    );
  });

/**
 * One look at the files: a copy when one is due, then the mirror brought up to date. Failures are
 * logged at warning; the next tick tries again.
 */
const tick = <E extends { readonly message: string }>(
  options: RollingCopyOptions<E>
) =>
  Effect.gen(function* () {
    yield* copyWhenDue(options).pipe(
      Effect.catch((error) =>
        Effect.logWarning("rolling copy failed").pipe(
          Effect.annotateLogs({
            event: "rolling_copy_failed",
            store: options.source,
            error: error.message,
          })
        )
      )
    );

    if (Option.isSome(options.mirror)) {
      yield* mirrorNewest(
        options.directory,
        options.prefix,
        options.mirror.value
      ).pipe(
        Effect.catchTag("RollingCopyError", (failure) =>
          Effect.logWarning("rolling copy not mirrored").pipe(
            Effect.annotateLogs({
              event: "rolling_copy_mirror_failed",
              store: options.source,
              error: failure.message,
            })
          )
        )
      );
    }
  });

/**
 * Starts the rolling copy for the life of the scope: a look at boot, then one every `COPY_TICK`.
 * Never fails; a failed step is logged and tried again on the next tick.
 */
export const startRollingCopy = <E extends { readonly message: string }>(
  options: RollingCopyOptions<E>
) =>
  tick(options).pipe(
    Effect.repeat(Schedule.spaced(COPY_TICK)),
    Effect.forkScoped,
    Effect.asVoid
  );
