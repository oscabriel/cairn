// The US keyboard the browser judges type on: what each key sends in `Input.dispatchKeyEvent`.
//
// Ported from github.com/microsoft/playwright,
// packages/playwright-core/src/server/usKeyboardLayout.ts and input.ts, at v1.64.1. The numbers are
// the layout's; only the keys a judge can reach are kept. Code rewritten for Cairn.
//
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0; you may not
// use this file except in compliance with the License. A copy is at
// http://www.apache.org/licenses/LICENSE-2.0. Software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

/** One key as the protocol wants it. */
export interface KeyDescription {
  readonly code: string;
  readonly key: string;
  readonly keyCode: number;
  /** What the key types; empty for a key that types nothing. */
  readonly text: string;
  readonly location: number;
  /** The same key with Shift held, for a key that has such a thing. */
  readonly shifted?: KeyDescription;
}

type Row = readonly [
  code: string,
  keyCode: number,
  key: string,
  shift?: string,
];

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

const ROWS: ReadonlyArray<Row> = [
  ["Escape", 27, "Escape"],
  ["Backquote", 192, "`", "~"],
  ["Digit1", 49, "1", "!"],
  ["Digit2", 50, "2", "@"],
  ["Digit3", 51, "3", "#"],
  ["Digit4", 52, "4", "$"],
  ["Digit5", 53, "5", "%"],
  ["Digit6", 54, "6", "^"],
  ["Digit7", 55, "7", "&"],
  ["Digit8", 56, "8", "*"],
  ["Digit9", 57, "9", "("],
  ["Digit0", 48, "0", ")"],
  ["Minus", 189, "-", "_"],
  ["Equal", 187, "=", "+"],
  ["Backslash", 220, "\\", "|"],
  ["Tab", 9, "Tab"],
  ["BracketLeft", 219, "[", "{"],
  ["BracketRight", 221, "]", "}"],
  ["Semicolon", 186, ";", ":"],
  ["Quote", 222, "'", '"'],
  ["Enter", 13, "Enter"],
  ["Comma", 188, ",", "<"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
  ["Space", 32, " "],
  ["Delete", 46, "Delete"],
  ...LETTERS.map((letter): Row => [
    `Key${letter.toUpperCase()}`,
    letter.toUpperCase().codePointAt(0) ?? 0,
    letter,
    letter.toUpperCase(),
  ]),
];

const MODIFIERS: ReadonlyArray<KeyDescription> = [
  { code: "ShiftLeft", key: "Shift", keyCode: 16, text: "", location: 1 },
  { code: "ControlLeft", key: "Control", keyCode: 17, text: "", location: 1 },
  { code: "MetaLeft", key: "Meta", keyCode: 91, text: "", location: 1 },
];

const textOf = (code: string, key: string): string => {
  if (code === "Enter") {
    return "\r";
  }

  return key.length === 1 ? key : "";
};

const describeRow = ([code, keyCode, key, shift]: Row): KeyDescription => {
  const base = { code, key, keyCode, text: textOf(code, key), location: 0 };

  return shift === undefined
    ? base
    : { ...base, shifted: { ...base, key: shift, text: shift } };
};

const buildKeys = (): ReadonlyMap<string, KeyDescription> => {
  const keys = new Map<string, KeyDescription>();

  for (const key of ROWS.map(describeRow)) {
    keys.set(key.code, key);
    keys.set(key.key, key);

    if (key.shifted !== undefined) {
      keys.set(key.shifted.key, key.shifted);
    }
  }

  for (const key of MODIFIERS) {
    keys.set(key.key, key);
  }

  const enter = describeRow(["Enter", 13, "Enter"]);

  keys.set("\n", enter);
  keys.set("\r", enter);

  return keys;
};

/** Every key by every name a judge may use for it: its code, its key, and its shifted key. */
export const KEYS = buildKeys();

/** The bit a held modifier sets in the protocol's `modifiers`. */
export const MODIFIER_BITS: ReadonlyMap<string, number> = new Map([
  ["Control", 2],
  ["Meta", 4],
  ["Shift", 8],
]);
