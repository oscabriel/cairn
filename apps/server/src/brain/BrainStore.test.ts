// Judges the brain store's guard against pi-durable's one-way migrations: a store last opened by
// another pi-durable version is copied before this one opens it, the copy is a sound SQLite file
// holding the old data, and an unchanged version copies nothing. Then the daily rolling copy's
// cadence on the `TestClock`: a copy at the first boot and one a day after, three kept, and a
// restart that finds a fresh copy on disk waits for it to age while one that finds a stale copy
// copies at once.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { BrainConfig } from "./BrainConfig.ts";
import { BrainStore, SIDECAR_FILE } from "./BrainStore.ts";

const decodeSidecar = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ piDurableVersion: Schema.String }))
);

const storeIn = (dataDir: string) =>
  BrainStore.layer.pipe(Layer.provide(BrainConfig.layerFrom(dataDir)));

/** Opens the store, writes one conversation through pi-durable and closes it. */
const seed = (dataDir: string) =>
  Effect.gen(function* () {
    const store = yield* BrainStore;
    const storage = yield* store.open;

    yield* Effect.promise(async () => {
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT
      );

      await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT
      );
      await harness.close(BACKGROUND_CONTEXT);
    });
  }).pipe(Effect.provide(storeIn(dataDir)));

/** The copies made before a version change; the daily rolling copies are left out. */
const backups = (dataDir: string) =>
  readdirSync(path.join(dataDir, "backups"))
    .filter((name) => !name.startsWith("brain-daily-"))
    .toSorted();

/** The daily rolling copies, oldest first. */
const dailies = (dataDir: string) =>
  readdirSync(path.join(dataDir, "backups"))
    .filter((name) => name.startsWith("brain-daily-"))
    .toSorted();

/** A daily copy's name for a moment `hours` after `start`. */
const dailyAt = (start: DateTime.Utc, hours: number) =>
  `brain-daily-${DateTime.formatIso(
    DateTime.addDuration(start, Duration.hours(hours))
  )
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/u, "Z")}.sqlite`;

/** A data folder holding a small SQLite store and a sidecar for the installed pi-durable. */
const storeWithoutCopies = () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-store-daily-"));
  const store = new DatabaseSync(path.join(dataDir, "brain.sqlite"));

  store.exec("CREATE TABLE seed (n INTEGER); INSERT INTO seed VALUES (1);");
  store.close();
  mkdirSync(path.join(dataDir, "backups"));

  return dataDir;
};

/**
 * Waits, in real time, for the daily copies to be `expected`: a copy is a real SQLite backup, which
 * the `TestClock` does not wait for. Answers what is there when they match or after two seconds.
 */
const dailiesBecome = (dataDir: string, expected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = dailies(dataDir);

      if (found.join("\n") === expected.join("\n")) {
        // One more beat, so the tick that wrote them has pruned and gone back to sleep.
        yield* TestClock.withLive(Effect.sleep("20 millis"));

        return dailies(dataDir);
      }

      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }

    return dailies(dataDir);
  });

/** Moves the clock on `hours` an hour at a time, each tick settling before the next. */
const passHours = (hours: number) =>
  Effect.gen(function* () {
    for (let hour = 0; hour < hours; hour += 1) {
      yield* TestClock.adjust("1 hour");
    }
  });

