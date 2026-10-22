// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerAttachmentFiles.ts
// (`inferImageMimeTypeFromName`, `classifyComposerAttachmentFile`,
// `normalizeComposerImageFileMimeType`, `shouldHandleComposerAttachmentPaste`),
// apps/web/src/lib/attachmentUploadState.ts (`formatAttachmentUploadProgress`) and
// apps/web/src/lib/imageCompression.ts (the fit-or-keep decision of `fitImageToMaxEdge`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, by way of cairn-v1 apps/web/src/attachments.ts at 1a5cd4a
// (`admitFiles`). Kept: image files always win a paste, other files win only without
// `text/plain`, an image named by its extension counts when the browser gave no type. Changed: HEIC
// is an unsupported image (plan D32: the brain refuses it, iOS already converts photos to JPEG);
// video is refused before upload; admission uses Cairn's limits (20 attachments, 50 MiB per file);
// files are plain `{name, type, size}` facts because this package runs without DOM globals; the
// image plan fits the long edge to 1,568 px and re-encodes as JPEG 0.85 unless the source is a small
// PNG, instead of t3code's 2,000 px WebP probe.
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
import {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "@cairn/protocol/Attachments";
import { Option, Record } from "effect";

import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
} from "./ImageSize.ts";
import type { ImageSize } from "./ImageSize.ts";

/** What the composer needs to know about a file: the browser `File`'s own name, type and size. */
export interface FileFacts {
  readonly name: string;
  /** The MIME type the browser reported; empty when it could not tell. */
  readonly type: string;
  readonly size: number;
}

/**
 * How the composer treats a file: an image the model takes as image content, an image type it
 * does not (SVG, TIFF, HEIC), or any other file, whose kind the brain decides from its bytes.
 */
export type AttachmentFileKind = "image" | "unsupported-image" | "file";

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(
  IMAGE_MIME_TYPES
);

const HEIC_MIME_TYPE = /^image\/hei[cf]$/iu;

const HEIC_EXTENSION = /\.(?:heic|heif)$/iu;

const isGenericType = (type: string): boolean => {
  const normalized = type.toLowerCase();

  return normalized === "" || normalized === "application/octet-stream";
};

/** The image type a file name's extension names (`photo.JPG` is `image/jpeg`), or none. */
export const inferImageMimeTypeFromName = (
  name: string
): Option.Option<string> => {
  const dot = name.lastIndexOf(".");

  return dot <= 0
    ? Option.none()
    : Record.get(
        IMAGE_MIME_TYPE_BY_EXTENSION,
        name.slice(dot + 1).toLowerCase()
      );
};

/** True for a HEIC or HEIF photo, by type or (when the type is generic) by extension. */
export const isHeicFile = (file: Pick<FileFacts, "name" | "type">): boolean =>
  HEIC_MIME_TYPE.test(file.type) ||
  (isGenericType(file.type) && HEIC_EXTENSION.test(file.name));

/**
 * The type to upload a file as: its own, or, when the browser gave none or a generic one, the
 * image type its extension names. Drags from other apps and files piped through a shell often
 * arrive without a type.
 */
export const attachmentMimeType = (
  file: Pick<FileFacts, "name" | "type">
): string => {
  const own = file.type.toLowerCase();

  return isGenericType(own)
    ? Option.getOrElse(inferImageMimeTypeFromName(file.name), () =>
        own === "" ? "application/octet-stream" : own
      )
    : own;
};

/** Whether a file is an image the model takes, an image it does not, or another file. */
export const classifyAttachmentFile = (
  file: Pick<FileFacts, "name" | "type">
): AttachmentFileKind => {
  if (isHeicFile(file)) {
    return "unsupported-image";
  }

  const mimeType = attachmentMimeType(file);

  if (!mimeType.startsWith("image/")) {
    return "file";
  }

  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
    ? "image"
    : "unsupported-image";
};

/**
 * Whether a paste's files are claimed as attachments rather than left to the default text paste:
 * any image claims it (a screenshot tool adds a caption), other files only when the clipboard holds
 * no plain text (a copy from a rich editor adds a synthetic file, and then the text is what the
 * user meant). An empty clipboard is never claimed.
 */
export const shouldHandleAttachmentPaste = (input: {
  readonly files: ReadonlyArray<Pick<FileFacts, "name" | "type">>;
  readonly plainText: string;
}): boolean => {
  if (input.files.some((file) => classifyAttachmentFile(file) !== "file")) {
    return true;
  }

  return input.plainText.length === 0 && input.files.length > 0;
};

/** One file the composer takes, by its position in the offered list. */
export interface AdmittedFile {
  readonly index: number;
  readonly kind: "image" | "file";
  readonly mimeType: string;
}

