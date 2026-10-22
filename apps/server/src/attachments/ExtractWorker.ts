// The worker thread that reads a document's text, so a hostile or huge file costs a thread with a
// 512 MiB heap and a 15 s deadline (both set by `TextExtract`) instead of the brain. PDFs go through
// `unpdf` on a copy of the bytes (pdf.js transfers the buffer it is given), one page at a time so
// page boundaries survive as `--- Page N of M ---` lines. The pdf.js that unpdf 1.9.1 bundles has
// no font-eval path left (no `isEvalSupported` option, no `new Function` or `eval`), which closes
// CVE-2024-4367; XFA forms stay off. A DOCX goes through `mammoth` only after its central directory
// claims at most 50 MiB uncompressed. Both stop at 500 pages and 2,000,000 characters and say so.
//
// The worker reads one `ExtractJob` from `workerData`, posts one encoded `ExtractAnswer` and ends.
import { parentPort, workerData } from "node:worker_threads";

import { Effect, Option, Schema } from "effect";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

import {
  ExtractAnswer,
  Extracted,
  ExtractJob,
  ExtractRefused,
} from "./ExtractJob.ts";
import { readZipDirectory } from "./ZipDirectory.ts";

/** A reader threw: the document is damaged or not what its bytes claimed. */
class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const decodeJob = Schema.decodeUnknownEffect(ExtractJob);

const encodeAnswer = Schema.encodeEffect(ExtractAnswer);

/** Text pieces kept so far, stopping at `maxChars`. */
interface Collected {
  readonly parts: Array<string>;
  chars: number;
  truncated: boolean;
}

const collect = (collected: Collected, text: string, maxChars: number) => {
  const room = maxChars - collected.chars;

  if (text.length > room) {
    collected.parts.push(text.slice(0, Math.max(0, room)));
    collected.chars = maxChars;
    collected.truncated = true;

    return;
  }

  collected.parts.push(text);
  collected.chars += text.length;
};

const readFailed = (what: string) => (cause: unknown) =>
  new ReadFailed({ message: `ExtractWorker could not ${what}`, cause });

const extractPdf = Effect.fnUntraced(function* (job: ExtractJob) {
  const pdf = yield* Effect.tryPromise({
    try: async () =>
      await getDocumentProxy(new Uint8Array(job.bytes), {
        enableXfa: false,
        isOffscreenCanvasSupported: false,
      }),
    catch: readFailed("open the PDF"),
  });

  const total = pdf.numPages;
  const read = Math.min(total, job.maxPages);
  const pages: Array<string> = [];

  for (let number = 1; number <= read; number += 1) {
    const content = yield* Effect.tryPromise({
      try: async () => {
        const page = await pdf.getPage(number);

        return await page.getTextContent();
      },
      catch: readFailed(`read page ${String(number)} of the PDF`),
    });

    let text = "";

    for (const item of content.items) {
      if ("str" in item) {
        text += item.hasEOL ? `${item.str}\n` : item.str;
      }
    }

    pages.push(text);
  }

  // A PDF whose pages carry no text (a scan) answers empty text, which the stage says plainly.
  if (pages.every((text) => text.trim() === "")) {
    return Extracted.make({
      text: "",
      pages: Option.some(total),
      truncated: read < total,
    });
  }

  const collected: Collected = { parts: [], chars: 0, truncated: false };

  for (const [index, text] of pages.entries()) {
    if (collected.truncated) {
      break;
    }

    collect(
      collected,
      `${index === 0 ? "" : "\n\n"}--- Page ${String(index + 1)} of ${String(total)} ---\n${text.trim()}`,
      job.maxChars
    );
  }

  return Extracted.make({
    text: collected.parts.join(""),
    pages: Option.some(total),
    truncated: collected.truncated || read < total,
  });
});

const extractDocx = Effect.fnUntraced(function* (job: ExtractJob) {
  const entries = readZipDirectory(job.bytes);

  if (Option.isNone(entries)) {
    return ExtractRefused.make({
      reason: "unreadable",
      message:
        "ExtractWorker could not read the DOCX: its ZIP directory is missing or damaged. Save it again from Word and attach it.",
    });
  }

  const claimed = entries.value.reduce(
    (sum, entry) => sum + entry.uncompressedSize,
    0
  );

  if (claimed > job.maxDocxBytes) {
    return ExtractRefused.make({
      reason: "too_large",
      message: `ExtractWorker refused the DOCX: it unpacks to ${String(Math.round(claimed / 1024 / 1024))} MiB, over the 50 MiB limit. Attach a smaller document or a PDF of it.`,
    });
  }

  const result = yield* Effect.tryPromise({
    try: async () =>
      await mammoth.extractRawText({ buffer: Buffer.from(job.bytes) }),
    catch: readFailed("read the DOCX"),
  });

  const collected: Collected = { parts: [], chars: 0, truncated: false };

  collect(collected, result.value.trim(), job.maxChars);

  return Extracted.make({
    text: collected.parts.join(""),
    pages: Option.none(),
    truncated: collected.truncated,
  });
});

const run = Effect.gen(function* () {
  const job = yield* decodeJob(workerData);

  const answer = yield* (
    job.kind === "pdf" ? extractPdf(job) : extractDocx(job)
  ).pipe(
    Effect.catchTag("ReadFailed", (failure) =>
      Effect.succeed(
        ExtractRefused.make({
          reason: "unreadable",
          message: `${failure.message}: ${String(failure.cause)}. The file may be damaged or protected; attach another copy.`,
        })
      )
    )
  );

  const encoded = yield* encodeAnswer(answer);

  parentPort?.postMessage(encoded, []);
});

// The worker's whole life: one job, one answer. A defect ends the thread with an error event,
// which `TextExtract` reports as a crash.
await Effect.runPromise(run);
