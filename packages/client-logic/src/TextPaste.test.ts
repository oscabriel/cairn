// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/textPaste.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: plain parameters instead of option objects.
// MIT License, Copyright (c) 2026 T3 Tools Inc.; the full notice is in TextPaste.ts.
import { assert, describe, it } from "@effect/vitest";

import {
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  pastedTextDisposition,
  replaceTextSelection,
  utf8ByteLength,
  wouldTextPasteExceedLimit,
} from "./TextPaste.ts";

const facts = {
  canAttach: true,
  bypassAutoAttachment: false,
  wouldExceedInputLimit: false,
};

describe("pasted text disposition", () => {
  it("keeps ordinary text inline and folds at the 32 KiB boundary", () => {
    assert.strictEqual(
      pastedTextDisposition({
        ...facts,
        text: "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES - 1),
      }),
      "inline"
    );
    assert.strictEqual(
      pastedTextDisposition({
        ...facts,
        text: "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES),
      }),
      "attachment"
    );
  });

  it("measures UTF-8 bytes instead of UTF-16 characters", () => {
    const text = "🙂".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES / 4);

    assert.isTrue(text.length < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
    assert.strictEqual(pastedTextDisposition({ ...facts, text }), "attachment");
  });

  it("keeps text inline for the explicit bypass or without attachment support", () => {
    const text = "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);

    assert.strictEqual(
      pastedTextDisposition({ ...facts, text, bypassAutoAttachment: true }),
      "inline"
    );
    assert.strictEqual(
      pastedTextDisposition({ ...facts, text, canAttach: false }),
      "inline"
    );
  });

  it("folds a smaller paste when the resulting prompt would exceed the input limit", () => {
    assert.strictEqual(
      pastedTextDisposition({
        ...facts,
        text: "small paste",
        wouldExceedInputLimit: true,
      }),
      "attachment"
    );
  });
});

describe(utf8ByteLength, () => {
  it("counts one to four bytes per code point", () => {
    assert.strictEqual(utf8ByteLength("a"), 1);
    assert.strictEqual(utf8ByteLength("é"), 2);
    assert.strictEqual(utf8ByteLength("日"), 3);
    assert.strictEqual(utf8ByteLength("🙂"), 4);
  });
});

describe("pasted text attachment names", () => {
  it("uses the first available readable sequence", () => {
    assert.strictEqual(nextPastedTextFileName([]), "pasted-text.txt");
    assert.strictEqual(
      nextPastedTextFileName(["PASTED-TEXT.TXT", "pasted-text-2.txt"]),
      "pasted-text-3.txt"
    );
  });
});

describe("paste-as-text shortcut", () => {
  const keys = {
    key: "V",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
  };

  it("accepts the platform modifier with Shift", () => {
    assert.isTrue(isPasteAsTextShortcut({ ...keys, metaKey: true }, true));
    assert.isTrue(isPasteAsTextShortcut({ ...keys, ctrlKey: true }, false));
  });

  it("does not claim ordinary or alternate paste chords", () => {
    assert.isFalse(
      isPasteAsTextShortcut(
        { ...keys, key: "v", metaKey: true, shiftKey: false },
        true
      )
    );
    assert.isFalse(
      isPasteAsTextShortcut({ ...keys, metaKey: true, altKey: true }, true)
    );
  });

  it("rejects the other platform's modifier", () => {
    assert.isFalse(isPasteAsTextShortcut({ ...keys, ctrlKey: true }, true));
    assert.isFalse(isPasteAsTextShortcut({ ...keys, metaKey: true }, false));
  });
});

describe("text paste insertion", () => {
  it("replaces the selected range and returns the collapsed cursor", () => {
    assert.deepStrictEqual(
      replaceTextSelection("before old after", { start: 7, end: 10 }, "new"),
      { value: "before new after", cursor: 10 }
    );
  });

  it("clamps stale native selections", () => {
    assert.deepStrictEqual(
      replaceTextSelection("abc", { start: 20, end: 30 }, "!"),
      { value: "abc!", cursor: 4 }
    );
  });

  it("measures the replacement value after removing the selected range", () => {
    assert.isFalse(
      wouldTextPasteExceedLimit(100, { start: 40, end: 80 }, 30, 100)
    );
    assert.isTrue(
      wouldTextPasteExceedLimit(100, { start: 40, end: 80 }, 41, 100)
    );
  });
});
