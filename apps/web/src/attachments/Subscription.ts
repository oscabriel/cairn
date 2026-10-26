// The tray's streams: upload progress from the running XHRs, and files pasted with focus on no field.

import { Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { documentPastes } from "./Paste.ts";
import { uploadProgress } from "./UploadQueue.ts";

/** The tray's subscriptions; both run for as long as the app does. */
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  uploadProgress: Subscription.persistentEntry(
    Stream.map(uploadProgress, ({ localId, progress }) =>
      Message.ProgressedUpload({ localId, progress })
    )
  ),
  documentPaste: Subscription.persistentEntry(documentPastes),
}));
