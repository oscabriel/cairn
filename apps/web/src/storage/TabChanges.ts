// What one tab changed in a value every tab of this browser shares in localStorage (the drafts, the
// saved attachments, the outbox). Tabs never write their whole copy: each remembers the value as it
// last read or wrote it (its base), and a save writes only what the tab changed since then, merged
// into what storage holds now. A `storage` event says another tab wrote; the tab then saves again,
// which folds the other tab's writes into its own copy. Without this, the last tab to save drops
// every draft or queued send another tab made.
//
// Reading, merging and writing is not atomic across tabs, so a tab can write from a read that missed
// another tab's newest entry, and storage then lacks an entry nobody removed. So a removal is written
// down: a save records each key it removes, with the time, beside the value (`<key>:removed`), and
// forgets the record once the key is set again or a day has passed. An entry a tab holds that storage
// lacks is removed from the tab only when such a record names it; otherwise the tab's save writes
// it back.

import type { Equivalence, Stream } from "effect";
import { Array, Clock, Effect, Option, Record, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { streamFromEventFilterMap } from "foldkit/dom";

/** Entries one tab set or removed in a shared record, relative to its base. */
export interface RecordChanges<A> {
  readonly set: Readonly<Record<string, A>>;
  readonly removed: ReadonlyArray<string>;
}

/** What `mine` changed against `base`: entries added or changed, and keys removed. */
export const recordChanges =
  <A>(equivalence: Equivalence.Equivalence<A>) =>
  (
    base: Readonly<Record<string, A>>,
    mine: Readonly<Record<string, A>>
  ): RecordChanges<A> => ({
    set: Record.filter(mine, (value, key) =>
      Option.match(Record.get(base, key), {
        onNone: () => true,
        onSome: (was) => !equivalence(was, value),
      })
    ),
    removed: Array.filter(Record.keys(base), (key) => !Record.has(mine, key)),
  });

/** True when there is nothing to write. */
export const isEmptyRecordChanges = <A>(changes: RecordChanges<A>): boolean =>
  Record.isEmptyRecord(changes.set) && changes.removed.length === 0;

/** `target` with `changes` applied on top: this tab's entries win where both wrote. */
export const applyRecordChanges = <A>(
  target: Readonly<Record<string, A>>,
  changes: RecordChanges<A>
): Record<string, A> => ({
  ...Record.filter(target, (_value, key) => !changes.removed.includes(key)),
  ...changes.set,
});

/** Items one tab added to or removed from a shared list of items that never change. */
export interface ListChanges<A> {
  readonly added: ReadonlyArray<A>;
  readonly removed: ReadonlyArray<string>;
}

/** What `mine` changed against `base`, items compared by `keyOf`. */
export const listChanges =
  <A>(keyOf: (item: A) => string) =>
  (base: ReadonlyArray<A>, mine: ReadonlyArray<A>): ListChanges<A> => {
    const baseKeys = new Set(base.map(keyOf));
    const mineKeys = new Set(mine.map(keyOf));

    return {
      added: Array.filter(mine, (item) => !baseKeys.has(keyOf(item))),
      removed: Array.filter([...baseKeys], (key) => !mineKeys.has(key)),
    };
  };

/** True when there is nothing to write. */
export const isEmptyListChanges = <A>(changes: ListChanges<A>): boolean =>
  changes.added.length === 0 && changes.removed.length === 0;

/** `target` without the removed items, and the added ones after it in their order. */
export const applyListChanges =
  <A>(keyOf: (item: A) => string) =>
  (target: ReadonlyArray<A>, changes: ListChanges<A>): ReadonlyArray<A> => {
    const removed = new Set(changes.removed);
    const kept = Array.filter(target, (item) => !removed.has(keyOf(item)));
    const present = new Set(kept.map(keyOf));

    return [
      ...kept,
      ...Array.filter(changes.added, (item) => !present.has(keyOf(item))),
    ];
  };

/** When each key was removed from a shared value, in epoch milliseconds, by entry key. */
export type Removals = Readonly<Record<string, number>>;

/** How long a removal is remembered: a tab asleep longer may write a removed entry back. */
export const REMOVAL_MEMORY_MS = 24 * 60 * 60 * 1000;

/** The localStorage key the removals from the value at `key` are kept under. */
export const removalsKey = (key: string): string => `${key}:removed`;

const RemovalsJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Finite)
);

const decodeRemovals = Schema.decodeEffect(RemovalsJson);

const encodeRemovals = Schema.encodeEffect(RemovalsJson);

