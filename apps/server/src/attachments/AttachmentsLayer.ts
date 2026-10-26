// Every attachment service as one layer for the composition roots: the store (with its daily
// sweep), signed upload URLs, image fitting, document text and the intake that runs them in order.
// Needs `ServerConfig`, `FileSystem` and the `SqlClient` of `cairn.sqlite` (migrated through
// `0003_Attachments`).

import { Layer } from "effect";

import { AttachmentIntake } from "./AttachmentIntake.ts";
import { AttachmentStore } from "./AttachmentStore.ts";
import { ImagePrepare } from "./ImagePrepare.ts";
import { TextExtract } from "./TextExtract.ts";
import { UploadTokens } from "./UploadTokens.ts";

/** The attachment services; images are fitted in Photon's worker unless `PhotonInWorker` says not. */
export const AttachmentsLayer = AttachmentIntake.layerNoDeps.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      AttachmentStore.layerNoDeps,
      UploadTokens.layerNoDeps,
      ImagePrepare.layer,
      TextExtract.layer
    )
  )
);
