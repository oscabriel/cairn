// Ported from github.com/pingdotgg/t3code, packages/contracts/src/{chatAttachment.ts, assets.ts}
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (limits, the image types, the signed upload URL and its
// ten-minute lifetime), from packages/provider-core/src/server/attachmentPrompt.ts at the same
// commit (the path line, `providerMessageTextWithAttachmentPaths`), and from cairn-v1,
// packages/protocol/src/attachment.ts at 1a5cd4a (`attachmentText` and its parser). Changed:
// Cairn's limits (20 attachments, documents up to 50 MiB, 40,000 inline characters), upload claims
// for the server's signed token, the text block names the file's full-text path, and the path line
// has a parser, so the transcript can show the user's words without it.
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
import { Option, Schema } from "effect";

import { AttachmentId, PositiveInt, TrimmedNonEmptyString } from "./Ids.ts";

/** The most attachments one turn may carry. */
export const MAX_ATTACHMENTS_PER_TURN = 20;

/** The largest image a client may upload; the client fits images to 1,568 px before upload. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The largest document or other file a client may upload. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Characters of one attachment's text placed inline in the turn; the rest stays in its `.txt` file. */
export const MAX_INLINE_CHARS_PER_ATTACHMENT = 40_000;

/** Characters of attachment text one turn may carry inline in total. */
export const MAX_INLINE_CHARS_PER_TURN = 120_000;

/** How long a signed upload URL stays valid. */
export const UPLOAD_URL_TTL_MILLIS = 10 * 60_000;

/** The long edge, in pixels, images are fitted to on the client and again on the server. */
export const IMAGE_FIT_LONG_EDGE = 1568;

/** Image types the model takes as image content. HEIC is refused; iOS converts to JPEG. */
export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** How the brain prepared an attachment, decided from its bytes, never from its name. */
export const AttachmentKind = Schema.Literals([
  "image",
  "text",
  "pdf",
  "docx",
  "file",
]);

export type AttachmentKind = typeof AttachmentKind.Type;

const AttachmentName = TrimmedNonEmptyString.check(Schema.isMaxLength(255));

const MimeType = TrimmedNonEmptyString.check(Schema.isMaxLength(100));

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** `attachments.createUploadUrl` input: what the client is about to upload. */
export const CreateUploadUrlInput = Schema.Struct({
  /** The file's own name. Display only: the server never uses it as a path. */
  name: AttachmentName,
  mimeType: MimeType,
  sizeBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_FILE_BYTES)),
  /** Milliseconds from the paste to this request, measured on the page; telemetry only. */
  pasteToRequestMs: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
});

export type CreateUploadUrlInput = typeof CreateUploadUrlInput.Type;

/** `attachments.createUploadUrl` result: a one-shot URL to `POST` the raw bytes to. */
export const CreateUploadUrlResult = Schema.Struct({
  attachmentId: AttachmentId,
  /** A same-origin path, `/api/attachments/upload/<token>`. */
  uploadPath: Schema.String.check(
    Schema.isPattern(/^\/api\/attachments\/upload\/[A-Za-z0-9._-]+$/u)
  ),
  expiresAt: Schema.DateTimeUtc,
});

export type CreateUploadUrlResult = typeof CreateUploadUrlResult.Type;

/** What the signed upload token asserts. The server signs it and checks every field on upload. */
export const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("attachment-upload"),
  attachmentId: AttachmentId,
  name: AttachmentName,
  mimeType: MimeType,
  sizeBytes: PositiveInt,
  expiresAt: Schema.DateTimeUtc,
});

export type UploadClaims = typeof UploadClaims.Type;

/** An uploaded, prepared attachment. The upload answers with it, and turns and entries carry it. */
export const AttachmentRef = Schema.Struct({
  id: AttachmentId,
  name: AttachmentName,
  /** The type detected from the bytes. */
  mimeType: MimeType,
  sizeBytes: PositiveInt,
  kind: AttachmentKind,
  sha256: Sha256,
});

export type AttachmentRef = typeof AttachmentRef.Type;

