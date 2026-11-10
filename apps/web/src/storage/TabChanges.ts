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
//
// That holds only while the records can name every removal since the tab's read. A tab whose last
// read is older than a record lives (asleep for a day), or that read before storage was cleared
// (site data cleared in another tab, or in the browser's settings), cannot prove an entry storage
// lacks is still live, so its save writes only what it changed since that read, and the entries
// storage lacks leave the tab. A clear is told by the value's generation (`<key>:generation`): an
// id a tab mints when it finds none, which a clear removes, so a tab that finds none, or another
// id than it read, knows storage was cleared since.
//
// Two builds can share storage (a tab not yet reloaded after a deploy), so a value is read entry by
// entry: an entry this build cannot decode is not shown, but storage still holds it, so it is never
// taken for lost, and a save patches the stored value (sets and removes this tab's entries only),
// writing every other entry back exactly as stored. A value unreadable as a whole (not JSON, or
// another outer shape) is never written over: the tab reads and writes its copy under the value's
// recovery key (`<key>:recovery`) instead. A tab of this build that sets an entry under the key of
// one it cannot decode replaces it (a draft written in the same thread): its key is all it knows.
//
// The page says once that storage holds what it cannot show (`readShared`): what it told about is
// written down (`<key>:told`), so an entry no build can read again does not raise the notice on
// every load, and only an entry not told about yet raises it again.

import type { Equivalence, Stream } from "effect";
import { Array, Clock, Effect, Option, Random, Record, Schema } from "effect";
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

/**
 * How long a removal is remembered. A tab whose last read is older cannot tell what was removed
 * since, so its save writes back no entry storage lacks (`mergeStored`).
 */
export const REMOVAL_MEMORY_MS = 24 * 60 * 60 * 1000;

/** The localStorage key the removals from the value at `key` are kept under. */
export const removalsKey = (key: string): string => `${key}:removed`;

/**
 * The localStorage key a tab keeps its copy of the value at `key` under while the value there is
 * unreadable as a whole, so the unreadable value is never written over.
 */
export const recoveryKey = (key: string): string => `${key}:recovery`;

/**
 * The localStorage key of the generation of the value at `key`: an id minted when a tab finds none,
 * so a clear of storage, which removes it, starts a new one.
 */
export const generationKey = (key: string): string => `${key}:generation`;

/** When a tab last read a shared value, and the generation storage held then. */
export const LastRead = Schema.Struct({
  generation: Schema.String,
  /** Epoch milliseconds. */
  at: Schema.Finite,
});

export type LastRead = typeof LastRead.Type;

/** The later of two reads: answers can land out of order, and an older read must not win. */
export const laterRead = (
  read: Option.Option<LastRead>,
  other: Option.Option<LastRead>
): Option.Option<LastRead> =>
  Option.exists(other, (last) =>
    Option.match(read, {
      onNone: () => true,
      onSome: (answer) => last.at > answer.at,
    })
  )
    ? other
    : read;

/**
 * Whether storage may have removed the entry at a key since a tab's read: a removal names it, or
 * the tab cannot tell (`mergeStored`).
 */
export type Removed = (key: string) => boolean;

/** The generation of the value at `key`, minting and writing one when storage holds none. */
const currentGeneration = (key: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const held = yield* store.get(generationKey(key));

    if (held !== undefined) {
      return held;
    }

    const now = yield* Clock.currentTimeMillis;
    const random = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER);
    const minted = `${now.toString(36)}-${random.toString(36)}`;

    yield* store.set(generationKey(key), minted);

    return minted;
  });

/** What a tab knows of storage now: the generation it holds, read at the current time. */
const readNow = (key: string) =>
  Effect.gen(function* () {
    const generation = yield* currentGeneration(key);
    const at = yield* Clock.currentTimeMillis;

    return { generation, at } satisfies LastRead;
  });

// The removals' shape. A change an older build cannot decode needs a new key (`<key>:removed2`):
// a build that cannot read the removals reads them as none, and its next save writes over them.
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
 * entry it holds that storage lacks and storage cannot have removed (`removed`), so a write from a
 * stale read is undone. `held` names the entries storage holds that this build cannot decode: they
 * are not lost. None when there is nothing to write.
 */
