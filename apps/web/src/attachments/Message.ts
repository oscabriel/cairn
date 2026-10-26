// The attachment tray's Messages and the OutMessages it hands the composer. Files arrive from the
// composer's paste Mount, the guarded document paste listener, a drop on the composer or the Attach
// button's file input; results come from the tray's Commands and the upload progress stream.

import { AttachmentRef } from "@cairn/protocol/Attachments";
import { AttachmentId } from "@cairn/protocol/Ids";
import { Schema } from "effect";
import { File } from "foldkit/file";
import { defineMessageUnion } from "foldkit/message";

import { SendIntent } from "./Model.ts";

/** Everything the tray reacts to. */
export const Message = defineMessageUnion({
  /** A paste the composer claimed for its files; `pastedAt` is the event's `timeStamp`. */
  PastedFiles: { files: Schema.Array(File), pastedAt: Schema.Finite },
  /** A long text paste folded into a text file (32 KiB or more, without mod+shift+V). */
  PastedText: { file: File, pastedAt: Schema.Finite },
  DroppedFiles: { files: Schema.Array(File) },
  PickedFiles: { files: Schema.Array(File) },
  ClickedRemove: { localId: Schema.String },
  ClickedRetry: { localId: Schema.String },
  ClickedDismissNotice: {},

  /** An image fitted for upload, with an object URL of it for the thumbnail. */
  PreparedImage: {
    localId: Schema.String,
    file: File,
    previewUrl: Schema.Option(Schema.String),
  },
  ProgressedUpload: { localId: Schema.String, progress: Schema.Finite },
  SucceededUpload: {
    localId: Schema.String,
    ref: AttachmentRef,
    pasteToRequestMs: Schema.Option(Schema.Finite),
  },
  FailedUpload: {
    localId: Schema.String,
    reason: Schema.String,
    retryable: Schema.Boolean,
    pasteToRequestMs: Schema.Option(Schema.Finite),
  },
  CompletedCancelUpload: { localId: Schema.String },
  CompletedDiscard: {},
  CompletedRevokePreview: {},

  /** The ready attachments saved on this device, by draft key. */
  LoadedSaved: {
    drafts: Schema.Record(Schema.String, Schema.Array(AttachmentRef)),
  },
  CompletedSave: { saved: Schema.Boolean },
});

export type Message = typeof Message.Type;

/** What the tray asks the composer to do. */
export const OutMessage = defineMessageUnion({
  /** An upload is ready: the draft at `draftKey` now carries `attachmentId`. */
  Attached: { draftKey: Schema.String, attachmentId: AttachmentId },
  /** A ready attachment was removed from the draft at `draftKey`. */
  Detached: { draftKey: Schema.String, attachmentId: AttachmentId },
  /** The draft's last upload answered: send it now, the way the user asked. */
  ReadyToSend: { draftKey: Schema.String, intent: SendIntent },
});

export type OutMessage = typeof OutMessage.Type;
