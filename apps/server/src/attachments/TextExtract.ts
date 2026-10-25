// Reads a document's text at upload time (plan D33): a PDF through `unpdf`, a DOCX through
// `mammoth`, each in a fresh `worker_threads` worker (`ExtractWorker.ts`) with a 512 MiB heap and a
// 15 s deadline, so a hostile file can cost one thread and never the brain. The worker is
// terminated on success, failure, timeout and interruption alike. The caller writes the text to
// `<id>.txt`, where an agent can page through it with `read`.
import { Worker } from "node:worker_threads";

import {
  Context,
  Duration,
  Effect,
  flow,
  Layer,
  Predicate,
  Schema,
} from "effect";

import {
  ExtractAnswer,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  MAX_EXTRACT_CHARS,
  MAX_EXTRACT_PAGES,
} from "./ExtractJob.ts";
import type { Extracted, ExtractJob } from "./ExtractJob.ts";

/** How long one extraction may run before its worker is terminated. */
export const ExtractTimeout = Context.Reference<Duration.Duration>(
  "cairn/server/attachments/TextExtract/ExtractTimeout",
  { defaultValue: () => Duration.seconds(15) }
);

/** The heap one extraction worker may use. */
const WORKER_HEAP_MB = 512;

const WORKER_URL = new URL("ExtractWorker.ts", import.meta.url);

/** A document's text could not be read. The message says why and what to attach instead. */
export class ExtractError extends Schema.TaggedError<ExtractError>()(
  "ExtractError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      /** Past the 15 s deadline; the worker was terminated. */
      "timeout",
      /** A DOCX that unpacks past 50 MiB. */
      "too_large",
      /** The reader could not parse the file. */
      "unreadable",
      /** The worker died (out of memory, a crash in a reader). */
      "crashed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const decodeAnswer = Schema.decodeUnknownEffect(ExtractAnswer);

/** The worker answered something that is not an `ExtractAnswer`. */
const garbled = (cause: Schema.SchemaError) =>
  new ExtractError({
    message:
      "TextExtract's worker answered something it does not understand. Report this; attach the document again meanwhile.",
    reason: "crashed",
    cause,
  });

/** Runs `job` in a new worker and waits for its one answer. */
const runWorker = (job: ExtractJob) =>
  Effect.acquireUseRelease(
    Effect.sync(
      () =>
        new Worker(WORKER_URL, {
          workerData: job,
          resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
          // The worker's console goes to the brain's own output, the journal: piped streams
          // nobody read would fill and hold memory (T53).
        })
    ),
    (worker) =>
      Effect.callback<ExtractAnswer, ExtractError>((resume) => {
        worker.once(
          "message",
          flow(decodeAnswer, Effect.mapError(garbled), resume)
        );
        worker.once("error", (cause) => {
          resume(
            Effect.fail(
              new ExtractError({
                message:
                  "TextExtract's worker failed while reading the document; it may be too large or damaged. Attach a smaller file or a PDF of it.",
                reason: "crashed",
                cause,
              })
            )
          );
        });
        worker.once("exit", (code) => {
          resume(
            Effect.fail(
              new ExtractError({
                message: `TextExtract's worker exited (code ${String(code)}) without an answer. Attach the document again, or a smaller one.`,
                reason: "crashed",
              })
            )
          );
        });
      }),
    (worker) => Effect.promise(async () => await worker.terminate())
  );

/** Reads the text of PDFs and DOCX files. */
export class TextExtract extends Context.Service<
  TextExtract,
  {
    /**
     * The document's text, with PDF page boundaries kept, at most 500 pages and 2,000,000
     * characters (`truncated` says when more was left out). A PDF with no text layer answers empty
     * text. Fails with `ExtractError` on a timeout, a DOCX over 50 MiB unpacked, a file the reader
     * cannot parse, or a worker crash.
     */
    extract(
      kind: "pdf" | "docx",
      bytes: Uint8Array
    ): Effect.Effect<Extracted, ExtractError>;
  }
>()("cairn/server/attachments/TextExtract") {
  /** Extraction in worker threads, one per document. */
  static readonly layer = Layer.succeed(
    TextExtract,
    TextExtract.of({
      extract: Effect.fn("TextExtract.extract")(function* (
        kind: "pdf" | "docx",
        bytes: Uint8Array
      ) {
        const timeout = yield* ExtractTimeout;

        const answer = yield* runWorker({
          kind,
          bytes,
          maxPages: MAX_EXTRACT_PAGES,
          maxChars: MAX_EXTRACT_CHARS,
          maxDocxBytes: MAX_DOCX_UNCOMPRESSED_BYTES,
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new ExtractError({
                  message: `TextExtract stopped reading the document after ${Duration.format(timeout)}. Attach a smaller document, or a PDF with fewer pages.`,
                  reason: "timeout",
                })
              ),
          })
        );

        if (Predicate.isTagged(answer, "ExtractRefused")) {
          return yield* new ExtractError({
            message: answer.message,
            reason: answer.reason,
          });
        }

        return answer;
      }),
    })
  );
}
