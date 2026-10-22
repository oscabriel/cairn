// The ready attachments of every draft, saved on this device beside the drafts themselves (plan
// D28 keeps a draft's attachments as ids; this keeps what the tray needs to show them after a
// reload: the name, type, size and kind the brain answered with).
import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Effect, Option, Schema } from "effect";
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

  return yield* Option.match(Option.fromUndefinedOr(saved), {
    onNone: () => Effect.succeed({}),
    onSome: decodeSaved,
  });
}).pipe(Effect.orElseSucceed(() => ({})));

/** Writes the saved attachments, replacing what was there; false when storage refused. */
export const saveSaved = (
  saved: SavedAttachments
): Effect.Effect<boolean, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const json = yield* encodeSaved(saved);

    yield* store.set(SAVED_ATTACHMENTS_KEY, json);

    return true;
  }).pipe(Effect.orElseSucceed(() => false));