export const mergeRecord =
  <A>(equivalence: Equivalence.Equivalence<A>) =>
  (base: Readonly<Record<string, A>>, mine: Readonly<Record<string, A>>) =>
  (
    stored: Readonly<Record<string, A>>,
    removed: Removed,
    held: ReadonlyArray<string>
  ): Option.Option<Merged<Record<string, A>>> => {
    const changes = recordChanges(equivalence)(base, mine);

    const lost = Record.filter(
      mine,
      (_value, key) =>
        !Record.has(stored, key) && !held.includes(key) && !removed(key)
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
    removed: Removed,
    held: ReadonlyArray<string>
  ): Option.Option<Merged<ReadonlyArray<A>>> => {
    const changes = listChanges(keyOf)(base, mine);
    const storedKeys = new Set([...stored.map(keyOf), ...held]);
    const addedKeys = new Set(changes.added.map(keyOf));

    const lost = Array.filter(mine, (item) => {
      const key = keyOf(item);

      return !storedKeys.has(key) && !addedKeys.has(key) && !removed(key);
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

/** A stored value as this build reads it. */
export interface Readable<A, Raw> {
  /** The entries this build decodes. */
  readonly value: A;
  /** The value as stored, which a save patches, so entries this build cannot decode stay as stored. */
  readonly raw: Raw;
  /** The keys of stored entries this build cannot decode but can still name: present, so not lost. */
  readonly held: ReadonlyArray<string>;
  /** One id per stored entry this build cannot decode (`unreadId`), which the page tells about once. */
  readonly unread: ReadonlyArray<string>;
}

/** The id of a stored entry this build cannot decode: its key, or its JSON when it has none. */
export const unreadId = (
  key: Option.Option<string>,
  json: Schema.Json
): string => Option.getOrElse(key, () => `#${JSON.stringify(json)}`);

/** How one shared value is kept as text: read entry by entry, and written as a patch. */
export interface Persisted<A, Raw, R, E> {
  /** The value when nothing is stored. */
  readonly empty: Readable<A, Raw>;
  /** True when `raw` holds no entry, read or not. */
  readonly isEmpty: (raw: Raw) => boolean;
  /** Reads stored text; none when the text is unreadable as a whole. */
  readonly read: (
    text: string
  ) => Effect.Effect<Option.Option<Readable<A, Raw>>, never, R>;
  /**
   * The text of `raw` with the entries `merged` set (taken from its value) and removed, and every
   * other entry as stored.
   */
  readonly write: (raw: Raw, merged: Merged<A>) => Effect.Effect<string, E, R>;
}

/** Where a shared value was read: the key it lives under now, and what it holds. */
interface Found<A, Raw> {
  readonly at: string;
  readonly readable: Readable<A, Raw>;
}

/**
 * Reads the value at `key`, or, when that value is unreadable as a whole, the tab's copy at its
 * recovery key. None when both are unreadable. Fails when storage itself refuses.
 */
const findStored = Effect.fnUntraced(function* <A, Raw, R, E>(
  key: string,
  persisted: Persisted<A, Raw, R, E>
) {
  const store = yield* KeyValueStore.KeyValueStore;

  const readAt = (at: string) =>
    Effect.flatMap(store.get(at), (text) =>
      Option.match(Option.fromUndefinedOr(text), {
        onNone: () => Effect.succeedSome(persisted.empty),
        onSome: persisted.read,
      })
    );

  const atKey = yield* readAt(key);

  if (Option.isSome(atKey)) {
    return Option.some<Found<A, Raw>>({ at: key, readable: atKey.value });
  }

  const atRecovery = yield* readAt(recoveryKey(key));

  return Option.map(atRecovery, (readable): Found<A, Raw> => ({
    at: recoveryKey(key),
    readable,
  }));
});

/** The unread id of a value at a key that is unreadable as a whole, its entries uncounted. */
const UNREADABLE_VALUE = "*unreadable";

/** The unread id of a copy at the recovery key once the value at the key reads again. */
const LEFT_RECOVERY = "*recovery";

/** What a page loads of a shared value. */
export interface Stored<A> {
  /** The entries this build decodes. */
  readonly value: A;
  /** The ids of what storage holds that this build cannot show, kept as stored. */
  readonly unread: ReadonlyArray<string>;
  /** This read, which the tab's next save names (`mergeStored`); none when storage refused. */
  readonly read: Option.Option<LastRead>;
}

/**
 * Whether the recovery key of `key` holds a copy: once the value at the key reads again, nothing
 * reads that copy, so the page must say it is there.
 */
const recoveryLeft = Effect.fnUntraced(function* <A, Raw, R, E>(
  key: string,
  persisted: Persisted<A, Raw, R, E>
) {
  const store = yield* KeyValueStore.KeyValueStore;
  const text = yield* store.get(recoveryKey(key));

  return yield* Option.match(Option.fromUndefinedOr(text), {
    onNone: () => Effect.succeed(false),
    onSome: (copy) =>
      Effect.map(
        persisted.read(copy),
        (readable) =>
          !Option.exists(readable, ({ raw }) => persisted.isEmpty(raw))
      ),
  });
});

/**
 * Reads the shared value at `key` entry by entry, minting its generation when storage holds none. A
 * missing value, or storage refusing, is the empty value: the page must start. A value unreadable as
 * a whole stays where it is, and the tab's copy at the recovery key is read instead.
 */
export const loadShared = <A, Raw, R, E>(
  key: string,
  persisted: Persisted<A, Raw, R, E>
): Effect.Effect<Stored<A>, never, R | KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    // Read first: a value written after the read is newer than it, never missed by it. Storage that
    // reads but refuses the generation's write (full) still loads, as a tab that never read.
    const read = yield* Effect.option(readNow(key));
    const found = yield* findStored(key, persisted);

    if (Option.isNone(found)) {
      return {
        value: persisted.empty.value,
        unread: [UNREADABLE_VALUE],
        read,
      };
    }

    const { at, readable } = found.value;

    if (at !== key) {
      return {
        value: readable.value,
        unread: [UNREADABLE_VALUE, ...readable.unread],
        read,
      };
    }

    const left = yield* recoveryLeft(key, persisted);

    return {
      value: readable.value,
      unread: left ? [...readable.unread, LEFT_RECOVERY] : readable.unread,
      read,
    };
  }).pipe(
    Effect.orElseSucceed((): Stored<A> => ({
      value: persisted.empty.value,
      unread: [],
      read: Option.none(),
    }))
  );

/** The localStorage key the ids of the unread entries the page last told about are kept under. */
const toldKey = (key: string): string => `${key}:told`;

// The told ids' shape. A change an older build cannot decode needs a new key (`<key>:told2`): a
// build that cannot read them reads them as none, tells once more, and writes over them.
const ToldJson = Schema.fromJsonString(Schema.Array(Schema.String));

const decodeTold = Schema.decodeEffect(ToldJson);

const encodeTold = Schema.encodeEffect(ToldJson);

/**
 * Whether the page should tell the user about `unread` (the unread ids at `key`): true when one of
 * them was not told about at the last load. Writes the ids down as told, and forgets those no longer
 * stored. Storage refusing tells.
 */
const tellOnce = (key: string, unread: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const saved = yield* store.get(toldKey(key));

    const told: ReadonlyArray<string> = yield* Option.match(
      Option.fromUndefinedOr(saved),
      {
        onNone: () => Effect.succeed([]),
        onSome: (text) =>
          decodeTold(text).pipe(
            Effect.orElseSucceed((): ReadonlyArray<string> => [])
          ),
      }
    );

    const ids = Array.dedupe(unread);
    const tell = ids.some((id) => !told.includes(id));

    if (tell || told.length !== ids.length) {
      yield* ids.length === 0
        ? store.remove(toldKey(key))
        : store.set(toldKey(key), yield* encodeTold(ids));
    }

    return tell;
  }).pipe(Effect.orElseSucceed(() => unread.length > 0));

/** What a page loads of a shared value, and whether it tells the user storage holds more. */
export interface Loaded<A> {
  /** The entries this build decodes. */
  readonly value: A;
  /** Storage holds entries this build cannot show, kept as stored, that no load has told about. */
  readonly tell: boolean;
  /** This read, which the tab's next save names (`mergeStored`); none when storage refused. */
  readonly read: Option.Option<LastRead>;
}

/**
 * `loadShared`, and whether the page should say storage holds entries it cannot show: once for each
 * such entry (`tellOnce`), so one no build can read does not raise the notice on every load.
 */
export const readShared = <A, Raw, R, E>(
  key: string,
  persisted: Persisted<A, Raw, R, E>
): Effect.Effect<Loaded<A>, never, R | KeyValueStore.KeyValueStore> =>
  Effect.flatMap(loadShared(key, persisted), ({ read, unread, value }) =>
    Effect.map(tellOnce(key, unread), (tell) => ({ value, tell, read }))
  );

/** What storage holds after a save, and the save's read of it, which the tab's next save names. */
export interface Synced<A> {
  readonly value: A;
  readonly read: LastRead;
}

/**
 * Writes one tab's changes into what storage holds at `key` now: read the stored value, `merge`
 * this tab's changes into it (none when there is nothing to write, so no other tab is woken),
 * record this save's removals, and write the stored value patched with the merge. Answers what
 * storage holds afterwards (the entries this build decodes), which the tab takes as its new base,
 * or none when storage refused or nothing there could be read.
 *
 * `read` is the tab's last read of the value (none before its first). The merge may write back an
 * entry storage lacks only when the removals other tabs recorded name every removal since that
 * read: storage holds the generation the tab read, and the read is younger than a removal is
 * remembered. Otherwise storage may have removed any entry it lacks, so none is written back.
 */
export const mergeStored = <A, Raw, R, E>(
  key: string,
  persisted: Persisted<A, Raw, R, E>,
  read: Option.Option<LastRead>,
  merge: (
    stored: A,
    removed: Removed,
    held: ReadonlyArray<string>
  ) => Option.Option<Merged<A>>
): Effect.Effect<
  Option.Option<Synced<A>>,
  never,
  R | KeyValueStore.KeyValueStore
> =>
  Effect.gen(function* () {
    const now = yield* readNow(key);
    const found = yield* findStored(key, persisted);

    if (Option.isNone(found)) {
      return Option.none<Synced<A>>();
    }

    const { at, readable } = found.value;
    const removals = yield* loadRemovals(at);

    const complete = Option.exists(
      read,
      (last) =>
        last.generation === now.generation &&
        now.at - last.at < REMOVAL_MEMORY_MS
    );

    const merged = merge(
      readable.value,
      complete ? (entry) => Record.has(removals, entry) : () => true,
      readable.held
    );

    if (Option.isNone(merged)) {
      return Option.some({ value: readable.value, read: now });
    }

    const store = yield* KeyValueStore.KeyValueStore;
    const text = yield* persisted.write(readable.raw, merged.value);

    const next: Record<string, number> = {
      ...Record.filter(
        removals,
        (_at, removedKey) => !merged.value.set.includes(removedKey)
      ),
      ...Record.fromIterableWith(merged.value.removed, (removedKey) => [
        removedKey,
        now.at,
      ]),
    };

    // Removals first: a tab that reads the new value must find why an entry left it.
    yield* store.set(removalsKey(at), yield* encodeRemovals(next));
    yield* store.set(at, text);

    return Option.some({ value: merged.value.value, read: now });
  }).pipe(Effect.orElseSucceed(() => Option.none<Synced<A>>()));

const RecordDocument = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Json)
);

