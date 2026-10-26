// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerAttachmentFiles.test.ts
// and apps/web/src/lib/attachmentUploadState.test.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: the classification and paste-claim cases. Changed: HEIC is an unsupported image here
// (plan D32), so its cases expect a refusal; the cases for video previews, inline file chips and
// the server's upload capability are dropped with those features. Added: admission against Cairn's
// limits and the image encode plan.
// MIT License, Copyright (c) 2026 T3 Tools Inc.; the full notice is in AttachmentFiles.ts.

import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "@cairn/protocol/Attachments";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  admitAttachmentFiles,
  attachmentMimeType,
  classifyAttachmentFile,
  formatFileSize,
  formatUploadProgress,
  imageEncodePlan,
  imageTooLarge,
  inferImageMimeTypeFromName,
  shouldHandleAttachmentPaste,
  SMALL_IMAGE_BYTES,
} from "./AttachmentFiles.ts";

const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe("classifying attachment files", () => {
  it("keeps supported images on the image path", () => {
    assert.strictEqual(
      classifyAttachmentFile(file("photo.png", "image/png")),
      "image"
    );
    assert.strictEqual(
      classifyAttachmentFile(file("photo.webp", "image/webp")),
      "image"
    );
  });

  it("treats HEIC photos as unsupported images, by type or by extension", () => {
    assert.strictEqual(
      classifyAttachmentFile(file("photo.heic", "")),
      "unsupported-image"
    );
    assert.strictEqual(
      classifyAttachmentFile(file("photo.HEIF", "application/octet-stream")),
      "unsupported-image"
    );
    assert.strictEqual(
      classifyAttachmentFile(file("photo", "image/heic")),
      "unsupported-image"
    );
  });

  it("rejects unsupported image types instead of attaching them as generic files", () => {
    assert.strictEqual(
      classifyAttachmentFile(file("diagram.svg", "image/svg+xml")),
      "unsupported-image"
    );
    assert.strictEqual(
      classifyAttachmentFile(file("photo.tiff", "image/tiff")),
      "unsupported-image"
    );
    assert.strictEqual(
      classifyAttachmentFile(file("report.pdf", "application/pdf")),
      "file"
    );
  });

  it("falls back to the extension when an image arrives without a MIME type", () => {
    assert.strictEqual(classifyAttachmentFile(file("photo.jpg", "")), "image");
    assert.strictEqual(classifyAttachmentFile(file("shot.PNG", "")), "image");
    assert.strictEqual(classifyAttachmentFile(file("archive.zip", "")), "file");
    assert.strictEqual(
      classifyAttachmentFile(file("no-extension", "")),
      "file"
    );
    assert.deepStrictEqual(
      inferImageMimeTypeFromName("photo.jpg"),
      Option.some("image/jpeg")
    );
    assert.deepStrictEqual(
      inferImageMimeTypeFromName("archive.zip"),
      Option.none()
    );
    assert.deepStrictEqual(inferImageMimeTypeFromName(".png"), Option.none());
  });

  it("infers supported image types from octet-stream files", () => {
    const jpeg = file("photo.jpg", "application/octet-stream");
    const png = file("shot.PNG", "application/octet-stream");

    assert.strictEqual(classifyAttachmentFile(jpeg), "image");
    assert.strictEqual(classifyAttachmentFile(png), "image");
    assert.strictEqual(attachmentMimeType(jpeg), "image/jpeg");
    assert.strictEqual(attachmentMimeType(png), "image/png");
  });

  it("does not infer images for unknown extensions or specific conflicting MIME types", () => {
    const binary = file("archive.bin", "application/octet-stream");
    const unknownDocument = file("report.pdf", "application/octet-stream");
    const document = file("photo.jpg", "application/pdf");
    const explicitImage = file("photo.jpg", "image/png");

    assert.strictEqual(classifyAttachmentFile(binary), "file");
    assert.strictEqual(classifyAttachmentFile(unknownDocument), "file");
    assert.strictEqual(classifyAttachmentFile(document), "file");
    assert.strictEqual(classifyAttachmentFile(explicitImage), "image");
    assert.strictEqual(attachmentMimeType(binary), "application/octet-stream");
    assert.strictEqual(attachmentMimeType(document), "application/pdf");
    assert.strictEqual(attachmentMimeType(explicitImage), "image/png");
    assert.strictEqual(
      attachmentMimeType(file("notes", "")),
      "application/octet-stream"
    );
  });
});

describe("claiming a paste", () => {
  it("preserves text paste when an application adds a synthetic generic file", () => {
    assert.isFalse(
      shouldHandleAttachmentPaste({
        files: [file("clipboard.rtf", "application/rtf")],
        plainText: "Copied text",
      })
    );
  });

  it("claims unsupported image pastes so the composer can report them", () => {
    for (const image of [
      file("diagram.svg", "image/svg+xml"),
      file("photo.tiff", "image/tiff"),
    ]) {
      assert.isTrue(
        shouldHandleAttachmentPaste({
          files: [image],
          plainText: "Image caption",
        })
      );
    }
  });

  it("claims generic file-only pastes so the composer can report validation errors", () => {
    assert.isTrue(
      shouldHandleAttachmentPaste({
        files: [file("report.pdf", "application/pdf")],
        plainText: "",
      })
    );
    assert.isTrue(
      shouldHandleAttachmentPaste({
        files: [file("empty.txt", "text/plain", 0)],
        plainText: "",
      })
    );
  });

  it("ignores an empty clipboard", () => {
    assert.isFalse(shouldHandleAttachmentPaste({ files: [], plainText: "" }));
    assert.isFalse(
      shouldHandleAttachmentPaste({ files: [], plainText: "just text" })
    );
  });

  it("claims image pastes even when clipboard text is present", () => {
    assert.isTrue(
      shouldHandleAttachmentPaste({
        files: [file("photo.heic", "image/heic")],
        plainText: "Image caption",
      })
    );
    assert.isTrue(
      shouldHandleAttachmentPaste({
        files: [file("image.png", "image/png")],
        plainText: "Image caption",
      })
    );
  });
});

