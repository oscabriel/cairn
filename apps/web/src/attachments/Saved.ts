// The ready attachments of every draft, saved on this device beside the drafts themselves (plan
// D28 keeps a draft's attachments as ids; this keeps what the tray needs to show them after a
// reload: the name, type, size and kind the brain answered with). Each attachment's first save time
// is kept beside them, and one older than the brain's sweep of unclaimed uploads is not restored
// (T38): the brain no longer has it, so sending it would fail. A save writes only what this tab
// added or removed, so tabs keep each other's (`TabChanges.ts`), and an attachment this build cannot
// decode is kept as stored.

import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Array, Clock, Effect, Option, Record, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

import {
  applyListChanges,
  listChanges,
  loadShared,
  mergeList,
  mergeStored,
  unreadId,
} from "../storage/TabChanges.ts";
import type { ListChanges, Persisted } from "../storage/TabChanges.ts";

/**
 * The localStorage key of the saved ready attachments, one JSON object of `AttachmentRef` lists by
 * draft key. Add a field to `AttachmentRef` as optional, or a literal, and an older build keeps the
 * refs it cannot decode as stored (`TabChanges.ts`); change what a stored field means, or the
 * object's outer shape, and bump the version.
 */
export const SAVED_ATTACHMENTS_KEY = "cairn:composer-attachments:v1";

/** Ready attachments by draft key. */
export const SavedAttachments = Schema.Record(
  Schema.String,
  Schema.Array(AttachmentRef)
);

export type SavedAttachments = typeof SavedAttachments.Type;

/**
 * The localStorage key of when each saved attachment was first saved, by attachment id. A change to
 * its shape needs a new version: a build that cannot read the times reads them as none.
 */
export const SAVED_TIMES_KEY = "cairn:composer-attachment-times:v1";

/** How long the brain keeps an upload no turn claimed (its daily sweep). */
export const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When each attachment was first saved, in epoch milliseconds, by attachment id. */
interface Times {
  readonly [id: string]: number;
}

const TimesJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Finite)
);

const decodeTimes = Schema.decodeEffect(TimesJson);

const encodeTimes = Schema.encodeEffect(TimesJson);

/** The saved times; none stored or unreadable is empty. */
const loadTimes = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const saved = yield* store.get(SAVED_TIMES_KEY);

  return yield* Option.match(Option.fromUndefinedOr(saved), {
    onNone: () => Effect.succeed({}),
    onSome: decodeTimes,
  });
}).pipe(Effect.orElseSucceed((): Readonly<Record<string, number>> => ({})));

/** One saved attachment: its ref and the draft it belongs to. */
interface SavedEntry {
  readonly draftKey: string;
  readonly ref: AttachmentRef;
}

const entryKey = ({ draftKey, ref }: SavedEntry): string =>
  `${draftKey} ${ref.id}`;

const entriesOf = (saved: SavedAttachments): ReadonlyArray<SavedEntry> =>
  Record.toEntries(saved).flatMap(([draftKey, refs]) =>
    refs.map((ref) => ({ draftKey, ref }))
  );

const savedOf = (entries: ReadonlyArray<SavedEntry>): SavedAttachments =>
  Array.reduce(
    entries,
    Record.empty<string, ReadonlyArray<AttachmentRef>>(),
    (saved, { draftKey, ref }) => ({
      ...saved,
      [draftKey]: Array.append(saved[draftKey] ?? [], ref),
    })
  );

const savedChanges = (base: SavedAttachments, mine: SavedAttachments) =>
  listChanges(entryKey)(entriesOf(base), entriesOf(mine));

const applySavedChanges = (
  target: SavedAttachments,
  changes: ListChanges<SavedEntry>
): SavedAttachments =>
  savedOf(applyListChanges(entryKey)(entriesOf(target), changes));

/**
 * `saved` without the attachments first saved longer ago than the brain's sweep. One saved before
 * times were kept has none, and is kept until its next save.
 */
