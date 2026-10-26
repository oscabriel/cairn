// Text extraction in its worker: a text PDF keeps its pages in order, a two-column page keeps both
// columns, a PDF with no text layer answers empty text, a DOCX is read, a ZIP bomb DOCX is refused
// before `mammoth` opens it, a damaged PDF is unreadable, and an extraction past its deadline ends
// with its worker terminated.

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { makeDocx, makeDocxBomb, makePdf } from "./AttachmentsTestKit.ts";
import { ExtractTimeout, TextExtract } from "./TextExtract.ts";

const extract = (kind: "pdf" | "docx", bytes: Uint8Array) =>
  TextExtract.use((extractor) => extractor.extract(kind, bytes)).pipe(
    Effect.provide(TextExtract.layer)
  );

describe("text extraction", () => {
  it.live("reads a text PDF page by page, with page markers", () =>
    Effect.gen(function* () {
      const pdf = makePdf([
        [{ x: 72, y: 700, text: "first page alpha" }],
        [{ x: 72, y: 700, text: "second page bravo" }],
        [{ x: 72, y: 700, text: "third page charlie" }],
      ]);

      const result = yield* extract("pdf", pdf);

      assert.deepStrictEqual(result.pages, Option.some(3));
      assert.isFalse(result.truncated);
      assert.strictEqual(
        result.text,
        "--- Page 1 of 3 ---\nfirst page alpha\n\n--- Page 2 of 3 ---\nsecond page bravo\n\n--- Page 3 of 3 ---\nthird page charlie"
      );
    })
  );

  it.live("keeps both columns of a two-column page", () =>
    Effect.gen(function* () {
      const pdf = makePdf([
        [
          { x: 72, y: 700, text: "left column one" },
          { x: 320, y: 700, text: "right column one" },
          { x: 72, y: 680, text: "left column two" },
          { x: 320, y: 680, text: "right column two" },
        ],
      ]);

      const { text } = yield* extract("pdf", pdf);

      for (const words of [
        "left column one",
        "right column one",
        "left column two",
        "right column two",
      ]) {
        assert.include(text, words);
      }

      assert.isBelow(
        text.indexOf("left column one"),
        text.indexOf("left column two")
      );
    })
  );

  it.live("answers empty text for a PDF with no text layer", () =>
    Effect.gen(function* () {
      const result = yield* extract("pdf", makePdf([[], []]));

      assert.strictEqual(result.text, "");
      assert.deepStrictEqual(result.pages, Option.some(2));
    })
  );

  it.live("reads a DOCX", () =>
    Effect.gen(function* () {
      const result = yield* extract(
        "docx",
        makeDocx(["Quarterly notes", "nonce kestrel-417"])
      );

      assert.include(result.text, "Quarterly notes");
      assert.include(result.text, "nonce kestrel-417");
      assert.deepStrictEqual(result.pages, Option.none());
    })
  );

  it.live("refuses a ZIP bomb DOCX before reading it", () =>
    Effect.gen(function* () {
      const bomb = makeDocxBomb(60 * 1024 * 1024);

      assert.isBelow(bomb.length, 1024 * 1024);

      const failure = yield* Effect.flip(extract("docx", bomb));

      assert.strictEqual(failure.reason, "too_large");
      assert.include(failure.message, "50 MiB");
    })
  );

  it.live("calls a damaged PDF unreadable", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        extract("pdf", new TextEncoder().encode("%PDF-1.4\nnot a pdf at all"))
      );

      assert.strictEqual(failure.reason, "unreadable");
    })
  );

  it.effect("stops an extraction that outlasts its deadline", () =>
    Effect.gen(function* () {
      const fiber = yield* extract(
        "pdf",
        makePdf([[{ x: 72, y: 700, text: "slow" }]])
      ).pipe(
        Effect.provideService(ExtractTimeout, Duration.seconds(15)),
        Effect.flip,
        Effect.forkChild
      );

      // The worker cannot answer before the clock moves: the test clock passes 15 s at once.
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(16));

      const failure = yield* Fiber.join(fiber);

      assert.strictEqual(failure.reason, "timeout");
    })
  );
});
