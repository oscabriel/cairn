// The shared-storage merge: a save writes back an entry another tab's stale write dropped, but not
// one another tab removed, and a removal is remembered for a day. Two builds with different shapes
// share the value without destroying each other's entries, and settle.

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Equivalence, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import {
  loadShared,
  mergeRecord,
  mergeStored,
  persistedRecord,
  REMOVAL_MEMORY_MS,
} from "./TabChanges.ts";

const KEY = "cairn:test:v1";

const values = persistedRecord(Schema.String);

/** One tab's save of `mine`, as it last read or wrote `base`. */
const save = (
  base: Readonly<Record<string, string>>,
  mine: Readonly<Record<string, string>>
) =>
  mergeStored(
    KEY,
    values,
    mergeRecord(Equivalence.strictEqual<string>())(base, mine)
  );

describe("a save into shared storage", () => {
  it("writes back an entry storage lacks, but not one a removal names or one it holds unread", () => {
    const merge = mergeRecord(Equivalence.strictEqual<string>())(
      { a: "1", b: "2" },
      { a: "1", b: "2" }
    );

    expect(merge({ b: "2" }, { a: 1 }, [])).toStrictEqual(Option.none());
    expect(merge({ b: "2" }, {}, ["a"])).toStrictEqual(Option.none());
    expect(
      Option.map(merge({ b: "2" }, {}, []), ({ value }) => value)
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

        // `b` is removed, and after a day a tab still holding it writes it back.
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
  let mine = held;

  return {
    persisted,
    save: Effect.gen(function* () {
      const stored = yield* mergeStored(
        KEY,
        persisted,
        mergeRecord(sameText)(base, mine)
      );

      // Nothing changed during the save, so the tab now holds what storage holds.
      base = Option.getOrElse(stored, () => base);
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

        const seenByNewer = yield* loadShared(KEY, newer.persisted);
        const seenByOlder = yield* loadShared(KEY, older.persisted);

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
