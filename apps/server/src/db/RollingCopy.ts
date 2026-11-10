// The daily rolling copy of a SQLite store (ADR 0016): `brain.sqlite` and `cairn.sqlite` each keep
// their newest three copies under `<dataDir>/backups`, named `<prefix><time>.sqlite`.
//
// Whether a copy is due is read from the files on disk, never from a timer that starts at boot: at
// boot and then every hour the newest copy's time (from its name) is compared with the clock, and a
// copy is made when it is a day old or there is none. So a brain restarted many times a day still
// copies once a day, and one that was down for a day copies as it comes up. A copy stamped after
// the clock (made while the clock ran ahead) counts as the oldest, so it never holds the next one
// back. Each copy is written to `<name>.part` by the store's own consistent copy (SQLite's online
// backup, never a file copy of the live file, folded into one self-contained file by the caller),
// then renamed, so a copy cut off midway is never counted.
//
// A second copy folder (`CAIRN_BACKUP_COPY_DIR`, off the NVMe, say a folder inside a NAS share)
// gets a file copy of each finished copy, owner-only (0600) since `cairn.sqlite` holds sign-in
// tokens, with the same retention. The brain never creates that folder, so an unmounted share's
// subfolder is a failure rather than copies landing on the local disk. Writing there is best
// effort and never holds the brain: every call that touches it is asynchronous and runs in its own
// fiber, so a share that hangs instead of failing ties up one of libuv's threads, never the event
// loop or the local copy. A file call cannot be cancelled, so a write that has not finished is left
// to finish while each later tick logs it at warning and starts none beside it; a failed write is
// logged at warning and tried again on the next tick.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { chmod, copyFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DateTime,
  Duration,
  Effect,
  FiberHandle,
  Option,
  Schedule,
  Schema,
} from "effect";

