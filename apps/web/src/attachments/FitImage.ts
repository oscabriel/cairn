// Ported from github.com/pingdotgg/t3code, apps/web/src/lib/imageCompression.ts
// (`fitImageToMaxEdge`, `createCanvas`, `encodeCanvas`, `fileNameForMimeType`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: decode with `createImageBitmap` honouring EXIF
// orientation, draw onto an `OffscreenCanvas` (or a DOM canvas), high-quality smoothing, refuse an
// encoder that answers with another type, and fall back to the original file on any failure.
// Changed: client-logic's `imageEncodePlan` decides (1,568 px long edge, JPEG 0.85 unless a small
// PNG, plan D34), JPEG gets a white matte under transparent pixels, the result is kept only when
// it is smaller or was resized, and HEIC conversion is gone (plan D32). Written as Effects.
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

import { imageEncodePlan } from "@cairn/client-logic/AttachmentFiles";
import type { ImageEncodePlan } from "@cairn/client-logic/AttachmentFiles";
import { Effect, Option, Predicate, Schema } from "effect";

/** The browser could not decode or re-encode an image; the original is uploaded instead. */
class FitFailed extends Schema.TaggedError<FitFailed>()("FitFailed", {
  step: Schema.Literals(["decode", "canvas", "encode"]),
  cause: Schema.Defect(),
}) {}

type Surface =
  | {
      readonly kind: "offscreen";
      readonly canvas: OffscreenCanvas;
      readonly context: OffscreenCanvasRenderingContext2D;
    }
  | {
      readonly kind: "dom";
      readonly canvas: HTMLCanvasElement;
      readonly context: CanvasRenderingContext2D;
    };

const canFit = (): boolean =>
  Predicate.isFunction(globalThis.createImageBitmap) &&
  (Predicate.isFunction(globalThis.OffscreenCanvas) ||
    Predicate.isNotUndefined(globalThis.document));

const createSurface = (
  width: number,
  height: number
): Option.Option<Surface> => {
  if (Predicate.isFunction(globalThis.OffscreenCanvas)) {
    const canvas = new OffscreenCanvas(width, height);

    return Option.map(
      Option.fromNullishOr(canvas.getContext("2d")),
      (context): Surface => ({ kind: "offscreen", canvas, context })
    );
  }

  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  return Option.map(
    Option.fromNullishOr(canvas.getContext("2d")),
    (context): Surface => ({ kind: "dom", canvas, context })
  );
};

const toBlob = (
  surface: Surface,
  plan: ImageEncodePlan
): Effect.Effect<Blob | null, FitFailed> => {
  if (surface.kind === "offscreen") {
    const { canvas } = surface;

    return Effect.tryPromise({
      try: async () =>
        await canvas.convertToBlob({
          type: plan.mimeType,
          quality: plan.quality,
        }),
      catch: (cause) => new FitFailed({ step: "encode", cause }),
    });
  }

  const { canvas } = surface;

  return Effect.callback<Blob | null>((resume) => {
    canvas.toBlob(
      (blob) => {
        resume(Effect.succeed(blob));
      },
      plan.mimeType,
      plan.quality
    );
  });
};

// An encoder that does not know the type answers with PNG; that is not what was asked for.
const encode = (surface: Surface, plan: ImageEncodePlan) =>
  Effect.map(toBlob(surface, plan), (blob) =>
    Option.filter(
      Option.fromNullishOr(blob),
      ({ type }) => type === plan.mimeType
    )
  );

const renamed = (name: string, mimeType: string): string => {
  const extension = mimeType === "image/png" ? ".png" : ".jpg";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name || "image";

  return `${base}${extension}`;
};

const decode = (file: File) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () =>
        await createImageBitmap(file, { imageOrientation: "from-image" }),
      catch: (cause) => new FitFailed({ step: "decode", cause }),
    }),
    (bitmap) =>
      Effect.sync(() => {
        bitmap.close();
      })
  );

/**
 * The image as it should be uploaded: fitted to the 1,568 px long edge and re-encoded when the plan
 * says so, otherwise the original. Never fails: a browser that cannot decode or encode the image
 * hands back the original, and the brain fits it again on its side.
 */
export const fitImage = (file: File, mimeType: string): Effect.Effect<File> =>
  Effect.gen(function* () {
    if (!canFit()) {
      return file;
    }

    const bitmap = yield* decode(file);
    const source = { width: bitmap.width, height: bitmap.height };

    const plan = imageEncodePlan({
      mimeType,
      size: source,
      sizeBytes: file.size,
    });

    if (Option.isNone(plan)) {
      return file;
    }

    const { size } = plan.value;

    const surface = yield* Effect.fromOption(
      createSurface(size.width, size.height)
    ).pipe(
      Effect.mapError(
        () => new FitFailed({ step: "canvas", cause: "no 2d context" })
      )
    );

    if (plan.value.mimeType === "image/jpeg") {
      surface.context.fillStyle = "#ffffff";
      surface.context.fillRect(0, 0, size.width, size.height);
    }

    surface.context.imageSmoothingQuality = "high";
    surface.context.drawImage(bitmap, 0, 0, size.width, size.height);

    const blob = yield* encode(surface, plan.value);

    const resized =
      size.width !== source.width || size.height !== source.height;

    return Option.match(
      Option.filter(blob, (encoded) => resized || encoded.size < file.size),
      {
        onNone: () => file,
        onSome: (encoded) =>
          new File([encoded], renamed(file.name, plan.value.mimeType), {
            type: plan.value.mimeType,
            lastModified: file.lastModified,
          }),
      }
    );
  }).pipe(
    Effect.scoped,
    Effect.catchTag("FitFailed", () => Effect.succeed(file))
  );

/** An object URL showing `file`, for a thumbnail; revoke it with `revokePreview`. */
export const createPreview = (
  file: File
): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() => Option.some(URL.createObjectURL(file)));

/** Releases an object URL made by `createPreview`. */
export const revokePreview = (url: string): Effect.Effect<void> =>
  Effect.sync(() => {
    URL.revokeObjectURL(url);
  });