const decodeRecordDocument = Schema.decodeOption(RecordDocument);

const encodeRecordDocument = Schema.encodeEffect(RecordDocument);

/** A record of entries kept as one JSON object, each entry read with `entry` on its own. */
export const persistedRecord = <A>(
  entry: Schema.Codec<A, Schema.Json>
): Persisted<
  Record<string, A>,
  Readonly<Record<string, Schema.Json>>,
  never,
  Schema.SchemaError
> => {
  const decodeEntry = Schema.decodeOption(entry);
  const encodeEntry = Schema.encodeEffect(entry);

  return {
    empty: { value: {}, raw: {}, held: [], unread: [] },
    isEmpty: Record.isEmptyRecord,
    read: (text) =>
      Effect.succeed(
        Option.map(decodeRecordDocument(text), (raw) => {
          const decoded = Record.map(raw, (json) => decodeEntry(json));
          const held = Record.keys(Record.filter(decoded, Option.isNone));

          return {
            value: Record.getSomes(decoded),
            raw,
            held,
            unread: held,
          };
        })
      ),
    write: (raw, merged) =>
      Effect.gen(function* () {
        const set = yield* Effect.forEach(
          Record.toEntries(
            Record.filter(merged.value, (_value, key) =>
              merged.set.includes(key)
            )
          ),
          ([key, value]) =>
            Effect.map(encodeEntry(value), (json) => [key, json] as const)
        );

        return yield* encodeRecordDocument({
          ...Record.filter(raw, (_json, key) => !merged.removed.includes(key)),
          ...Record.fromEntries(set),
        });
      }),
  };
};

