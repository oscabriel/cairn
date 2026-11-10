// Judges the rolling copy's own edges on the `TestClock`: a second copy folder that hangs instead of
// failing (as a NAS share that stopped answering does) holds neither the event loop nor the local
// daily copy, and a copy stamped ahead of the clock never holds the next one back.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Logger, Option, References } from "effect";
import { TestClock } from "effect/testing";

import { startRollingCopy } from "./RollingCopy.ts";

const PREFIX = "store-daily-";

/** A copy's name for a moment `hours` after `start`. */
const copyAt = (start: DateTime.Utc, hours: number) =>
  `${PREFIX}${DateTime.formatIso(
    DateTime.addDuration(start, Duration.hours(hours))
  )
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z")}.sqlite`;

/** A data folder with a store and an empty backups folder. */
const dataFolder = () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-rolling-copy-"));

  writeFileSync(path.join(dataDir, "store.sqlite"), "live");
  mkdirSync(path.join(dataDir, "backups"));

  return dataDir;
};

/** The finished copies in `folder`, oldest first. */
const copiesIn = (folder: string) =>
  readdirSync(folder)
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(".sqlite"))
    .toSorted();

/** Waits, in real time, up to two seconds for `check` to hold; answers whether it did. */
const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (check()) {
        return true;
      }

      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }

    return check();
  });

/** Moves the clock on `hours` an hour at a time, each tick settling before the next. */
const passHours = (hours: number) =>
  Effect.gen(function* () {
    for (let hour = 0; hour < hours; hour += 1) {
      yield* TestClock.adjust("1 hour");
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
  });

/** The rolling copy of `<dataDir>/store.sqlite`, whose copy writes a plain file. */
const rollingCopyOf = (dataDir: string, copyDir: Option.Option<string>) =>
  startRollingCopy({
    source: path.join(dataDir, "store.sqlite"),
    prefix: PREFIX,
    directory: path.join(dataDir, "backups"),
    copyDir,
    copy: (target) =>
      Effect.sync(() => {
        writeFileSync(target, "copy");
      }),
  });

describe("rolling copy", () => {
  it.effect(
    "a second folder that hangs holds neither the event loop nor the local daily copy",
    () =>
      Effect.gen(function* () {
        const dataDir = dataFolder();
        const secondFolder = path.join(dataDir, "nas");
        const events: Array<unknown> = [];

        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T12:00:00Z"))
        );

        const start = yield* DateTime.now;
        // The newest copy is a FIFO with no writer: copying it into the second folder blocks in the
        // file call, as a hard-mounted share that stopped answering does.
        const hanging = path.join(dataDir, "backups", copyAt(start, -1));

        mkdirSync(secondFolder);
        execFileSync("mkfifo", [hanging]);

        // Lets the blocked copy finish once the test is over, so no thread stays stuck: on Linux a
        // FIFO opened read-write never blocks and counts as its writer (fifo(7)).
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closeSync(openSync(hanging, "r+"));
          })
        );

        const capture = Logger.make((options) => {
          events.push(
            options.fiber.getRef(References.CurrentLogAnnotations).event
          );
        });

        yield* rollingCopyOf(dataDir, Option.some(secondFolder)).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: true }))
        );

        yield* TestClock.withLive(Effect.sleep("100 millis"));
        yield* passHours(1);

        assert.isTrue(
          yield* eventually(() =>
            events.includes("rolling_copy_second_folder_busy")
          ),
          "the next tick runs, finds the write still blocked, and says so"
        );

        yield* passHours(22);

        assert.isTrue(
          yield* eventually(() =>
            copiesIn(path.join(dataDir, "backups")).includes(copyAt(start, 23))
          ),
          "the local copy is made as the newest turns a day old"
        );
        assert.deepStrictEqual(
          copiesIn(secondFolder),
          [],
          "nothing finished in the blocked second folder"
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "a copy stamped ahead of the clock does not hold the next back",
    () =>
      Effect.gen(function* () {
        const dataDir = dataFolder();
        const backups = path.join(dataDir, "backups");

        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T12:00:00Z"))
        );

        const start = yield* DateTime.now;
        // Made at a boot whose clock ran ahead, before time sync set it back.
        const ahead = `${PREFIX}2027-01-01T00-00-00Z.sqlite`;

        writeFileSync(path.join(backups, ahead), "copy");

        yield* rollingCopyOf(dataDir, Option.none());

        assert.isTrue(
          yield* eventually(() => copiesIn(backups).includes(copyAt(start, 0))),
          "the boot copies at once"
        );

        yield* passHours(1);
        assert.deepStrictEqual(
          copiesIn(backups),
          [copyAt(start, 0), ahead],
          "and not again an hour later"
        );

        yield* passHours(47);

        const expected = [
          copyAt(start, 0),
          copyAt(start, 24),
          copyAt(start, 48),
        ];

        assert.isTrue(
          yield* eventually(
            () => copiesIn(backups).join("\n") === expected.join("\n")
          ),
          `three copies a day apart, the one ahead of the clock pruned first: ${copiesIn(backups).join(", ")}`
        );
      }).pipe(Effect.scoped)
  );
});
