// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/textPaste.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a paste of 32 KiB or more (characters or UTF-8
// bytes) becomes a `pasted-text.txt` attachment, mod+shift+V keeps it inline, a paste that would
// push the draft past its limit folds too, the next free attachment name, and the selection
// replacement with stale-selection clamping. Changed: UTF-8 bytes are counted from code points
// (this package runs without DOM or Node globals), and object inputs are plain parameters.
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

/** A paste this long (characters or UTF-8 bytes) becomes an attachment instead of draft text. */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;

/** Whether pasted text goes into the draft or becomes a text attachment. */
export type PastedTextDisposition = "attachment" | "inline";

/** The modifier keys of a keydown. */
export interface PasteShortcutKeys {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** True for mod+shift+V (Command on macOS, Control elsewhere): paste as text, never fold. */
export const isPasteAsTextShortcut = (
  event: PasteShortcutKeys,
  isMac: boolean
): boolean =>
  event.key.toLowerCase() === "v" &&
  event.shiftKey &&
  !event.altKey &&
  (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

const utf8Length = (codePoint: number): number => {
  if (codePoint < 0x80) {
    return 1;
  }

  if (codePoint < 0x8_00) {
    return 2;
  }

  return codePoint < 0x1_00_00 ? 3 : 4;
};

/** The UTF-8 byte length of `text`. */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;

  for (const character of text) {
    bytes += utf8Length(character.codePointAt(0) ?? 0);
  }

  return bytes;
};

/** What a paste should do. */
export interface PasteFacts {
  readonly text: string;
  /** The composer can take attachments right now. */
  readonly canAttach: boolean;
  /** The user asked for a plain-text paste (mod+shift+V). */
  readonly bypassAutoAttachment: boolean;
  /** Inline, the paste would push the draft past its limit. */
  readonly wouldExceedInputLimit: boolean;
}

/**
 * Inline or attachment. The threshold is in bytes as well as characters, because a character count
 * understates the context cost of some Unicode-heavy clipboards.
 */
export const pastedTextDisposition = (
  facts: PasteFacts
): PastedTextDisposition => {
  if (
    facts.bypassAutoAttachment ||
    !facts.canAttach ||
    facts.text.length === 0
  ) {
    return "inline";
  }

  return facts.wouldExceedInputLimit ||
    facts.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES ||
    utf8ByteLength(facts.text) >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES
    ? "attachment"
    : "inline";
};

/** `pasted-text.txt`, else the first free `pasted-text-<n>.txt`, ignoring case. */
export const nextPastedTextFileName = (
  existingNames: ReadonlyArray<string>
): string => {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));

  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }

  let sequence = 2;

  while (names.has(`pasted-text-${sequence}.txt`)) {
    sequence += 1;
  }

  return `pasted-text-${sequence}.txt`;
};

/** A selection in a text value, as `selectionStart` and `selectionEnd`. */
export interface TextSelection {
  readonly start: number;
  readonly end: number;
}

const clampSelection = (
  length: number,
  selection: TextSelection
): TextSelection => {
  const start = Math.max(0, Math.min(length, selection.start));

  return { start, end: Math.max(start, Math.min(length, selection.end)) };
};

/** A text value after a paste, with the collapsed caret after the pasted text. */
export interface PastedValue {
  readonly value: string;
  readonly cursor: number;
}

/** `value` with the selection replaced by `text`, and the collapsed caret after it. */
export const replaceTextSelection = (
  value: string,
  selection: TextSelection,
  text: string
): PastedValue => {
  const { end, start } = clampSelection(value.length, selection);

  return {
    value: `${value.slice(0, start)}${text}${value.slice(end)}`,
    cursor: start + text.length,
  };
};

/** True when replacing the selection with `textLength` characters would exceed `maxLength`. */
export const wouldTextPasteExceedLimit = (
  valueLength: number,
  selection: TextSelection,
  textLength: number,
  maxLength: number
): boolean => {
  const { end, start } = clampSelection(valueLength, selection);

  return valueLength - (end - start) + textLength > maxLength;
};