/** Which offered files the composer takes, and a sentence for each it refuses. */
export interface Admission {
  readonly admitted: ReadonlyArray<AdmittedFile>;
  readonly refusals: ReadonlyArray<string>;
}

const megabytes = (bytes: number): string =>
  `${Math.round(bytes / 1024 / 1024)} MB`;

const refusalFor = (
  file: FileFacts,
  kind: AttachmentFileKind,
  slotsLeft: number
): Option.Option<string> => {
  if (slotsLeft <= 0) {
    return Option.some(
      `${file.name}: a message holds at most ${MAX_ATTACHMENTS_PER_TURN} attachments.`
    );
  }

  if (kind === "unsupported-image") {
    return Option.some(
      isHeicFile(file)
        ? `${file.name}: HEIC photos are not supported. Export the photo as JPEG or PNG and attach it again.`
        : `${file.name}: attach images as PNG, JPEG, GIF or WebP.`
    );
  }

  if (attachmentMimeType(file).startsWith("video/")) {
    return Option.some(`${file.name}: videos are not supported.`);
  }

  if (file.size === 0) {
    return Option.some(`${file.name}: the file is empty.`);
  }

  return file.size > MAX_FILE_BYTES
    ? Option.some(
        `${file.name}: files over ${megabytes(MAX_FILE_BYTES)} are refused.`
      )
    : Option.none();
};

/**
 * Which files the composer stages, given how many the draft already holds, and why it refuses the
 * rest. Slots are counted while looping, so one batch cannot pass the limit. Images are checked
 * against the 10 MiB upload limit only after they are fitted, so a large photo is still taken.
 */
export const admitAttachmentFiles = (
  files: ReadonlyArray<FileFacts>,
  alreadyStaged: number
): Admission => {
  const admitted: Array<AdmittedFile> = [];
  const refusals: Array<string> = [];

  for (const [index, file] of files.entries()) {
    const kind = classifyAttachmentFile(file);

    const refusal = refusalFor(
      file,
      kind,
      MAX_ATTACHMENTS_PER_TURN - alreadyStaged - admitted.length
    );

    if (Option.isSome(refusal)) {
      refusals.push(refusal.value);
    } else {
      admitted.push({
        index,
        kind: kind === "image" ? "image" : "file",
        mimeType: attachmentMimeType(file),
      });
    }
  }

  return { admitted, refusals };
};

/** A prepared image above this is refused before upload, as the brain would refuse it. */
export const imageTooLarge = (sizeBytes: number): Option.Option<string> =>
  sizeBytes > MAX_IMAGE_BYTES
    ? Option.some(
        `Images over ${megabytes(MAX_IMAGE_BYTES)} are refused, even after fitting.`
      )
    : Option.none();

/** An image at most this large, already within the long edge, is uploaded as it is. */
export const SMALL_IMAGE_BYTES = 512 * 1024;

/** JPEG quality for a re-encoded image. */
export const IMAGE_JPEG_QUALITY = 0.85;

/** How to re-encode an image before upload. */
export interface ImageEncodePlan {
  readonly size: ImageSize;
  readonly mimeType: "image/png" | "image/jpeg";
  /** The encoder's quality, for JPEG; PNG ignores it. */
  readonly quality: number;
}

/**
 * Whether and how to re-encode an image before upload, from its type, pixel size and byte size.
 * None means upload it as it is: a GIF or WebP (re-encoding would drop animation or grow the
 * file), or a PNG or JPEG that already fits the long edge and is small. Otherwise the image is
 * fitted to the long edge and encoded as JPEG at 0.85, except a small PNG, which stays PNG so
 * screenshots of text keep their edges.
 */
export const imageEncodePlan = (image: {
  readonly mimeType: string;
  readonly size: ImageSize;
  readonly sizeBytes: number;
}): Option.Option<ImageEncodePlan> =>
  Option.flatMap(downscalableImageMimeType(image.mimeType), (mimeType) => {
    const fitted = fitImageAttachmentSize(image.size);
    const small = image.sizeBytes <= SMALL_IMAGE_BYTES;

    if (Option.isNone(fitted) && small) {
      return Option.none();
    }

    return Option.some({
      size: Option.getOrElse(fitted, () => image.size),
      mimeType: mimeType === "image/png" && small ? "image/png" : "image/jpeg",
      quality: IMAGE_JPEG_QUALITY,
    });
  });

/** An upload's progress as a whole percentage, `0%` to `100%`. */
export const formatUploadProgress = (progress: number): string => {
  const bounded = Math.max(
    0,
    Math.min(1, Number.isFinite(progress) ? progress : 0)
  );

  return `${Math.floor(bounded * 100)}%`;
};

/** A byte count as the tray shows it: `512 B`, `18 KB`, `2.4 MB`. */
export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
