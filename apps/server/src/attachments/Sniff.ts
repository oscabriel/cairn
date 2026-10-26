// What an uploaded file is, decided from its bytes and never from its name or the type the client
// claimed: a PNG, JPEG, GIF or WebP image; a PDF; a DOCX (a ZIP holding `word/document.xml`); an
// XLSX or PPTX, kept as a file the agent opens with a tool; or strict UTF-8 text with no NUL. HEIC
// and video (an ISO `ftyp` box) are refused with a plain message, because iOS converts photos to
// JPEG when they are picked or pasted (plan D32). Anything else is refused. Pure.
//
// Ported from cairn-v1, apps/server/src/Files.ts at 1a5cd4a (`sniff`). Changed: PDF, DOCX and the
// Office files that stay files, the text type taken from the client when it names a text format,
// and a refusal that names what to attach instead.

import { Option } from "effect";

import { looksLikeZip, readZipDirectory } from "./ZipDirectory.ts";

/** The DOCX media type. */
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Media types besides `text/*` whose bytes are text, kept when the client names one. */
const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/sql",
  "application/x-ndjson",
]);

/** What the bytes are, or why they were refused. */
export type Sniffed =
  | {
      readonly kind: "image";
      readonly mimeType:
        | "image/png"
        | "image/jpeg"
        | "image/gif"
        | "image/webp";
    }
  | { readonly kind: "pdf"; readonly mimeType: "application/pdf" }
  | { readonly kind: "docx"; readonly mimeType: typeof DOCX_MIME_TYPE }
  | { readonly kind: "file"; readonly mimeType: string }
  | { readonly kind: "text"; readonly mimeType: string }
  | { readonly kind: "refused"; readonly message: string };

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  bytes.length >= at + prefix.length &&
  prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) =>
  Array.from(text, (character) => character.codePointAt(0) ?? 0);

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as text when they are strict UTF-8 with no NUL; none otherwise. */
export const decodeText = (bytes: Uint8Array): Option.Option<string> => {
  const text = Option.liftThrowable(() => strictUtf8.decode(bytes))();

  return Option.filter(text, (value) => !value.includes("\u0000"));
};

/** The client's type without parameters, lowercased. */
const bareType = (mimeType: string) =>
  (mimeType.split(";")[0] ?? "").trim().toLowerCase();

const textType = (claimed: string) => {
  const bare = bareType(claimed);

  return bare.startsWith("text/") || TEXT_APPLICATION_TYPES.has(bare)
    ? bare
    : "text/plain";
};

const REFUSED_HEIC =
  "HEIC photos and videos cannot be attached. Attach the photo as JPEG or PNG; iOS converts photos when you pick or paste them.";

const REFUSED_ARCHIVE =
  "This archive is not a document Cairn reads. Attach DOCX, XLSX or PPTX files, PDFs, images or text, or unpack the archive first.";

const REFUSED_BINARY =
  "This file type cannot be attached. Attach a PNG, JPEG, GIF or WebP image, a PDF, a DOCX, XLSX or PPTX file, or UTF-8 text.";

const sniffZip = (bytes: Uint8Array): Sniffed => {
  const entries = Option.getOrElse(readZipDirectory(bytes), () => []);
  const has = (name: string) => entries.some((entry) => entry.name === name);

  const under = (prefix: string) =>
    entries.some((entry) => entry.name.startsWith(prefix));

  if (has("word/document.xml")) {
    return { kind: "docx", mimeType: DOCX_MIME_TYPE };
  }

  if (under("xl/")) {
    return { kind: "file", mimeType: XLSX_MIME_TYPE };
  }

  if (under("ppt/")) {
    return { kind: "file", mimeType: PPTX_MIME_TYPE };
  }

  return { kind: "refused", message: REFUSED_ARCHIVE };
};

/**
 * What `bytes` (a whole upload) are. `claimedMimeType` is consulted only to name a text file's
 * format (`text/markdown`, `application/json`); it never makes bytes count as text.
 */
export const sniff = (bytes: Uint8Array, claimedMimeType: string): Sniffed => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mimeType: "image/png" };
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mimeType: "image/jpeg" };
  }

  if (
    startsWith(bytes, ascii("GIF87a")) ||
    startsWith(bytes, ascii("GIF89a"))
  ) {
    return { kind: "image", mimeType: "image/gif" };
  }

  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return { kind: "image", mimeType: "image/webp" };
  }

  if (startsWith(bytes, ascii("%PDF-"))) {
    return { kind: "pdf", mimeType: "application/pdf" };
  }

  if (startsWith(bytes, ascii("ftyp"), 4)) {
    return { kind: "refused", message: REFUSED_HEIC };
  }

  if (looksLikeZip(bytes)) {
    return sniffZip(bytes);
  }

  return Option.match(decodeText(bytes), {
    onNone: (): Sniffed => ({ kind: "refused", message: REFUSED_BINARY }),
    onSome: (): Sniffed => ({
      kind: "text",
      mimeType: textType(claimedMimeType),
    }),
  });
};
