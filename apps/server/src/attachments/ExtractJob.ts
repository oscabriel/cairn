// What `TextExtract` hands its worker thread and what the worker answers: the two ends of one
// `worker_threads` message each way, as schemas both sides decode. Kept apart from the worker's
// entry module so the brain's thread never loads the PDF and DOCX readers.
import { Schema } from "effect";

/** The pages a PDF is read to; later pages are left in the original. */
export const MAX_EXTRACT_PAGES = 500;

/** The characters one extraction keeps; the rest is left in the original. */
export const MAX_EXTRACT_CHARS = 2_000_000;

/** The uncompressed size a DOCX's central directory may claim before it is refused unread. */
export const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

/** One extraction job. */
export const ExtractJob = Schema.Struct({
  kind: Schema.Literals(["pdf", "docx"]),
  /** The document's bytes; the worker reads its own copy. */
  bytes: Schema.Uint8Array,
  maxPages: Schema.Int,
  maxChars: Schema.Int,
  maxDocxBytes: Schema.Int,
});

/** One extraction job. */
export type ExtractJob = typeof ExtractJob.Type;

/** The document's text. */
export const Extracted = Schema.TaggedStruct("Extracted", {
  text: Schema.String,
  /** A PDF's page count (all of them, read or not); none for a DOCX. */
  pages: Schema.OptionFromNullOr(Schema.Int),
  /** True when pages or characters past the caps were left out. */
  truncated: Schema.Boolean,
});

/** The document's text. */
export type Extracted = typeof Extracted.Type;

/** The document was not read; the message says why and what to attach instead. */
export const ExtractRefused = Schema.TaggedStruct("ExtractRefused", {
  reason: Schema.Literals(["too_large", "unreadable"]),
  message: Schema.String,
});

/** The worker's answer. */
export const ExtractAnswer = Schema.Union([Extracted, ExtractRefused]);

/** The worker's answer. */
export type ExtractAnswer = typeof ExtractAnswer.Type;
