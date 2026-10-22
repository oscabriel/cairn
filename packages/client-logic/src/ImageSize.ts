// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/imageAttachmentSize.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: an image whose long edge is over the limit is
// scaled down keeping its aspect ratio, never below one pixel; PNG and JPEG are the types a canvas
// re-encodes. Changed: the long edge is Cairn's 1,568 px (`IMAGE_FIT_LONG_EDGE`, plan D34, the size
// Claude downscales to) instead of t3code's 2,000, and "already fits" is `Option.none()`.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { IMAGE_FIT_LONG_EDGE } from "@cairn/protocol/Attachments";
import { Option } from "effect";

/** An image's pixel size. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** The image types a canvas can re-encode after scaling. */
export type DownscalableImageMimeType = "image/png" | "image/jpeg";

/** The re-encodable type for `mimeType`, or none for types left as they are (GIF, WebP). */
export const downscalableImageMimeType = (
  mimeType: string
): Option.Option<DownscalableImageMimeType> => {
  const normalized = mimeType.toLowerCase();

  if (normalized === "image/png") {
    return Option.some("image/png");
  }

  return normalized === "image/jpeg" || normalized === "image/jpg"
    ? Option.some("image/jpeg")
    : Option.none();
};

/** The size to scale an image to, or none when its long edge already fits. */
export const fitImageAttachmentSize = (
  size: ImageSize,
  maxEdge = IMAGE_FIT_LONG_EDGE
): Option.Option<ImageSize> => {
  const longest = Math.max(size.width, size.height);

  if (longest <= maxEdge) {
    return Option.none();
  }

  const scale = maxEdge / longest;

  const fit = (edge: number) =>
    Math.max(1, Math.min(maxEdge, Math.round(edge * scale)));

  return Option.some({ width: fit(size.width), height: fit(size.height) });
};
