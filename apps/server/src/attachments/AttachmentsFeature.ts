// The attachments feature's manifest (ADR 0053): files a user attaches, prepared at upload (ADR
// 0019). Everything it registers with the brain and the app is listed here, and `Features.ts` lists
// this manifest.

import { Layer } from "effect";

import { placed, RepairOrder } from "../BootRepair.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import { AttachmentHandlers } from "./AttachmentHandlers.ts";
import { sweepAttachmentUploads } from "./AttachmentStore.ts";
import { ProviderRequestLog } from "./ProviderRequestExtension.ts";

/** What the attachments feature registers. */
export const AttachmentsFeature = {
  name: "attachments",
  extensionSources: [ProviderRequestLog.useSync((log) => log.extension)],
  extensionLayer: ProviderRequestLog.layer,
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [placed(RepairOrder.attachmentUploads, sweepAttachmentUploads)],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: AttachmentHandlers,
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