/** `attachments.discard` input: an upload the user removed before sending. */
export const DiscardAttachmentInput = Schema.Struct({
  attachmentId: AttachmentId,
});

export type DiscardAttachmentInput = typeof DiscardAttachmentInput.Type;

/** A text attachment as the model saw it, recovered by `parseAttachmentText`. */
export interface AttachmentTextParts {
  readonly name: string;
  readonly mimeType: string;
  /** The absolute path of the attachment's full text on the Beelink. */
  readonly path: string;
  readonly text: string;
}

const FOOTER = "\n</attachment>";

const HEADER =
  /^<attachment name="(?<name>[^"\n]*)" type="(?<mimeType>[^"\n]*)" path="(?<path>[^"\n]*)">\n/u;

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "&#10;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const unescapeAttribute = (value: string) =>
  value
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&#10;", "\n")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/**
 * A text or document attachment as the model sees it: one block naming the file, its type and the
 * path of its full text, then the (possibly truncated) text. The transcript recognizes the block
 * with `parseAttachmentText` and shows a chip instead.
 */
export const attachmentText = (parts: AttachmentTextParts): string =>
  `<attachment name="${escapeAttribute(parts.name)}" type="${escapeAttribute(parts.mimeType)}" path="${escapeAttribute(parts.path)}">\n${parts.text}${FOOTER}`;

/** The reverse of `attachmentText`; none for any other text. */
export const parseAttachmentText = (
  value: string
): Option.Option<AttachmentTextParts> => {
  const match = HEADER.exec(value);

  if (match === null || !value.endsWith(FOOTER)) {
    return Option.none();
  }

  const { name = "", mimeType = "", path = "" } = match.groups ?? {};
  const [header] = match;

  return Option.some({
    name: unescapeAttribute(name),
    mimeType: unescapeAttribute(mimeType),
    path: unescapeAttribute(path),
    text: value.slice(header.length, value.length - FOOTER.length),
  });
};

/** What `attachmentPathLine` says: one attachment and where its original is saved. */
export interface AttachmentPathLineParts {
  /** `image` for images, `file` for every other attachment the line is written for. */
  readonly kind: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly path: string;
  /** Words after the path, inside the brackets, such as how to open the file; empty for none. */
  readonly note: string;
}

/** What `parseAttachmentPathLine` recovers from a path line. */
export interface AttachmentPathLineName {
  readonly kind: "image" | "file";
  readonly name: string;
}

const kibibytes = (bytes: number) =>
  `${(bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 0 })} KB`;

// Anchored on the opening `[Attached image|file "` and the closing `]`, so it also reads lines a
// brain wrote before the template moved here (their path ends at the attachment's folder).
const PATH_LINE =
  /^\[Attached (?<kind>image|file) "(?<name>[^\n]*)" \([^\n]*\) is saved at: [^\n]*\]$/u;

/**
 * The line that tells the model where an attachment's original is, a text part of its own after
 * the attachment's content. The transcript drops it with `parseAttachmentPathLine`.
 */
export const attachmentPathLine = (parts: AttachmentPathLineParts): string =>
  `[Attached ${parts.kind} "${parts.name}" (${parts.mimeType}, ${kibibytes(parts.sizeBytes)}) is saved at: ${parts.path}${parts.note}]`;

/** The attachment a path line names; none for any other text, including a line inside other words. */
export const parseAttachmentPathLine = (
  value: string
): Option.Option<AttachmentPathLineName> => {
  const groups = PATH_LINE.exec(value)?.groups;

  if (groups === undefined) {
    return Option.none();
  }

  return Option.some({
    kind: groups.kind === "image" ? "image" : "file",
    name: groups.name ?? "",
  });
};

/**
 * True for a text part the brain added to a user turn for its attachments: an `attachmentText`
 * block or an `attachmentPathLine`. Whatever shows the user's own words drops these parts.
 */
export const isAddedUserPart = (text: string): boolean =>
  Option.isSome(parseAttachmentText(text)) ||
  Option.isSome(parseAttachmentPathLine(text));
