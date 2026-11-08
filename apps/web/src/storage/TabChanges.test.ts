// The shared-storage merge: a save writes back an entry another tab's stale write dropped, but not
// one another tab removed, and a removal is remembered for a day.

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Equivalence, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import { mergeRecord, mergeStored, REMOVAL_MEMORY_MS } from "./TabChanges.ts";

const KEY = "cairn:test:v1";

const ValuesJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.String)
);

const load = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const saved = yield* store.get(KEY);

  return yield* Option.match(Option.fromUndefinedOr(saved), {
    onNone: () => Effect.succeed({}),
    onSome: Schema.decodeEffect(ValuesJson),
  });
}).pipe(Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})));

/** One tab's save of `mine`, as it last read or wrote `base`. */
const save = (
  base: Readonly<Record<string, string>>,
  mine: Readonly<Record<string, string>>
) =>
  mergeStored(
    KEY,
    load,
    mergeRecord(Equivalence.strictEqual<string>())(base, mine),
    (next) =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        yield* store.set(KEY, yield* Schema.encodeEffect(ValuesJson)(next));
      })
  );

describe("a save into shared storage", () => {
  it("writes back an entry storage lacks, but not one a removal names", () => {
    const merge = mergeRecord(Equivalence.strictEqual<string>())(
      { a: "1", b: "2" },
      { a: "1", b: "2" }
    );

    expect(merge({ b: "2" }, { a: 1 })).toStrictEqual(Option.none());
    expect(
      Option.map(merge({ b: "2" }, {}), ({ value }) => value)
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