const withinRestoreWindow = Effect.fnUntraced(function* (
  saved: SavedAttachments
) {
  const times: Times = yield* loadTimes;
  const now = yield* Clock.currentTimeMillis;

  return Record.map(saved, (refs) =>
    refs.filter(({ id }) =>
      Option.match(Option.fromUndefinedOr(times[id]), {
        onNone: () => true,
        onSome: (at) => now - at < RESTORE_WINDOW_MS,
      })
    )
  );
});

/** The saved attachments as stored: each draft's refs as JSON, read one by one. */
type SavedRaw = Readonly<Record<string, ReadonlyArray<Schema.Json>>>;

const SavedDocument = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Array(Schema.Json))
);

const decodeSavedDocument = Schema.decodeOption(SavedDocument);

const encodeSavedDocument = Schema.encodeEffect(SavedDocument);

const RefJson = Schema.toCodecJson(AttachmentRef);

const decodeRef = Schema.decodeOption(RefJson);

const encodeRef = Schema.encodeEffect(RefJson);

/** The id of a stored ref, read even from a ref this build cannot decode. */
const RefId = Schema.Struct({ id: Schema.String });

const decodeRefId = Schema.decodeUnknownOption(RefId);

/** The entry key of a stored ref under `draftKey`, read even from a ref this build cannot decode. */
const keyOfJson = (draftKey: string, json: Schema.Json) =>
  Option.match(decodeRef(json), {
    onNone: () =>
      Option.map(decodeRefId(json), ({ id }) => `${draftKey} ${id}`),
    onSome: (ref) => Option.some(entryKey({ draftKey, ref })),
  });

/**
 * The saved attachments, read ref by ref: a ref this build decodes is restored unless the brain's
 * sweep has passed it (then it leaves storage with the next save), and one it cannot decode is kept
 * as stored.
 */
const persistedSaved: Persisted<
  SavedAttachments,
  SavedRaw,
  KeyValueStore.KeyValueStore,
  Schema.SchemaError | KeyValueStore.KeyValueStoreError
> = {
  empty: { value: {}, raw: {}, held: [], unread: [] },
  isEmpty: (raw) => Object.values(raw).every((refs) => refs.length === 0),
  read: (text) =>
    Effect.gen(function* () {
      const document = decodeSavedDocument(text);

      if (Option.isNone(document)) {
        return Option.none();
      }

      const decoded = Record.map(document.value, (refs) =>
        refs.map((json) => ({ json, ref: decodeRef(json) }))
      );

      const value = yield* withinRestoreWindow(
        Record.map(decoded, (refs) =>
          Array.getSomes(refs.map(({ ref }) => ref))
        )
      );

      const isRestored = (draftKey: string, ref: AttachmentRef) =>
        Option.exists(Record.get(value, draftKey), (kept) =>
          kept.some(({ id }) => id === ref.id)
        );

      const raw = Record.map(decoded, (refs, draftKey) =>
        refs
          .filter(({ ref }) =>
            Option.match(ref, {
              onNone: () => true,
              onSome: (read) => isRestored(draftKey, read),
            })
          )
          .map(({ json }) => json)
      );

      const unread = Record.toEntries(decoded).flatMap(([draftKey, refs]) =>
        refs
          .filter(({ ref }) => Option.isNone(ref))
          .map(({ json }) => ({ json, key: keyOfJson(draftKey, json) }))
      );

      return Option.some({
        value,
        raw,
        held: Array.getSomes(unread.map(({ key }) => key)),
        unread: unread.map(({ json, key }) => unreadId(key, json)),
      });
    }),
  write: (raw, merged) =>
    Effect.gen(function* () {
      const kept = Record.map(raw, (refs, draftKey) =>
        refs.filter(
          (json) =>
            !Option.exists(keyOfJson(draftKey, json), (key) =>
              merged.removed.includes(key)
            )
        )
      );

      const present = new Set(
        Record.toEntries(kept).flatMap(([draftKey, refs]) =>
          Array.getSomes(refs.map((json) => keyOfJson(draftKey, json)))
        )
      );

      const added = yield* Effect.forEach(
        entriesOf(merged.value).filter(
          (entry) =>
            merged.set.includes(entryKey(entry)) &&
            !present.has(entryKey(entry))
        ),
        (entry) =>
          Effect.map(encodeRef(entry.ref), (json) => ({
            draftKey: entry.draftKey,
            json,
          }))
      );

      const next = Record.filter(
        Array.reduce(added, kept, (document, { draftKey, json }) => ({
          ...document,
          [draftKey]: Array.append(document[draftKey] ?? [], json),
        })),
        (refs) => refs.length > 0
      );

      const store = yield* KeyValueStore.KeyValueStore;
      const known: Times = yield* loadTimes;
      const now = yield* Clock.currentTimeMillis;

      const ids = Object.values(next).flatMap((refs) =>
        Array.getSomes(
          refs.map((json) => Option.map(decodeRefId(json), ({ id }) => id))
        )
      );

      const times = Record.fromIterableWith(ids, (id) => [
        id,
        known[id] ?? now,
      ]);

      yield* store.set(SAVED_TIMES_KEY, yield* encodeTimes(times));

      return yield* encodeSavedDocument(next);
    }),
};

