// The shared-storage merge: a save writes back an entry another tab's stale write dropped, but not
// one another tab removed, and a removal is remembered for a day. A tab that read before storage
// was cleared, or longer ago than a day, writes back nothing. Two builds with different shapes share
// the value without destroying each other's entries, and settle.

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Equivalence, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import {
  clearedSince,
  loadShared,
  mergeRecord,
  mergeStored,
  persistedRecord,
  REMOVAL_MEMORY_MS,
} from "./TabChanges.ts";
import type { LastRead } from "./TabChanges.ts";

const KEY = "cairn:test:v1";

const values = persistedRecord(Schema.String);

/** One tab's save of `mine`, as it last read or wrote `base` at `read`; what storage holds after. */
const saveAfter = (
  read: Option.Option<LastRead>,
  base: Readonly<Record<string, string>>,
  mine: Readonly<Record<string, string>>
) =>
  Effect.map(
    mergeStored(
      KEY,
      values,
      read,
      mergeRecord(Equivalence.strictEqual<string>())(base, mine)
    ),
    Option.map(({ value }) => value)
  );

/** `saveAfter` by a tab that read storage just now. */
const save = (
  base: Readonly<Record<string, string>>,
  mine: Readonly<Record<string, string>>
) =>
  Effect.flatMap(loadShared(KEY, values), ({ read }) =>
    saveAfter(read, base, mine)
  );

/** What storage holds now, read as a tab reads it. */
const stored = Effect.map(loadShared(KEY, values), ({ value }) => value);

