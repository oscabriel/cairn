// Ported from github.com/pingdotgg/t3code, apps/web/src/keybindings.test.ts ("formatShortcutLabel"
// and the shortcut parsing cases) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: label formats.
// Removed: event matching (Foldkit matches events), `when` expressions and precedence (not ported,
// ADR 0050), terminal, preview, script, jump and model picker cases. Added: the Foldkit key strings
// and the table's commands.
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

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  formatShortcutLabel,
  KEYBINDINGS,
  parseKeybindingShortcut,
  shortcutsFor,
  toFoldkitKeys,
} from "./Keybindings.ts";
import type { KeybindingShortcut } from "./Keybindings.ts";

const shortcut = (value: string): KeybindingShortcut =>
  Option.getOrThrow(parseKeybindingShortcut(value));

describe(parseKeybindingShortcut, () => {
  it("reads modifiers in any order and one key", () => {
    assert.deepStrictEqual(shortcut("mod+shift+["), {
      key: "[",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
    assert.deepStrictEqual(shortcut("Cmd+Option+Esc").key, "escape");
    assert.strictEqual(shortcut("mod++").key, "+");
    assert.strictEqual(shortcut("ctrl+space").key, " ");
  });

  it("refuses two keys, an empty token or no key", () => {
    assert.isTrue(Option.isNone(parseKeybindingShortcut("mod+a+b")));
    assert.isTrue(Option.isNone(parseKeybindingShortcut("mod++shift")));
    assert.isTrue(Option.isNone(parseKeybindingShortcut("mod+shift")));
  });
});

describe("the key binding table", () => {
  it("binds only the commands the shell answers, each key once", () => {
    assert.deepStrictEqual(
      KEYBINDINGS.map((binding) => [
        binding.command,
        toFoldkitKeys(binding.shortcut),
      ]),
      [
        ["chat.new", "Mod+n"],
        ["chat.new", "Mod+Shift+o"],
        ["thread.previous", "Mod+Shift+{"],
        ["thread.next", "Mod+Shift+}"],
      ]
    );
  });

  it("labels a command's keys for the platform", () => {
    assert.deepStrictEqual(
      shortcutsFor("thread.next").map((each) =>
        formatShortcutLabel(each, false)
      ),
      ["Ctrl+Shift+]"]
    );
    assert.deepStrictEqual(
      shortcutsFor("chat.new").map((each) => formatShortcutLabel(each, true)),
      ["⌘N", "⇧⌘O"]
    );
  });
});

describe(formatShortcutLabel, () => {
  it("formats labels for macOS and elsewhere, including the plus key", () => {
    assert.strictEqual(
      formatShortcutLabel(shortcut("mod+shift+d"), true),
      "⇧⌘D"
    );
    assert.strictEqual(
      formatShortcutLabel(shortcut("mod+shift+d"), false),
      "Ctrl+Shift+D"
    );
    assert.strictEqual(formatShortcutLabel(shortcut("mod++"), true), "⌘+");
    assert.strictEqual(formatShortcutLabel(shortcut("mod++"), false), "Ctrl++");
    assert.strictEqual(
      formatShortcutLabel(shortcut("alt+arrowup"), false),
      "Alt+Up"
    );
  });
});

describe(toFoldkitKeys, () => {
  it("names shifted punctuation by the key the browser reports", () => {
    assert.strictEqual(toFoldkitKeys(shortcut("mod+shift+[")), "Mod+Shift+{");
    assert.strictEqual(toFoldkitKeys(shortcut("mod+shift+]")), "Mod+Shift+}");
    assert.strictEqual(toFoldkitKeys(shortcut("mod+shift+s")), "Mod+Shift+s");
    assert.strictEqual(toFoldkitKeys(shortcut("mod+alt+n")), "Mod+Alt+n");
    assert.strictEqual(toFoldkitKeys(shortcut("mod++")), "Mod+Plus");
    assert.strictEqual(toFoldkitKeys(shortcut("ctrl+space")), "Control+Space");
  });
});