/** A step of a rolling copy failed; logged, and tried again on the next tick. */
export class RollingCopyError extends Schema.TaggedError<RollingCopyError>()(
  "RollingCopyError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "list",
      "fold",
      "rename",
      "prune",
      "second-folder",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** How old the newest copy may grow before the next one is due. */
export const COPY_EVERY = Duration.hours(24);

/** How often the files are looked at. */
export const COPY_TICK = Duration.hours(1);

/** Copies kept, in the backups folder and in the second copy folder alike. */
export const COPIES_KEPT = 3;

// A tick that lands a moment early (the previous one ran late) still copies, so the cadence stays a
// day instead of slipping a tick each time.
const DUE_AFTER = Duration.subtract(
  COPY_EVERY,
  Duration.divideUnsafe(COPY_TICK, 2)
);

const SUFFIX = ".sqlite";

const PART = ".part";

// Copies in the second folder hold what the stores hold, sign-in tokens included: owner-only.
const OWNER_ONLY = 0o600;

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

/**
 * The copies under `prefix` among `names`, newest first; other files are left out. A copy stamped
 * after `now` was made while the clock ran ahead, so it is really older than any made since: it
 * sorts last, where it is the first to be pruned and never counts as the newest.
 */
const copiesIn = (
  names: ReadonlyArray<string>,
  prefix: string,
  now: DateTime.Utc
): ReadonlyArray<Copy> => {
  const copies = names
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

  const ahead = copies.filter((copy) =>
    DateTime.isGreaterThan(copy.madeAt, now)
  );

  return [
    ...copies.filter((copy) => !DateTime.isGreaterThan(copy.madeAt, now)),
    ...ahead,
  ];
};

/** Whether a copy is due at `now`, given the copies newest first. */
const isDue = (copies: ReadonlyArray<Copy>, now: DateTime.Utc) =>
  Option.match(Option.fromNullishOr(copies[0]), {
    onNone: () => true,
    onSome: (copy) =>
      // A copy stamped after the clock sorts last, so the newest here is never ahead of `now`
      // unless it is the only kind there is; then no copy made under this clock exists yet.
      DateTime.isGreaterThan(copy.madeAt, now) ||
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
  readonly copyDir: Option.Option<string>;
  /**
   * Writes a consistent, self-contained copy of the live store to `target`, which does not exist
   * yet: SQLite's online backup, folded out of WAL mode (`foldIntoOneFile`). The rolling copy
   * does not fold it again.
   */
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

// The second copy folder may sit on a share that hangs, so every call there is asynchronous.
const secondFolderStep = <A>(file: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RollingCopyError({
        message: `The rolling copy's second-folder step failed at ${file}: ${String(cause)}`,
        operation: "second-folder",
        path: file,
        cause,
      }),
  });

/**
 * The copy inherits the store's WAL mode; this folds it into one self-contained file. A store's
 * `copy` calls it after its online backup.
 */
export const foldIntoOneFile = (file: string) =>
  syncStep("fold", file, () => {
    const copy = new DatabaseSync(file);

    copy.exec("PRAGMA journal_mode = DELETE");
    copy.close();
  });

/** The names in the backups folder, which is made first. */
const namesInBackups = (directory: string) =>
  syncStep("list", directory, () => {
    mkdirSync(directory, { recursive: true });

    return readdirSync(directory);
  });

/** Removes every copy under `prefix` in the backups folder past the newest `COPIES_KEPT`. */
const prune = (directory: string, prefix: string, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const copies = copiesIn(yield* namesInBackups(directory), prefix, now);

    for (const copy of copies.slice(COPIES_KEPT)) {
      const file = path.join(directory, copy.name);

      yield* syncStep("prune", file, () => {
        rmSync(file, { force: true });
      });
    }
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
    const names = yield* namesInBackups(options.directory);

    if (!isDue(copiesIn(names, options.prefix, now), now)) {
      return;
    }

    // Clears `.part` files a copy cut off midway left behind.
    for (const name of names) {
      if (name.startsWith(options.prefix) && name.endsWith(PART)) {
        const file = path.join(options.directory, name);

        yield* syncStep("prune", file, () => {
          rmSync(file, { force: true });
        });
      }
    }

    const target = path.join(
      options.directory,
      `${options.prefix}${stamp(now)}${SUFFIX}`
    );

    const part = `${target}${PART}`;

    yield* options.copy(part);
    yield* syncStep("rename", target, () => {
      renameSync(part, target);
    });
    yield* prune(options.directory, options.prefix, now);
    yield* Effect.logInfo("rolling copy made").pipe(
      Effect.annotateLogs({
        event: "rolling_copy",
        store: options.source,
        target,
      })
    );
  });

/**
 * Writes the newest copy into the second copy folder when it is not there yet, owner-only, then
 * prunes that folder. Every call there is asynchronous.
 */
const copyNewestToSecondFolder = (
  directory: string,
  prefix: string,
  copyDir: string
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const [newest] = copiesIn(yield* namesInBackups(directory), prefix, now);

    if (newest === undefined) {
      return;
    }

    const present = yield* secondFolderStep(
      copyDir,
      async () => await readdir(copyDir)
    );

    if (present.includes(newest.name)) {
      return;
    }

    for (const name of present) {
      if (name.startsWith(prefix) && name.endsWith(PART)) {
        const file = path.join(copyDir, name);

        yield* secondFolderStep(file, async () => {
          await rm(file, { force: true });
        });
      }
    }

    const target = path.join(copyDir, newest.name);
    const part = `${target}${PART}`;

    // The newest copy is a finished, closed file, so a plain file copy is sound here. The mode is
    // set before the rename, so the copy is never readable by others under its final name.
    yield* secondFolderStep(target, async () => {
      await copyFile(path.join(directory, newest.name), part);
      await chmod(part, OWNER_ONLY);
      await rename(part, target);
    });

    const kept = copiesIn([...present, newest.name], prefix, now);

    for (const copy of kept.slice(COPIES_KEPT)) {
      const file = path.join(copyDir, copy.name);

      yield* secondFolderStep(file, async () => {
        await rm(file, { force: true });
      });
    }

    yield* Effect.logInfo("rolling copy written to the second folder").pipe(
      Effect.annotateLogs({ event: "rolling_copy_second_folder", target })
    );
  });

/**
 * Starts the rolling copy for the life of the scope: a look at boot, then one every `COPY_TICK`.
 * Never fails; a failed step is logged and tried again on the next tick.
 */
export const startRollingCopy = Effect.fnUntraced(function* <
  E extends { readonly message: string },
>(options: RollingCopyOptions<E>) {
  // The second folder's write in flight, if any: it outlives the tick that started it.
  const writing = yield* FiberHandle.make();

  const tick = Effect.gen(function* () {
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

    if (Option.isNone(options.copyDir)) {
      return;
    }

    if (Option.isSome(yield* FiberHandle.get(writing))) {
      yield* Effect.logWarning(
        "rolling copy: the second folder's last write has not finished"
      ).pipe(
        Effect.annotateLogs({
          event: "rolling_copy_second_folder_busy",
          store: options.source,
          folder: options.copyDir.value,
        })
      );

      return;
    }

    yield* copyNewestToSecondFolder(
      options.directory,
      options.prefix,
      options.copyDir.value
    ).pipe(
      Effect.catchTag("RollingCopyError", (failure) =>
        Effect.logWarning("rolling copy not written to the second folder").pipe(
          Effect.annotateLogs({
            event: "rolling_copy_second_folder_failed",
            store: options.source,
            error: failure.message,
          })
        )
      ),
      FiberHandle.run(writing, { onlyIfMissing: true })
    );
  });

  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(COPY_TICK)),
    Effect.forkScoped
  );
});