const ListDocument = Schema.fromJsonString(Schema.Array(Schema.Json));

const decodeListDocument = Schema.decodeOption(ListDocument);

const encodeListDocument = Schema.encodeEffect(ListDocument);

/**
 * A list of items kept as one JSON array, each item read with `item` on its own. `unreadKey` names
 * an item this build cannot decode when its key is still where this build looks for it, so a tab
 * of this build can remove it.
 */
export const persistedList = <A>(
  item: Schema.Codec<A, Schema.Json>,
  keyOf: (item: A) => string,
  unreadKey: (json: Schema.Json) => Option.Option<string>
): Persisted<
  ReadonlyArray<A>,
  ReadonlyArray<Schema.Json>,
  never,
  Schema.SchemaError
> => {
  const decodeItem = Schema.decodeOption(item);
  const encodeItem = Schema.encodeEffect(item);

  const keyOfJson = (json: Schema.Json): Option.Option<string> =>
    Option.match(decodeItem(json), {
      onNone: () => unreadKey(json),
      onSome: (decoded) => Option.some(keyOf(decoded)),
    });

  return {
    empty: { value: [], raw: [], held: [], unread: [] },
    isEmpty: (raw) => raw.length === 0,
    read: (text) =>
      Effect.succeed(
        Option.map(decodeListDocument(text), (raw) => {
          const unread = raw.filter((json) => Option.isNone(decodeItem(json)));

          return {
            value: Array.getSomes(raw.map((json) => decodeItem(json))),
            raw,
            held: Array.getSomes(unread.map(unreadKey)),
            unread: unread.map((json) => unreadId(unreadKey(json), json)),
          };
        })
      ),
    write: (raw, merged) =>
      Effect.gen(function* () {
        const kept = raw.filter(
          (json) =>
            !Option.exists(keyOfJson(json), (key) =>
              merged.removed.includes(key)
            )
        );

        const present = new Set(Array.getSomes(kept.map(keyOfJson)));

        const added = yield* Effect.forEach(
          merged.value.filter(
            (value) =>
              merged.set.includes(keyOf(value)) && !present.has(keyOf(value))
          ),
          (value) => encodeItem(value)
        );

        return yield* encodeListDocument([...kept, ...added]);
      }),
  };
};

/**
 * `message` each time another tab writes `key` or its recovery key (or clears storage). The browser
 * raises `storage` only in the other tabs, never in the one that wrote.
 */
export const storageChanges = <A>(key: string, message: A): Stream.Stream<A> =>
  streamFromEventFilterMap({
    target: window,
    type: "storage",
    filterMapEvent: (event) =>
      event.key === key || event.key === recoveryKey(key) || event.key === null
        ? Option.some(message)
        : Option.none(),
  });
