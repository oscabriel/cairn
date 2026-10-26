// t3code has no test for imageAttachmentSize.ts at fe27e8e3; these cases judge the port in
// ImageSize.ts (its header names the source and the MIT notice).

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
} from "./ImageSize.ts";

describe(fitImageAttachmentSize, () => {
  it("leaves an image that fits alone", () => {
    assert.isTrue(
      Option.isNone(fitImageAttachmentSize({ width: 1568, height: 900 }))
    );
    assert.isTrue(
      Option.isNone(fitImageAttachmentSize({ width: 10, height: 10 }))
    );
  });

  it("scales the long edge to 1,568 px and keeps the aspect ratio", () => {
    assert.deepStrictEqual(
      fitImageAttachmentSize({ width: 3136, height: 1764 }),
      Option.some({ width: 1568, height: 882 })
    );
    assert.deepStrictEqual(
      fitImageAttachmentSize({ width: 1170, height: 2532 }),
      Option.some({ width: 725, height: 1568 })
    );
  });

  it("never scales an edge below one pixel", () => {
    assert.deepStrictEqual(
      fitImageAttachmentSize({ width: 100_000, height: 2 }),
      Option.some({ width: 1568, height: 1 })
    );
  });
});

describe(downscalableImageMimeType, () => {
  it("re-encodes PNG and JPEG only", () => {
    assert.deepStrictEqual(
      downscalableImageMimeType("IMAGE/PNG"),
      Option.some("image/png")
    );
    assert.deepStrictEqual(
      downscalableImageMimeType("image/jpg"),
      Option.some("image/jpeg")
    );
    assert.isTrue(Option.isNone(downscalableImageMimeType("image/gif")));
    assert.isTrue(Option.isNone(downscalableImageMimeType("image/webp")));
  });
});
