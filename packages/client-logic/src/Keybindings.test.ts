// Ported from github.com/pingdotgg/t3code, apps/web/src/keybindings.test.ts ("shortcutLabelForCommand",
// "cross-command precedence", "formatShortcutLabel", the when-expression cases) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: label formats, last-rule-wins precedence, `when`
// expressions and literals. Removed: event matching (Foldkit matches events), terminal, preview,
// script, jump and model picker cases. Added: the Foldkit key strings and typing rules.
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
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  effectiveKeybindings,
  evaluateWhen,
  firesWhileTyping,
  formatShortcutLabel,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
  shortcutLabelForCommand,
  toFoldkitKeys,
} from "./Keybindings.ts";
import type { KeybindingCommand, KeybindingShortcut } from "./Keybindings.ts";

const shortcut = (value: string): KeybindingShortcut =>
  Option.getOrThrow(parseKeybindingShortcut(value));

const rule = (key: string, command: KeybindingCommand, when?: string) => ({
  key,
  command,
  when: Option.fromUndefinedOr(when),
});

const label = (command: KeybindingCommand, isMac: boolean) =>
  Option.getOrNull(
    shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, command, {}, isMac)
  );

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

const holds = (
  expression: string,
  context: Readonly<Record<string, boolean>>
) =>
  evaluateWhen(
    Option.getOrThrow(parseKeybindingWhenExpression(expression)),
    context
  );

describe(parseKeybindingWhenExpression, () => {
  it("supports not, and, or, parentheses and boolean literals", () => {
    assert.isTrue(
      holds("terminalOpen && !terminalFocus", { terminalOpen: true })
    );
    assert.isFalse(
      holds("terminalOpen && !terminalFocus", { terminalOpen: false })
    );
    assert.isTrue(holds("a || b && c", { a: true }));
    assert.isFalse(holds("(a || b) && c", { a: true }));
    assert.isTrue(holds("!!a", { a: true }));
    assert.isTrue(holds("true", {}));
    assert.isFalse(holds("false", { false: true }));
  });

  it("refuses malformed expressions", () => {
    for (const expression of ["", "a &&", "(a", "a)", "a $ b", "!"]) {
      assert.isTrue(
        Option.isNone(parseKeybindingWhenExpression(expression)),
        expression
      );
    }
  });

  it("refuses nesting deeper than 64", () => {
    assert.isTrue(
      Option.isNone(
        parseKeybindingWhenExpression(`${"(".repeat(70)}a${")".repeat(70)}`)
      )
    );
    assert.isTrue(
      Option.isSome(
        parseKeybindingWhenExpression(`${"(".repeat(10)}a${")".repeat(10)}`)
      )
    );
  });
});

describe(shortcutLabelForCommand, () => {
  it("returns the default labels", () => {
    assert.strictEqual(label("sidebar.toggle", true), "⌘B");
    assert.strictEqual(label("chat.new", true), "⇧⌘O");
    assert.strictEqual(label("diff.toggle", false), "Ctrl+D");
    assert.strictEqual(label("commandPalette.toggle", true), "⌘K");
    assert.strictEqual(label("modelPicker.toggle", false), "Ctrl+Shift+M");
    assert.strictEqual(label("thread.previous", false), "Ctrl+Shift+[");
    assert.strictEqual(label("thread.settle", true), "⇧⌘S");
  });

  it("returns none for a command shadowed by a later rule on the same chord", () => {
    const bindings = compileResolvedKeybindingsConfig([
      rule("mod+shift+1", "thread.pin"),
      rule("mod+shift+1", "thread.settle"),
    ]);

    assert.isTrue(
      Option.isNone(shortcutLabelForCommand(bindings, "thread.pin", {}, true))
    );
    assert.deepStrictEqual(
      shortcutLabelForCommand(bindings, "thread.settle", {}, true),
      Option.some("⇧⌘1")
    );
  });

  it("respects the when context while resolving labels", () => {
    const bindings = compileResolvedKeybindingsConfig([
      rule("mod+d", "diff.toggle"),
      rule("mod+d", "thread.pin", "terminalFocus"),
    ]);

    assert.deepStrictEqual(
      shortcutLabelForCommand(
        bindings,
        "diff.toggle",
        { terminalFocus: false },
        false
      ),
      Option.some("Ctrl+D")
    );
    assert.isTrue(
      Option.isNone(
        shortcutLabelForCommand(
          bindings,
          "diff.toggle",
          { terminalFocus: true },
          false
        )
      )
    );
  });
});

describe("cross-command precedence", () => {
  it("lets a later focused rule override a global one only while it holds", () => {
    const bindings = compileResolvedKeybindingsConfig([
      rule("mod+n", "chat.new"),
      rule("mod+n", "chat.newLocal", "terminalFocus"),
    ]);

    const winner = (terminalFocus: boolean) =>
      effectiveKeybindings(bindings, { terminalFocus }, true).map(
        (binding) => binding.command
      );

    assert.deepStrictEqual(winner(true), ["chat.newLocal"]);
    assert.deepStrictEqual(winner(false), ["chat.new"]);
  });

  it("still lets a later global rule win when both rules match", () => {
    const bindings = compileResolvedKeybindingsConfig([
      rule("mod+n", "chat.newLocal", "terminalFocus"),
      rule("mod+n", "chat.new"),
    ]);

    assert.deepStrictEqual(
      effectiveKeybindings(bindings, { terminalFocus: true }, false).map(
        (binding) => binding.command
      ),
      ["chat.new"]
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

const fires = (command: KeybindingCommand) =>
  DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => binding.command === command
  ).every((binding) => firesWhileTyping(binding, {}));

describe(toFoldkitKeys, () => {
  it("names shifted punctuation by the key the browser reports", () => {
    assert.strictEqual(toFoldkitKeys(shortcut("mod+shift+[")), "Mod+Shift+{");
    assert.strictEqual(toFoldkitKeys(shortcut("mod+shift+]")), "Mod+Shift+}");
    assert.strictEqual(toFoldkitKeys(shortcut("mod+shift+s")), "Mod+Shift+s");
    assert.strictEqual(toFoldkitKeys(shortcut("mod+alt+n")), "Mod+Alt+n");
    assert.strictEqual(toFoldkitKeys(shortcut("mod++")), "Mod+Plus");
    assert.strictEqual(toFoldkitKeys(shortcut("ctrl+space")), "Control+Space");
  });

  it("keeps mod+z out of text fields and lets the rest fire while typing", () => {
    assert.isFalse(fires("thread.undo"));
    assert.isTrue(fires("chat.new"));
    assert.isTrue(fires("thread.settle"));
  });
});