/** The removals from the value at `key` made within the last day; none stored or unreadable is none. */
const loadRemovals = (key: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const saved = yield* store.get(removalsKey(key));
    const now = yield* Clock.currentTimeMillis;

    const removals: Removals = yield* Option.match(
      Option.fromUndefinedOr(saved),
      {
        onNone: () => Effect.succeed({}),
        onSome: decodeRemovals,
      }
    );

    return Record.filter(removals, (at) => now - at < REMOVAL_MEMORY_MS);
  }).pipe(Effect.orElseSucceed((): Removals => ({})));

/** A merged value to write, and the keys it set and removed, which update the removals. */
export interface Merged<A> {
  readonly value: A;
  readonly set: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/**
 * The merge of a save of `mine` (base `base`) into a stored record: this tab's changes, plus every
 * entry it holds that storage lacks and no removal names, so a write from a stale read is undone.
 * None when there is nothing to write.
 */
export const mergeRecord =
  <A>(equivalence: Equivalence.Equivalence<A>) =>
  (base: Readonly<Record<string, A>>, mine: Readonly<Record<string, A>>) =>
  (
    stored: Readonly<Record<string, A>>,
    removals: Removals
  ): Option.Option<Merged<Record<string, A>>> => {
    const changes = recordChanges(equivalence)(base, mine);

    const lost = Record.filter(
      mine,
      (_value, key) => !Record.has(stored, key) && !Record.has(removals, key)
    );

    const set = { ...lost, ...changes.set };

    return isEmptyRecordChanges({ set, removed: changes.removed })
      ? Option.none()
      : Option.some({
          value: applyRecordChanges(stored, { set, removed: changes.removed }),
          set: Record.keys(set),
          removed: changes.removed,
        });
  };

/** `mergeRecord` for a list of items that never change, compared by `keyOf`. */
export const mergeList =
  <A>(keyOf: (item: A) => string) =>
  (base: ReadonlyArray<A>, mine: ReadonlyArray<A>) =>
  (
    stored: ReadonlyArray<A>,
    removals: Removals
  ): Option.Option<Merged<ReadonlyArray<A>>> => {
    const changes = listChanges(keyOf)(base, mine);
    const storedKeys = new Set(stored.map(keyOf));
    const addedKeys = new Set(changes.added.map(keyOf));

    const lost = Array.filter(mine, (item) => {
      const key = keyOf(item);

      return (
        !storedKeys.has(key) &&
        !addedKeys.has(key) &&
        !Record.has(removals, key)
      );
    });

    const added = [...lost, ...changes.added];

    return isEmptyListChanges({ added, removed: changes.removed })
      ? Option.none()
      : Option.some({
          value: applyListChanges(keyOf)(stored, {
            added,
            removed: changes.removed,
          }),
          set: added.map(keyOf),
          removed: changes.removed,
        });
  };

/**
 * Writes one tab's changes into what storage holds at `key` now: `read` the stored value, `merge`
 * this tab's changes into it with the removals other tabs recorded (none when there is nothing to
 * write, so no other tab is woken), record this save's removals, and `write` the result. Answers
 * what storage holds afterwards, which the tab takes as its new base, or none when storage refused.
 */
export const mergeStored = <A, E, R>(
  key: string,
  read: Effect.Effect<A, never, R>,
  merge: (stored: A, removals: Removals) => Option.Option<Merged<A>>,
  write: (next: A) => Effect.Effect<void, E, R>
): Effect.Effect<Option.Option<A>, never, R | KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const stored = yield* read;
    const removals = yield* loadRemovals(key);

    return yield* Option.match(merge(stored, removals), {
      onNone: () => Effect.succeed(stored),
      onSome: (merged) =>
        Effect.gen(function* () {
          const store = yield* KeyValueStore.KeyValueStore;
          const now = yield* Clock.currentTimeMillis;

          const next: Record<string, number> = {
            ...Record.filter(
              removals,
              (_at, removedKey) => !merged.set.includes(removedKey)
            ),
            ...Record.fromIterableWith(merged.removed, (removedKey) => [
              removedKey,
              now,
            ]),
          };

          // Removals first: a tab that reads the new value must find why an entry left it.
          yield* store.set(removalsKey(key), yield* encodeRemovals(next));
          yield* write(merged.value);

          return merged.value;
        }),
    });
  }).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none())
  );

/**
 * `message` each time another tab writes `key` (or clears storage). The browser raises `storage`
 * only in the other tabs, never in the one that wrote.
 */
export const storageChanges = <A>(key: string, message: A): Stream.Stream<A> =>
  streamFromEventFilterMap({
    target: window,
    type: "storage",
    filterMapEvent: (event) =>
      event.key === key || event.key === null
        ? Option.some(message)
        : Option.none(),
  });
