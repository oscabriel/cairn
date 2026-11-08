// The tray's streams: upload progress from the running XHRs, files pasted with focus on no field, and
// another tab's writes of the saved attachments.

import { Stream } from "effect";
import { Subscription } from "foldkit";

import { storageChanges } from "../storage/TabChanges.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { documentPastes } from "./Paste.ts";
import { SAVED_ATTACHMENTS_KEY } from "./Saved.ts";
import { uploadProgress } from "./UploadQueue.ts";

/** The tray's subscriptions; each runs for as long as the app does. */
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  uploadProgress: Subscription.persistentEntry(
    Stream.map(uploadProgress, ({ localId, progress }) =>
      Message.ProgressedUpload({ localId, progress })
    )
  ),
  documentPaste: Subscription.persistentEntry(documentPastes),
  storedAttachments: Subscription.persistentEntry(
    storageChanges(SAVED_ATTACHMENTS_KEY, Message.ChangedStoredAttachments())
  ),
}));
