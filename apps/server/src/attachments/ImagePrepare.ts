// Fits an uploaded image for the model at upload time, never at send (plan section 1,
// "Attachments"): pi-durable's Photon processor, in its worker thread, turns the image upright,
// scales it to 1,568 px on the long edge and re-encodes it within pi-durable's byte limit. The
// result is kept as binary beside the original (`<id>.prepared`), so a send only reads a file.
// 1,568 px matches the client's fit (`IMAGE_FIT_LONG_EDGE`), so a phone upload is not resized
// twice; models newer than Claude 4.6 take up to 2,576 px, so this is a cost choice, not a ceiling.
//
// Ported from cairn-v1, apps/server/src/Files.ts at 1a5cd4a (`prepare` and the processor made once
// and forgotten when it fails to start). Changed: Cairn's fit, binary output, typed failures.

import { IMAGE_FIT_LONG_EDGE } from "@cairn/protocol/Attachments";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  SynchronizedRef,
} from "effect";

/** An image fitted for the model. */
export interface PreparedImage {
  readonly bytes: Uint8Array;
  /** The prepared format, which may differ from the upload's (Photon re-encodes). */
  readonly mimeType: string;
}

/** The image could not be prepared. `unreadable` is the image's fault; `unavailable` the server's. */
export class ImagePrepareError extends Schema.TaggedError<ImagePrepareError>()(
  "ImagePrepareError",
  {
    message: Schema.String,
    reason: Schema.Literals(["unreadable", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** The limits images are fitted to. */
const LIMITS = {
  maxWidth: IMAGE_FIT_LONG_EDGE,
  maxHeight: IMAGE_FIT_LONG_EDGE,
  maxBytes: DEFAULT_IMAGE_LIMITS.maxBytes,
};

/**
 * Whether Photon runs in its worker thread (the default) or on the calling thread. Tests that
 * prepare real images turn the worker off; the decoding and the fit are the same.
 */
export const PhotonInWorker = Context.Reference<boolean>(
  "cairn/server/attachments/ImagePrepare/PhotonInWorker",
  { defaultValue: () => true }
);

/** Fits images for the model. */
export class ImagePrepare extends Context.Service<
  ImagePrepare,
  {
    /**
     * The image fitted to 1,568 px on its long edge. Fails with `ImagePrepareError`: `unreadable`
     * when Photon cannot decode it, `unavailable` when the processor would not start.
     */
    prepare(
      bytes: Uint8Array,
      mimeType: string
    ): Effect.Effect<PreparedImage, ImagePrepareError>;
  }
>()("cairn/server/attachments/ImagePrepare") {
  /** pi-durable's Photon processor (in a worker unless `PhotonInWorker` says not), started at the first image. */
  static readonly layer = Layer.effect(
    ImagePrepare,
    Effect.gen(function* () {
      const worker = yield* PhotonInWorker;

      // Made at the first image and kept; a processor that failed to start is not kept, so the
      // next image tries again.
      const processor = yield* SynchronizedRef.make(
        Option.none<ImageProcessor>()
      );

      const acquire = SynchronizedRef.modifyEffect(processor, (current) =>
        Option.match(current, {
          onSome: (ready) => Effect.succeed([ready, current] as const),
          onNone: () =>
            Effect.tryPromise({
              try: async () => await createNodePhotonImages({ worker }),
              catch: (cause) =>
                new ImagePrepareError({
                  message:
                    "ImagePrepare could not start the image processor. Nothing was stored; attach the image again.",
                  reason: "unavailable",
                  cause,
                }),
            }).pipe(
              Effect.map((ready) => [ready, Option.some(ready)] as const)
            ),
        })
      );

      const prepare = Effect.fn("ImagePrepare.prepare")(function* (
        bytes: Uint8Array,
        mimeType: string
      ) {
        const ready = yield* acquire;

        const prepared = yield* Effect.tryPromise({
          try: async () => await ready.prepare(bytes, mimeType, LIMITS),
          catch: (cause) =>
            new ImagePrepareError({
              message:
                "ImagePrepare could not decode the image. Attach it as a PNG or JPEG.",
              reason: "unreadable",
              cause,
            }),
        });

        if (prepared === undefined) {
          return yield* new ImagePrepareError({
            message:
              "ImagePrepare could not decode the image or fit it to the model's limits. Attach it as a PNG or JPEG.",
            reason: "unreadable",
          });
        }

        return {
          bytes: new Uint8Array(Buffer.from(prepared.data, "base64")),
          mimeType: prepared.mimeType,
        };
      });

      return ImagePrepare.of({ prepare });
    })
  );
}
