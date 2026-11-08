// The ready attachments of every draft, saved on this device beside the drafts themselves (plan
// D28 keeps a draft's attachments as ids; this keeps what the tray needs to show them after a
// reload: the name, type, size and kind the brain answered with). Each attachment's first save time
// is kept beside them, and one older than the brain's sweep of unclaimed uploads is not restored
// (T38): the brain no longer has it, so sending it would fail. A save writes only what this tab
// added or removed, so tabs keep each other's (`TabChanges.ts`).

import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Array, Clock, Effect, Option, Record, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

import {
  applyListChanges,
  listChanges,
  mergeList,
  mergeStored,
} from "../storage/TabChanges.ts";
import type { ListChanges } from "../storage/TabChanges.ts";

/** The localStorage key of the saved ready attachments, one JSON object keyed by draft. */
export const SAVED_ATTACHMENTS_KEY = "cairn:composer-attachments:v1";

/** Ready attachments by draft key. */
export const SavedAttachments = Schema.Record(
  Schema.String,
  Schema.Array(AttachmentRef)
);

export type SavedAttachments = typeof SavedAttachments.Type;

const SavedJson = Schema.fromJsonString(Schema.toCodecJson(SavedAttachments));

/** The localStorage key of when each saved attachment was first saved, by attachment id. */
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

/**
 * `saved` without the attachments first saved longer ago than the brain's sweep. One saved before
 * times were kept has none, and is kept until its next save.
 */
const withinRestoreWindow = (saved: SavedAttachments) =>
  Effect.gen(function* () {
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

const decodeSaved = Schema.decodeEffect(SavedJson);

const encodeSaved = Schema.encodeEffect(SavedJson);

/** Reads the saved attachments. Missing or unreadable storage is none: attaching never waits on it. */
export const loadSaved: Effect.Effect<
  SavedAttachments,
  never,
  KeyValueStore.KeyValueStore
> = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const saved = yield* store.get(SAVED_ATTACHMENTS_KEY);

  const drafts = yield* Option.match(Option.fromUndefinedOr(saved), {
    onNone: () => Effect.succeed({}),
    onSome: decodeSaved,
  });

  return yield* withinRestoreWindow(drafts);
}).pipe(Effect.orElseSucceed(() => ({})));

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
 * Writes the attachments this tab added or removed since `base` (the saved attachments as it last
 * read or wrote them) into what storage holds now, so another tab's are kept, and writes back one of
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
      loadSaved,
      (stored, removals) =>
        Option.map(
          mergeList(entryKey)(entriesOf(freshBase), entriesOf(fresh))(
            entriesOf(stored),
            removals
          ),
          (merged) => ({ ...merged, value: savedOf(merged.value) })
        ),
      (next) =>
        Effect.gen(function* () {
          const store = yield* KeyValueStore.KeyValueStore;
          const json = yield* encodeSaved(next);
          const known: Times = yield* loadTimes;
          const now = yield* Clock.currentTimeMillis;
          const times: { [id: string]: number } = {};

          for (const refs of Object.values(next)) {
            for (const { id } of refs) {
              times[id] = known[id] ?? now;
            }
          }

          yield* store.set(SAVED_ATTACHMENTS_KEY, json);
          yield* store.set(SAVED_TIMES_KEY, yield* encodeTimes(times));
        })
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
