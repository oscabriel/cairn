// `attachments.createUploadUrl` and `attachments.discard`: thin calls into `UploadTokens` and
// `AttachmentStore` that translate their failures into the protocol's errors, carrying the RPC
// request id. Discarding an unknown or already sent attachment succeeds and changes nothing, so a
// client can retry it freely.

import { AttachmentRejected, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import { AttachmentStore } from "../attachments/AttachmentStore.ts";
import { UploadTokens } from "../attachments/UploadTokens.ts";

/** `attachments.createUploadUrl`: a signed one-shot upload path. */
export const CreateUploadUrlHandler = CairnRpcs.toLayerHandler(
  "attachments.createUploadUrl",
  Effect.gen(function* () {
    const tokens = yield* UploadTokens;

    return (input, { requestId }) =>
      tokens.issue(input).pipe(
        Effect.mapError(
          (refused) =>
            new AttachmentRejected({
              message: refused.message,
              reason: refused.reason,
              requestId: Option.some(String(requestId)),
            })
        )
      );
  })
);

/** `attachments.discard`: removes an upload the user took back before sending. */
export const DiscardAttachmentHandler = CairnRpcs.toLayerHandler(
  "attachments.discard",
  Effect.gen(function* () {
    const store = yield* AttachmentStore;

    return (input, { requestId }) =>
      store.discard(input.attachmentId).pipe(
        Effect.mapError(
          (failure) =>
            new Unavailable({
              message: failure.message,
              requestId: Option.some(String(requestId)),
            })
        )
      );
  })
);

/** Both attachment handlers, for `rpc/Handlers.ts`. Needs `UploadTokens` and `AttachmentStore`. */
export const AttachmentHandlers = Layer.mergeAll(
  CreateUploadUrlHandler,
  DiscardAttachmentHandler
);
