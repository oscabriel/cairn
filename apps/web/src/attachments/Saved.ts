// The ready attachments of every draft, saved on this device beside the drafts themselves (plan
// D28 keeps a draft's attachments as ids; this keeps what the tray needs to show them after a
// reload: the name, type, size and kind the brain answered with). Each attachment's first save time
// is kept beside them, and one older than the brain's sweep of unclaimed uploads is not restored
// (T38): the brain no longer has it, so sending it would fail.
import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Clock, Effect, Option, Record, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

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

  const times: Times = yield* loadTimes;
  const now = yield* Clock.currentTimeMillis;

  // An attachment saved before times were kept has none, and is kept until its next save.
  return Record.map(drafts, (refs) =>
    refs.filter(({ id }) =>
      Option.match(Option.fromUndefinedOr(times[id]), {
        onNone: () => true,
        onSome: (at) => now - at < RESTORE_WINDOW_MS,
      })
    )
  );
}).pipe(Effect.orElseSucceed(() => ({})));

/** Writes the saved attachments, replacing what was there; false when storage refused. */
export const saveSaved = (
  saved: SavedAttachments
): Effect.Effect<boolean, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const json = yield* encodeSaved(saved);
    const known: Times = yield* loadTimes;
    const now = yield* Clock.currentTimeMillis;
    const times: { [id: string]: number } = {};

    for (const refs of Object.values(saved)) {
      for (const { id } of refs) {
        times[id] = known[id] ?? now;
      }
    }

    yield* store.set(SAVED_ATTACHMENTS_KEY, json);
    yield* store.set(SAVED_TIMES_KEY, yield* encodeTimes(times));

    return true;
  }).pipe(Effect.orElseSucceed(() => false));
