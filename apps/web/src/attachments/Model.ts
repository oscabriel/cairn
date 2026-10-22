// The attachment tray's state: every file the user attached to a draft, from the moment it is
// pasted, dropped or picked until the turn that carries it is sent. Uploads run eagerly, three at a
// time, and keep running when the user moves to another draft; each item remembers its draft. A
// ready item holds the brain's `AttachmentRef`, which is all a draft keeps across a reload.
import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Option, Schema } from "effect";
import { File } from "foldkit/file";
import { defineTaggedUnion } from "foldkit/schema";

/** Where one attachment is on its way to the brain. */
export const AttachmentStatus = defineTaggedUnion({
  /** An image being fitted to the long edge in the browser. */
  Preparing: {},
  /** Waiting for one of the three upload slots. */
  Queued: {},
  /** Asking for a signed URL, then sending the bytes; `progress` runs from 0 to 1. */
  Uploading: { progress: Schema.Finite },
  /** Stored and prepared by the brain; the turn can carry it. */
  Ready: { ref: AttachmentRef },
  /** Refused or lost; `retryable` says whether trying again with a new URL may help. */
  Failed: { reason: Schema.String, retryable: Schema.Boolean },
});

export type AttachmentStatus = typeof AttachmentStatus.Type;

/** One attachment in a draft's tray. */
export const Item = Schema.Struct({
  /** The tray's own id, minted in order; the brain's id arrives with the ref. */
  localId: Schema.String,
  /** The draft that owns it (`thread:<id>` or `draft:<id>`, as the composer keys drafts). */
  draftKey: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  isImage: Schema.Boolean,
  /** The bytes to upload: the fitted image or the file itself. None once restored from storage. */
  file: Schema.Option(File),
  /** An object URL of the local image, for the thumbnail. */
  previewUrl: Schema.Option(Schema.String),
  /** When the paste happened, on the page's performance clock (`event.timeStamp`). */
  pastedAt: Schema.Option(Schema.Finite),
  /** Milliseconds from the paste to the upload URL request, once measured. */
  pasteToRequestMs: Schema.Option(Schema.Finite),
  /** Upload attempts so far; a failure is retried once with a new URL before it shows. */
  attempts: Schema.Int,
  status: AttachmentStatus,
});

export type Item = typeof Item.Type;

/** How a waiting send was asked for, so it fires the same way. */
export const SendIntent = Schema.Literals([
  "foreground",
  "alternate",
  "background",
]);

export type SendIntent = typeof SendIntent.Type;

/** A send pressed while the draft still had uploads in flight. */
export const WaitingSend = Schema.Struct({
  draftKey: Schema.String,
  intent: SendIntent,
});

export type WaitingSend = typeof WaitingSend.Type;

/** A note for one draft's tray, such as why a file was refused. */
export const TrayNotice = Schema.Struct({
  draftKey: Schema.String,
  text: Schema.String,
});

export type TrayNotice = typeof TrayNotice.Type;

/** The attachment tray's Model. */
export const Model = Schema.Struct({
  /** Every draft's attachments, oldest first. */
  items: Schema.Array(Item),
  /** The number in the next minted `localId`. */
  nextLocalId: Schema.Int,
  /** True once the ready attachments saved on this device have been read. */
  loaded: Schema.Boolean,
  waitingSend: Schema.Option(WaitingSend),
  notice: Schema.Option(TrayNotice),
});

export type Model = typeof Model.Type;

/** The tray before anything is attached. */
export const initial: Model = {
  items: [],
  nextLocalId: 1,
  loaded: false,
  waitingSend: Option.none(),
  notice: Option.none(),
};