describe("brain store", () => {
  it.live("copies the store before a new pi-durable version opens it", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-store-"));

      yield* seed(dataDir);
      assert.deepStrictEqual(
        backups(dataDir),
        [],
        "a new store has nothing to copy"
      );

      // As if the store was last opened by pi-durable 1.3.0 on schema 1.
      writeFileSync(
        path.join(dataDir, SIDECAR_FILE),
        JSON.stringify({ piDurableVersion: "1.3.0", sqliteSchemaVersion: 1 })
      );

      const previous = yield* BrainStore.useSync(
        (store) => store.previous
      ).pipe(Effect.provide(storeIn(dataDir)));

      assert.deepStrictEqual(
        Option.map(previous, (found) => found.piDurableVersion),
        Option.some("1.3.0")
      );

      const copies = backups(dataDir);

      assert.strictEqual(copies.length, 1);
      assert.match(copies[0] ?? "", /^brain-1\.3\.0-.+\.sqlite$/u);

      const copy = new DatabaseSync(
        path.join(dataDir, "backups", copies[0] ?? ""),
        {
          readOnly: true,
        }
      );

      try {
        const integrity = copy.prepare("PRAGMA integrity_check").get();

        const tables = copy
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'"
          )
          .get();

        assert.deepStrictEqual(integrity, { integrity_check: "ok" });
        assert.isAbove(Number(tables?.n ?? 0), 0);
      } finally {
        copy.close();
      }

      // The sidecar now names the installed version, so the next open copies nothing.
      const sidecar = decodeSidecar(
        readFileSync(path.join(dataDir, SIDECAR_FILE), "utf-8")
      );

      assert.notStrictEqual(sidecar.piDurableVersion, "1.3.0");

      yield* Effect.void.pipe(Effect.provide(storeIn(dataDir)));
      assert.strictEqual(backups(dataDir).length, 1);
    })
  );

  it.effect(
    "makes a daily copy at the first boot and then once a day, keeping three",
    () =>
      Effect.gen(function* () {
        const dataDir = storeWithoutCopies();
        const start = yield* DateTime.now;

        yield* Effect.gen(function* () {
          assert.deepStrictEqual(
            yield* dailiesBecome(dataDir, [dailyAt(start, 0)]),
            [dailyAt(start, 0)],
            "a store with no daily copy is copied as the brain boots"
          );

          yield* passHours(23);
          assert.deepStrictEqual(
            yield* dailiesBecome(dataDir, [dailyAt(start, 0)]),
            [dailyAt(start, 0)],
            "nothing more before the copy is a day old"
          );

          for (const day of [1, 2, 3, 4, 5]) {
            yield* passHours(day === 1 ? 1 : 24);

            const expected = [day - 2, day - 1, day].flatMap((at) =>
              at >= 0 ? [dailyAt(start, at * 24)] : []
            );

            assert.deepStrictEqual(
              yield* dailiesBecome(dataDir, expected),
              expected,
              `one copy a day, the newest three kept (day ${String(day)})`
            );
          }
        }).pipe(Effect.provide(storeIn(dataDir)));
      })
  );

  it.effect(
    "a restart that finds a copy under a day old waits for it to age",
    () =>
      Effect.gen(function* () {
        const dataDir = storeWithoutCopies();

        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T12:00:00Z"))
        );

        const start = yield* DateTime.now;
        // A copy from before the rolling copy moved to `db/RollingCopy.ts`, and a fresh one.
        const older = "brain-daily-2026-11-08-2026-11-08T05-01-10Z.sqlite";
        const fresh = dailyAt(start, -2);

        writeFileSync(path.join(dataDir, "backups", older), "");
        writeFileSync(path.join(dataDir, "backups", fresh), "");

        yield* Effect.gen(function* () {
          yield* TestClock.withLive(Effect.sleep("100 millis"));
          assert.deepStrictEqual(
            dailies(dataDir),
            [older, fresh],
            "no copy at boot: the newest is two hours old"
          );

          yield* passHours(21);
          assert.deepStrictEqual(
            yield* dailiesBecome(dataDir, [older, fresh]),
            [older, fresh],
            "none while the newest is under a day old"
          );

          yield* passHours(1);

          const expected = [older, fresh, dailyAt(start, 22)];

          assert.deepStrictEqual(
            yield* dailiesBecome(dataDir, expected),
            expected,
            "a copy as the newest turns a day old"
          );
        }).pipe(Effect.provide(storeIn(dataDir)));
      })
  );

  it.effect("a restart that finds a copy over a day old copies at once", () =>
    Effect.gen(function* () {
      const dataDir = storeWithoutCopies();

      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T12:00:00Z"))
      );

      const start = yield* DateTime.now;
      const stale = dailyAt(start, -25);

      writeFileSync(path.join(dataDir, "backups", stale), "");

      yield* Effect.gen(function* () {
        const expected = [stale, dailyAt(start, 0)];

        assert.deepStrictEqual(
          yield* dailiesBecome(dataDir, expected),
          expected,
          "the newest copy is 25 hours old, so the boot copies"
        );

        const copy = new DatabaseSync(
          path.join(dataDir, "backups", dailyAt(start, 0)),
          { readOnly: true }
        );

        const seeded = copy.prepare("SELECT n FROM seed").get();
        const mode = copy.prepare("PRAGMA journal_mode").get();

        copy.close();
        assert.deepStrictEqual(seeded, { n: 1 });
        assert.deepStrictEqual(mode, { journal_mode: "delete" });
      }).pipe(Effect.provide(storeIn(dataDir)));
    })
  );
});
