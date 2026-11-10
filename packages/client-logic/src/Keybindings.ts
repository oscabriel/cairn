// Ported from github.com/pingdotgg/t3code, packages/shared/src/keybindings.ts (shortcut parsing and
// the defaults) and apps/web/src/keybindings.ts (labels) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: the `mod+shift+[` grammar, t3code's keys for the commands kept, and the macOS and
// other-platform labels. Changed: the table holds only the commands the shell answers (ADR
// 0050), and each fires while the user types; a parse failure is `Option.none()`; key events are
// matched by Foldkit's `streamFromKeyBindings`, so this module turns a shortcut into Foldkit's key
// grammar instead of matching events itself (the physical-key fallbacks for other layouts are not
// ported). Not ported: the `when` expression language, user rules and their precedence, and every
// command the shell does not answer (settle, pin, undo, the sidebar, diff, model picker and command
// palette toggles, terminal, preview, script and jump commands).
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

import { Array, Option } from "effect";

import { onlyIf } from "./OnlyIf.ts";

/** The commands Cairn binds to keys: the ones the shell answers. */
export type KeybindingCommand = "chat.new" | "thread.previous" | "thread.next";

/** A parsed key chord. `modKey` is Meta on macOS and Control elsewhere. */
export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly modKey: boolean;
}

/** One key binding: the chord and the command it runs. */
export interface Keybinding {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
}

const normalizeKeyToken = (token: string): string => {
  if (token === "space") {
    return " ";
  }

  return token === "esc" ? "escape" : token;
};

/** Parses `mod+shift+[`; none when a token is empty or two keys are named. */
export const parseKeybindingShortcut = (
  value: string
): Option.Option<KeybindingShortcut> => {
  const tokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());

  let trailingEmpty = 0;

  while (tokens.at(-1) === "") {
    trailingEmpty += 1;
    tokens.pop();
  }

  // "mod++" names the plus key itself.
  if (trailingEmpty > 0) {
    tokens.push("+");
  }

  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return Option.none();
  }

  let key = Option.none<string>();

  const shortcut = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: false,
  };

  for (const token of tokens) {
    if (token === "cmd" || token === "meta") {
      shortcut.metaKey = true;
    } else if (token === "ctrl" || token === "control") {
      shortcut.ctrlKey = true;
    } else if (token === "shift") {
      shortcut.shiftKey = true;
    } else if (token === "alt" || token === "option") {
      shortcut.altKey = true;
    } else if (token === "mod") {
      shortcut.modKey = true;
    } else if (Option.isSome(key)) {
      return Option.none();
    } else {
      key = Option.some(normalizeKeyToken(token));
    }
  }

  return Option.map(key, (named) => ({ key: named, ...shortcut }));
};

/** t3code's keys for the commands the shell answers, as written. */
const DEFAULT_KEYS: ReadonlyArray<readonly [string, KeybindingCommand]> = [
  // In a project with a project thread, `chat.new` opens it rather than a draft (ADR 0048).
  ["mod+n", "chat.new"],
  ["mod+shift+o", "chat.new"],
  ["mod+shift+[", "thread.previous"],
  ["mod+shift+]", "thread.next"],
];

/** The key bindings, parsed. Each fires while the user types in a field. */
export const KEYBINDINGS: ReadonlyArray<Keybinding> = Array.getSomes(
  DEFAULT_KEYS.map(([key, command]) =>
    Option.map(parseKeybindingShortcut(key), (shortcut) => ({
      command,
      shortcut,
    }))
  )
);

/** The chords that run `command`, in table order. */
export const shortcutsFor = (
  command: KeybindingCommand
): ReadonlyArray<KeybindingShortcut> =>
  KEYBINDINGS.flatMap((binding) =>
    binding.command === command ? [binding.shortcut] : []
  );

const NAMED_KEY_LABELS = new Map([
  [" ", "Space"],
  ["escape", "Esc"],
  ["arrowup", "Up"],
  ["arrowdown", "Down"],
  ["arrowleft", "Left"],
  ["arrowright", "Right"],
]);

/** How a key is printed in a label: "B", "Space", "Esc", "Up". */
const formatShortcutKeyLabel = (key: string): string => {
  const named = NAMED_KEY_LABELS.get(key);

  if (named !== undefined) {
    return named;
  }

  return key.length === 1
    ? key.toUpperCase()
    : key.slice(0, 1).toUpperCase() + key.slice(1);
};

/** A chord as the platform prints it: "⇧⌘D" on macOS, "Ctrl+Shift+D" elsewhere. */
export const formatShortcutLabel = (
  shortcut: KeybindingShortcut,
  isMac: boolean
): string => {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const showMeta = shortcut.metaKey || (shortcut.modKey && isMac);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !isMac);

  if (isMac) {
    return `${showCtrl ? "⌃" : ""}${shortcut.altKey ? "⌥" : ""}${shortcut.shiftKey ? "⇧" : ""}${showMeta ? "⌘" : ""}${keyLabel}`;
  }

  return [
    ...onlyIf(showCtrl, "Ctrl"),
    ...onlyIf(shortcut.altKey, "Alt"),
    ...onlyIf(shortcut.shiftKey, "Shift"),
    ...onlyIf(showMeta, "Meta"),
    keyLabel,
  ].join("+");
};

/** What Shift turns each US punctuation key into, which is the key a browser reports. */
const US_SHIFTED_PUNCTUATION = new Map([
  ["1", "!"],
  ["2", "@"],
  ["3", "#"],
  ["4", "$"],
  ["5", "%"],
  ["6", "^"],
  ["7", "&"],
  ["8", "*"],
  ["9", "("],
  ["0", ")"],
  ["`", "~"],
  ["-", "_"],
  ["=", "+"],
  ["[", "{"],
  ["]", "}"],
  ["\\", "|"],
  [";", ":"],
  ["'", '"'],
  [",", "<"],
  [".", ">"],
  ["/", "?"],
]);

/** Keys Foldkit's grammar spells out, because `+` separates and a space is invisible. */
const FOLDKIT_KEY_NAMES = new Map([
  [" ", "Space"],
  ["+", "Plus"],
]);

/**
 * The chord in Foldkit's key grammar (`Mod+Shift+{`), for `streamFromKeyBindings`, which matches
 * `KeyboardEvent.key`. A shifted punctuation key is named by the character Shift types on a US
 * layout, since that is the key the browser reports.
 */
export const toFoldkitKeys = (shortcut: KeybindingShortcut): string => {
  const shifted = shortcut.shiftKey
    ? (US_SHIFTED_PUNCTUATION.get(shortcut.key) ?? shortcut.key)
    : shortcut.key;

  const key = FOLDKIT_KEY_NAMES.get(shifted) ?? shifted;

  return [
    ...onlyIf(shortcut.modKey, "Mod"),
    ...onlyIf(shortcut.ctrlKey, "Control"),
    ...onlyIf(shortcut.metaKey, "Meta"),
    ...onlyIf(shortcut.altKey, "Alt"),
    ...onlyIf(shortcut.shiftKey, "Shift"),
    key,
  ].join("+");
};