describe("admitting files", () => {
  it("takes images, documents and text, keeping their positions", () => {
    const admission = admitAttachmentFiles(
      [
        file("shot.png", "image/png"),
        file("report.pdf", "application/pdf"),
        file("notes.md", "text/markdown"),
        file("photo.jpg", ""),
      ],
      0
    );

    assert.deepStrictEqual(admission, {
      admitted: [
        { index: 0, kind: "image", mimeType: "image/png" },
        { index: 1, kind: "file", mimeType: "application/pdf" },
        { index: 2, kind: "file", mimeType: "text/markdown" },
        { index: 3, kind: "image", mimeType: "image/jpeg" },
      ],
      refusals: [],
    });
  });

  it("refuses HEIC, other image types, video, empty and oversized files with a reason", () => {
    const admission = admitAttachmentFiles(
      [
        file("photo.heic", ""),
        file("diagram.svg", "image/svg+xml"),
        file("clip.mov", "video/quicktime"),
        file("empty.txt", "text/plain", 0),
        file("huge.pdf", "application/pdf", MAX_FILE_BYTES + 1),
        file("ok.pdf", "application/pdf", MAX_FILE_BYTES),
      ],
      0
    );

    assert.deepStrictEqual(
      admission.admitted.map(({ index }) => index),
      [5]
    );
    assert.deepStrictEqual(admission.refusals, [
      "photo.heic: HEIC photos are not supported. Export the photo as JPEG or PNG and attach it again.",
      "diagram.svg: attach images as PNG, JPEG, GIF or WebP.",
      "clip.mov: videos are not supported.",
      "empty.txt: the file is empty.",
      "huge.pdf: files over 50 MB are refused.",
    ]);
  });

  it("counts slots while looping, so one batch cannot pass the limit", () => {
    const batch = [
      file("a.png", "image/png"),
      file("b.png", "image/png"),
      file("c.png", "image/png"),
    ];

    const admission = admitAttachmentFiles(batch, MAX_ATTACHMENTS_PER_TURN - 2);

    assert.deepStrictEqual(
      admission.admitted.map(({ index }) => index),
      [0, 1]
    );
    assert.deepStrictEqual(admission.refusals, [
      `c.png: a message holds at most ${MAX_ATTACHMENTS_PER_TURN} attachments.`,
    ]);
  });

  it("refuses a prepared image over the upload limit", () => {
    assert.isTrue(Option.isNone(imageTooLarge(MAX_IMAGE_BYTES)));
    assert.isTrue(Option.isSome(imageTooLarge(MAX_IMAGE_BYTES + 1)));
  });
});

describe("the image encode plan", () => {
  it("uploads a small image that already fits as it is", () => {
    assert.deepStrictEqual(
      imageEncodePlan({
        mimeType: "image/png",
        size: { width: 800, height: 600 },
        sizeBytes: SMALL_IMAGE_BYTES,
      }),
      Option.none()
    );
  });

  it("fits a phone screenshot to the long edge as JPEG at 0.85", () => {
    assert.deepStrictEqual(
      imageEncodePlan({
        mimeType: "image/png",
        size: { width: 1170, height: 2532 },
        sizeBytes: 1_400_000,
      }),
      Option.some({
        size: { width: 725, height: 1568 },
        mimeType: "image/jpeg",
        quality: 0.85,
      })
    );
  });

  it("keeps a small PNG as PNG when it only needs fitting", () => {
    assert.deepStrictEqual(
      imageEncodePlan({
        mimeType: "image/png",
        size: { width: 3000, height: 1000 },
        sizeBytes: 200_000,
      }),
      Option.some({
        size: { width: 1568, height: 523 },
        mimeType: "image/png",
        quality: 0.85,
      })
    );
  });

  it("re-encodes a large image that already fits, to shrink it", () => {
    assert.deepStrictEqual(
      imageEncodePlan({
        mimeType: "image/jpeg",
        size: { width: 1200, height: 900 },
        sizeBytes: 3_000_000,
      }),
      Option.some({
        size: { width: 1200, height: 900 },
        mimeType: "image/jpeg",
        quality: 0.85,
      })
    );
  });

  it("leaves GIF and WebP alone, whatever their size", () => {
    for (const mimeType of ["image/gif", "image/webp"]) {
      assert.deepStrictEqual(
        imageEncodePlan({
          mimeType,
          size: { width: 4000, height: 3000 },
          sizeBytes: 5_000_000,
        }),
        Option.none()
      );
    }
  });
});

describe("formatting", () => {
  it("formats upload progress as a floored, bounded percentage", () => {
    assert.strictEqual(formatUploadProgress(0), "0%");
    assert.strictEqual(formatUploadProgress(0.996), "99%");
    assert.strictEqual(formatUploadProgress(1.4), "100%");
    assert.strictEqual(formatUploadProgress(-1), "0%");
    assert.strictEqual(formatUploadProgress(Number.NaN), "0%");
  });

  it("formats sizes in bytes, kilobytes and megabytes", () => {
    assert.strictEqual(formatFileSize(512), "512 B");
    assert.strictEqual(formatFileSize(18 * 1024), "18 KB");
    assert.strictEqual(formatFileSize(2.4 * 1024 * 1024), "2.4 MB");
  });
});