describe("a save into shared storage", () => {
  it("writes back an entry storage lacks, but not one storage may have removed or one it holds unread", () => {
    const merge = mergeRecord(Equivalence.strictEqual<string>())(
      { a: "1", b: "2" },
      { a: "1", b: "2" }
    );

    expect(merge({ b: "2" }, (key) => key === "a", [])).toStrictEqual(
      Option.none()
    );
    expect(merge({ b: "2" }, () => false, ["a"])).toStrictEqual(Option.none());
    expect(
      Option.map(
        merge({ b: "2" }, () => false, []),
        ({ value }) => value
      )
    ).toStrictEqual(Option.some({ a: "1", b: "2" }));
  });

  it.effect(
    "remembers a removal for a day, and forgets it once the key is set again",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_760_000_000_000);
        yield* save({}, { a: "1", b: "2" });

        // Another tab removes `a`; a tab still holding it does not write it back.
        yield* save({ a: "1", b: "2" }, { b: "2" });

        const kept = yield* save({ a: "1", b: "2" }, { a: "1", b: "2" });

        // `a` is set again and removed by a stale write: the old removal no longer names it.
        yield* save({ b: "2" }, { a: "3", b: "2" });

        const store = yield* KeyValueStore.KeyValueStore;

        yield* store.set(KEY, '{"b":"2"}');

        const setAgain = yield* save({ a: "3", b: "2" }, { a: "3", b: "2" });

        // `b` is removed, and after a day the removal is forgotten: a tab that read since and still
        // holds it writes it back.
        yield* save({ a: "3", b: "2" }, { a: "3" });
        yield* TestClock.adjust(Duration.millis(REMOVAL_MEMORY_MS + 1000));

        const forgotten = yield* save({ a: "3", b: "2" }, { a: "3", b: "2" });

        expect({ kept, setAgain, forgotten }).toStrictEqual({
          kept: Option.some({ b: "2" }),
          setAgain: Option.some({ b: "2", a: "3" }),
          forgotten: Option.some({ a: "3", b: "2" }),
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "writes back nothing storage lacks once its read is older than a removal is remembered, but still writes its own changes",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_760_000_000_000);
        yield* save({}, { a: "1", b: "2" });

        const { read } = yield* loadShared(KEY, values);

        // Another tab removes `a`; this tab sleeps a day and a second, then changes `b`.
        yield* save({ a: "1", b: "2" }, { b: "2" });
        yield* TestClock.adjust(Duration.millis(REMOVAL_MEMORY_MS + 1000));

        const woke = yield* saveAfter(
          read,
          { a: "1", b: "2" },
          { a: "1", b: "3" }
        );

        expect({ woke, stored: yield* stored }).toStrictEqual({
          woke: Option.some({ b: "3" }),
          stored: { b: "3" },
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "writes back nothing storage lacks once storage was cleared since its read, even after another tab wrote again",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        yield* save({}, { a: "1" });

        const { read } = yield* loadShared(KEY, values);

        yield* store.clear;

        // This tab notices the clear: storage holds no generation.
        const first = yield* saveAfter(read, { a: "1" }, { a: "1" });

        // Another tab writes after the clear, which starts a new generation.
        yield* save({}, { b: "2" });

        const second = yield* saveAfter(read, { a: "1" }, { a: "1" });

        expect({ first, second, stored: yield* stored }).toStrictEqual({
          first: Option.some({}),
          second: Option.some({ b: "2" }),
          stored: { b: "2" },
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

/** A tab's read of generation `generation` at `at`. */
const readOf = (generation: string, at: number) =>
  Option.some<LastRead>({ generation, at });

describe("a save's answer", () => {
  it("tells a clear: a later read of another generation", () => {
    expect({
      cleared: clearedSince(readOf("a", 1), readOf("b", 2)),
      same: clearedSince(readOf("a", 1), readOf("a", 2)),
      older: clearedSince(readOf("b", 2), readOf("a", 1)),
      unread: clearedSince(Option.none(), readOf("b", 2)),
      failed: clearedSince(readOf("a", 1), Option.none()),
    }).toStrictEqual({
      cleared: true,
      same: false,
      older: false,
      unread: false,
      failed: false,
    });
  });
});

describe("a load of shared storage", () => {
  it.effect(
    "reads what storage holds when storage refuses to write the generation",
    () =>
      Effect.gen(function* () {
        const memory = yield* KeyValueStore.KeyValueStore;

        yield* memory.set(KEY, '{"a":"1"}');

        // Full: every write fails, so no generation can be minted.
        const full = KeyValueStore.make({
          get: memory.get,
          getUint8Array: memory.getUint8Array,
          set: (key) =>
            Effect.fail(
              new KeyValueStore.KeyValueStoreError({
                message: "full",
                method: "set",
                key,
              })
            ),
          remove: memory.remove,
          clear: memory.clear,
          size: memory.size,
          keys: memory.keys,
        });

        const loaded = yield* loadShared(KEY, values).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        expect(loaded).toStrictEqual({
          value: { a: "1" },
          unread: [],
          read: Option.none(),
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

/** An entry as one build saves it: a newer build knows one more `kind`. */
const entryOf = (kinds: ReadonlyArray<string>) =>
  Schema.Struct({ text: Schema.String, kind: Schema.Literals(kinds) });

type Entry = typeof Entry.Type;

const Entry = entryOf(["plain"]);

const sameText = Equivalence.mapInput(
  Equivalence.strictEqual<string>(),
  (entry: Entry) => entry.text
);

/**
 * A tab of a build whose entries have `kinds`, holding `held` and saving whenever it is told to. As
 * the drafts do (`rebaseDrafts`), it takes what storage holds after each save as its base and as
 * what it holds.
 */
const tabOf = (kinds: ReadonlyArray<string>, held: Record<string, Entry>) => {
  const persisted = persistedRecord(Schema.toCodecJson(entryOf(kinds)));
  let base: Record<string, Entry> = {};
  let read = Option.none<LastRead>();
  let mine = held;

  return {
    persisted,
    save: Effect.gen(function* () {
      const synced = yield* mergeStored(
        KEY,
        persisted,
        read,
        mergeRecord(sameText)(base, mine)
      );

      // Nothing changed during the save, so the tab now holds what storage holds.
      base = Option.match(synced, {
        onNone: () => base,
        onSome: ({ value }) => value,
      });
      read = Option.orElse(
        Option.map(synced, (answer) => answer.read),
        () => read
      );
      mine = base;
    }),
  };
};

describe("two builds in two tabs", () => {
  it.effect(
    "keep each other's entries, and stop writing once each holds what it can read",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        // The newer tab holds an entry the older build cannot decode.
        const newer = tabOf(["plain", "pinned"], {
          x: { text: "x", kind: "pinned" },
        });

        const older = tabOf(["plain"], { y: { text: "y", kind: "plain" } });

        let writes = 0;

        // Each write raises `storage` in the other tab, which saves again.
        for (let round = 0; round < 20; round += 1) {
          for (const tab of [newer, older]) {
            const before = yield* store.get(KEY);

            yield* tab.save;

            if ((yield* store.get(KEY)) !== before) {
              writes += 1;
            }
          }
        }

        const seen = (persisted: typeof newer.persisted) =>
          Effect.map(loadShared(KEY, persisted), ({ unread, value }) => ({
            value,
            unread,
          }));

        const seenByNewer = yield* seen(newer.persisted);
        const seenByOlder = yield* seen(older.persisted);

        expect({ writes, seenByNewer, seenByOlder }).toStrictEqual({
          writes: 2,
          seenByNewer: {
            value: {
              x: { text: "x", kind: "pinned" },
              y: { text: "y", kind: "plain" },
            },
            unread: [],
          },
          seenByOlder: {
            value: { y: { text: "y", kind: "plain" } },
            unread: ["x"],
          },
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});