/**
 * Reads the saved attachments. Missing storage is none: attaching never waits on it. One this build
 * cannot decode, or a value it cannot read at all, is left as stored.
 */
export const loadSaved: Effect.Effect<
  SavedAttachments,
  never,
  KeyValueStore.KeyValueStore
> = Effect.map(
  loadShared(SAVED_ATTACHMENTS_KEY, persistedSaved),
  ({ value }) => value
);

/**
 * Writes the attachments this tab added or removed since `base` (the saved attachments as it last
 * asked for them to be written, or read them) into what storage holds now, so another tab's are kept, and writes back one of
 * this tab's that another tab's write dropped without removing it. One past the brain's sweep is
 * left out, as a read leaves it out, so it is never written back. Answers what storage holds
 * afterwards, or none when storage refused.
 */
export const saveSaved = (
  base: SavedAttachments,
  saved: SavedAttachments
): Effect.Effect<
  Option.Option<SavedAttachments>,
  never,
  KeyValueStore.KeyValueStore
> =>
  Effect.gen(function* () {
    const freshBase = yield* withinRestoreWindow(base);
    const fresh = yield* withinRestoreWindow(saved);

    return yield* mergeStored(
      SAVED_ATTACHMENTS_KEY,
      persistedSaved,
      (stored, removals, held) =>
        Option.map(
          mergeList(entryKey)(entriesOf(freshBase), entriesOf(fresh))(
            entriesOf(stored),
            removals,
            held
          ),
          (merged) => ({ ...merged, value: savedOf(merged.value) })
        )
    );
  });

/**
 * This tab's saved attachments once storage holds `stored`: what it added or removed since
 * `written` (what it last wrote or read) stays, and every other draft's are as stored.
 */
export const rebaseSaved = (
  written: SavedAttachments,
  mine: SavedAttachments,
  stored: SavedAttachments
): SavedAttachments => applySavedChanges(stored, savedChanges(written, mine));

const keysOf = (saved: SavedAttachments): ReadonlySet<string> =>
  new Set(entriesOf(saved).map(entryKey));

/** The attachments of `saved` that `other` does not hold: from a save's base to what it wrote, its removals. */
export const savedWithout = (
  saved: SavedAttachments,
  other: SavedAttachments
): SavedAttachments => {
  const others = keysOf(other);

  return savedOf(
    entriesOf(saved).filter((entry) => !others.has(entryKey(entry)))
  );
};

/** The attachments of `saved` that `other` holds too. */
export const savedWithin = (
  saved: SavedAttachments,
  other: SavedAttachments
): SavedAttachments => savedWithout(saved, savedWithout(saved, other));

/** The attachments of either. */
export const savedUnion = (
  saved: SavedAttachments,
  other: SavedAttachments
): SavedAttachments =>
  savedOf([...entriesOf(saved), ...entriesOf(savedWithout(other, saved))]);
