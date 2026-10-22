// The tray's Commands: fit an image in the browser, upload one item (a fresh signed URL, then the
// bytes), take back an upload the user removed, release a thumbnail's object URL, and read and
// write the ready attachments saved on this device.
import { AttachmentId } from "@cairn/protocol/Ids";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { File } from "foldkit/file";

import { CairnConnection } from "../connection/Connection.ts";
import { createPreview, fitImage, revokePreview } from "./FitImage.ts";
import { Message } from "./Message.ts";
import { loadSaved, saveSaved, SavedAttachments } from "./Saved.ts";
import { rpcFailure, sendBytes } from "./UploadQueue.ts";

/** Fits an image to the long edge for upload and makes its thumbnail URL. */
export const PrepareImage = Command.define("PrepareImage", {
  args: { localId: Schema.String, file: File, mimeType: Schema.String },
  messages: [Message.PreparedImage],
  execute: ({ file, localId, mimeType }) =>
    Effect.gen(function* () {
      const fitted = yield* fitImage(file, mimeType);
      const previewUrl = yield* createPreview(fitted);

      return Message.PreparedImage({ localId, file: fitted, previewUrl });
    }),
});

/** Milliseconds since `pastedAt` on the page's performance clock, the clock `event.timeStamp` uses. */
const sincePaste = (pastedAt: Option.Option<number>) =>
  Effect.sync(() =>
    Option.map(pastedAt, (at) => Math.max(0, performance.now() - at))
  );

/**
 * Uploads one item: asks the brain for a signed one-shot URL, then sends the bytes to it. Keyed by
 * the item, so removing it interrupts the request (`UploadAttachment.Interrupt`).
 */
export const UploadAttachment = Command.define("UploadAttachment", {
  args: {
    localId: Schema.String,
    file: File,
    name: Schema.String,
    mimeType: Schema.String,
    pastedAt: Schema.Option(Schema.Finite),
  },
  messages: [Message.SucceededUpload, Message.FailedUpload],
  interrupt: {
    keyFields: ["localId"],
    toKey: ({ localId }) => localId,
  },
  execute: ({ file, localId, mimeType, name, pastedAt }) =>
    Effect.gen(function* () {
      const pasteToRequestMs = yield* sincePaste(pastedAt);

      const client = yield* CairnConnection.get.pipe(
        Effect.mapError(rpcFailure)
      );

      const url = yield* client["attachments.createUploadUrl"]({
        name,
        mimeType,
        sizeBytes: file.size,
      }).pipe(Effect.mapError(rpcFailure));

      const ref = yield* sendBytes({
        localId,
        uploadPath: url.uploadPath,
        file,
        mimeType,
      });

      return Message.SucceededUpload({ localId, ref, pasteToRequestMs });
    }).pipe(
      Effect.catchTag("UploadFailed", (failure) =>
        Effect.succeed(
          Message.FailedUpload({
            localId,
            reason: failure.message,
            retryable: failure.retryable,
            pasteToRequestMs: Option.none(),
          })
        )
      )
    ),
});

/** Tells the brain a stored upload will not be sent, so it can drop it before the daily sweep. */
export const DiscardAttachment = Command.define("DiscardAttachment", {
  args: { attachmentId: AttachmentId },
  messages: [Message.CompletedDiscard],
  execute: ({ attachmentId }) =>
    Effect.gen(function* () {
      const client = yield* CairnConnection.get;

      yield* client["attachments.discard"]({ attachmentId });
    }).pipe(
      // A discard that does not land costs nothing: unclaimed uploads are swept after 24 hours.
      Effect.ignore,
      Effect.as(Message.CompletedDiscard())
    ),
});

/** Releases a thumbnail's object URL. */
export const RevokePreview = Command.define("RevokePreview", {
  args: { url: Schema.String },
  messages: [Message.CompletedRevokePreview],
  execute: ({ url }) =>
    Effect.as(revokePreview(url), Message.CompletedRevokePreview()),
});

/** Reads the ready attachments saved on this device. */
export const LoadSaved = Command.define("LoadSaved", {
  messages: [Message.LoadedSaved],
  execute: Effect.map(loadSaved, (drafts) => Message.LoadedSaved({ drafts })),
});

/** Writes the ready attachments of every draft. */
export const SaveReady = Command.define("SaveReady", {
  args: { drafts: SavedAttachments },
  messages: [Message.CompletedSave],
  execute: ({ drafts }) =>
    Effect.map(saveSaved(drafts), (saved) => Message.CompletedSave({ saved })),
});
