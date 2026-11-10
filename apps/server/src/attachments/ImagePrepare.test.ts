// ImagePrepare over Photon's worker, which is how the brain runs it. The other attachment tests
// turn the worker off (`PhotonInWorker` false), so nothing else hands bytes across a thread: this
// file does, with the smallest upload there is.

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { testLimit } from "../EventuallyTestKit.ts";
import { ImagePrepare } from "./ImagePrepare.ts";

/** A 1 by 1 PNG, 70 bytes: far under Node's Buffer pool, so a Buffer of it is a view on the pool. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("ImagePrepare in Photon's worker", () => {
  it.live(
    "fits a small image handed over as a Buffer, whose memory is a view on Node's pool",
    () =>
      Effect.gen(function* () {
        const images = yield* ImagePrepare;

        // As `AttachmentStore` hands an upload over: `Buffer.concat` of its chunks.
        const bytes = Buffer.concat([Buffer.from(PIXEL, "base64")]);

        assert.isBelow(bytes.byteLength, bytes.buffer.byteLength);

        const prepared = yield* images.prepare(bytes, "image/png");

        assert.isAbove(prepared.bytes.byteLength, 0);
        assert.match(prepared.mimeType, /^image\//u);
      }).pipe(Effect.provide(ImagePrepare.layer)),
    testLimit(30_000)
  );
});
