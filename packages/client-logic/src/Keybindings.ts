// Ported from github.com/pingdotgg/t3code, packages/shared/src/keybindings.ts (shortcut and `when`
// parsing, compiling, the defaults) and apps/web/src/keybindings.ts (`when` evaluation, effective
// shortcuts, labels) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the `mod+shift+[` grammar,
// the `when` expression language (identifiers, `!`, `&&`, `||`, parentheses, `true` and `false`,
// depth 64), "the last matching rule wins" and the macOS and other-platform labels. Changed: the
// defaults are the commands Cairn implements; a parse failure is `Option.none()`; key events are
// matched by Foldkit's `streamFromKeyBindings`, so this module turns a shortcut into Foldkit's key
// grammar instead of matching events itself (the physical-key fallbacks for other layouts are not
// ported); terminal, preview, script and jump commands are not ported.
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

/** The commands Cairn binds to keys. */
export type KeybindingCommand =
  | "sidebar.toggle"
  | "chat.new"
  | "chat.newLocal"
  | "chat.newWithoutProject"
  | "thread.previous"
  | "thread.next"
  | "thread.settle"
  | "thread.pin"
  | "thread.undo"
  | "modelPicker.toggle"
  | "commandPalette.toggle"
  | "diff.toggle";

/** A parsed key chord. `modKey` is Meta on macOS and Control elsewhere. */
export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly modKey: boolean;
}

/** A parsed `when` expression. */
export type KeybindingWhenNode =
  | { readonly type: "identifier"; readonly name: string }
  | { readonly type: "not"; readonly node: KeybindingWhenNode }
  | {
      readonly type: "and" | "or";
      readonly left: KeybindingWhenNode;
      readonly right: KeybindingWhenNode;
    };

/** A rule as written: `mod+shift+s` runs `thread.settle` when `!terminalFocus` holds. */
export interface KeybindingRule {
  readonly key: string;
  readonly command: KeybindingCommand;
  /** The condition; none means always. */
  readonly when: Option.Option<string>;
}

const always = (key: string, command: KeybindingCommand): KeybindingRule => ({
  key,
  command,
  when: Option.none(),
});

const onlyWhen = (
  key: string,
  command: KeybindingCommand,
  when: string
): KeybindingRule => ({ key, command, when: Option.some(when) });

/** A rule with its shortcut and condition parsed. */
export interface ResolvedKeybindingRule {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
  readonly whenAst: Option.Option<KeybindingWhenNode>;
}

/** The focus and surface facts a `when` expression can test. Unknown names read false. */
export type ShortcutContext = Readonly<Record<string, boolean>>;

/** The deepest a `when` expression may nest. */
export const MAX_WHEN_EXPRESSION_DEPTH = 64;

/** The most rules a configuration keeps; later rules win, so the oldest are dropped. */
export const MAX_KEYBINDINGS_COUNT = 256;

/** t3code's defaults for the commands Cairn implements. */
export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  always("mod+b", "sidebar.toggle"),
  onlyWhen("mod+d", "diff.toggle", "!terminalFocus"),
  onlyWhen("mod+k", "commandPalette.toggle", "!terminalFocus"),
  onlyWhen("mod+n", "chat.new", "!terminalFocus"),
  onlyWhen("mod+shift+o", "chat.new", "!terminalFocus"),
  onlyWhen("mod+shift+n", "chat.newLocal", "!terminalFocus"),
  onlyWhen("mod+alt+n", "chat.newWithoutProject", "!terminalFocus"),
  onlyWhen("mod+shift+m", "modelPicker.toggle", "!terminalFocus"),
  always("mod+shift+[", "thread.previous"),
  always("mod+shift+]", "thread.next"),
  onlyWhen("mod+shift+s", "thread.settle", "!terminalFocus"),
  onlyWhen("mod+shift+p", "thread.pin", "!terminalFocus"),
  onlyWhen("mod+z", "thread.undo", "!terminalFocus && !editableFocus"),
];

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

type WhenToken =
  | { readonly type: "identifier"; readonly value: string }
  | { readonly type: "not" | "and" | "or" | "lparen" | "rparen" };

const SYMBOL_TOKENS = new Map<string, WhenToken>([
  ["&&", { type: "and" }],
  ["||", { type: "or" }],
  ["!", { type: "not" }],
  ["(", { type: "lparen" }],
  [")", { type: "rparen" }],
]);

const tokenizeWhenExpression = (
  expression: string
): Option.Option<ReadonlyArray<WhenToken>> => {
  const tokens: Array<WhenToken> = [];
  let index = 0;

  while (index < expression.length) {
    const rest = expression.slice(index);
    const space = /^\s+/u.exec(rest);

    const symbol =
      SYMBOL_TOKENS.get(rest.slice(0, 2)) ?? SYMBOL_TOKENS.get(rest.charAt(0));

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/u.exec(rest);

    if (space !== null) {
      index += space[0].length;
    } else if (symbol === undefined) {
      if (identifier === null) {
        return Option.none();
      }

      tokens.push({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
    } else {
      tokens.push(symbol);
      index += symbol.type === "and" || symbol.type === "or" ? 2 : 1;
    }
  }

  return Option.some(tokens);
};

/** A recursive-descent parser over one token list; `index` is its cursor. */
interface WhenParser {
  index: number;
  readonly tokens: ReadonlyArray<WhenToken>;
  or(depth: number): Option.Option<KeybindingWhenNode>;
  and(depth: number): Option.Option<KeybindingWhenNode>;
  unary(depth: number): Option.Option<KeybindingWhenNode>;
  primary(depth: number): Option.Option<KeybindingWhenNode>;
}

/** Parses operands separated by `operator` and folds them left to right. */
const parseChain = (
  parser: WhenParser,
  operator: "and" | "or",
  operand: () => Option.Option<KeybindingWhenNode>
): Option.Option<KeybindingWhenNode> => {
  const operands = [operand()];

  while (
    Option.isSome(operands.at(-1) ?? Option.none()) &&
    parser.tokens[parser.index]?.type === operator
  ) {
    parser.index += 1;
    operands.push(operand());
  }

  return Option.flatMap(Option.all(operands), ([first, ...others]) =>
    Option.map(Option.fromUndefinedOr(first), (head) => {
      let node = head;

      for (const right of others) {
        node = { type: operator, left: node, right };
      }

      return node;
    })
  );
};

const makeWhenParser = (tokens: ReadonlyArray<WhenToken>): WhenParser => {
  const parser: WhenParser = {
    index: 0,
    tokens,
    or: (depth) => parseChain(parser, "or", () => parser.and(depth)),
    and: (depth) => parseChain(parser, "and", () => parser.unary(depth)),
    unary: (depth) => {
      let notCount = 0;

      while (parser.tokens[parser.index]?.type === "not") {
        parser.index += 1;
        notCount += 1;
      }

      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return Option.none();
      }

      return Option.map(parser.primary(depth), (primary) => {
        let node = primary;

        for (let remaining = notCount; remaining > 0; remaining -= 1) {
          node = { type: "not", node };
        }

        return node;
      });
    },
    primary: (depth) => {
      const token = parser.tokens[parser.index];

      if (depth > MAX_WHEN_EXPRESSION_DEPTH || token === undefined) {
        return Option.none();
      }

      if (token.type === "identifier") {
        parser.index += 1;

        return Option.some({ type: "identifier", name: token.value });
      }

      if (token.type !== "lparen") {
        return Option.none();
      }

      parser.index += 1;

      const inner = parser.or(depth + 1);

      if (parser.tokens[parser.index]?.type !== "rparen") {
        return Option.none();
      }

      parser.index += 1;

      return inner;
    },
  };

  return parser;
};

/** Parses a `when` expression; none for an empty, malformed or too deeply nested one. */
export const parseKeybindingWhenExpression = (
  expression: string
): Option.Option<KeybindingWhenNode> =>
  Option.flatMap(tokenizeWhenExpression(expression), (tokens) => {
    const parser = makeWhenParser(tokens);
    const ast = parser.or(0);

    return parser.index === tokens.length ? ast : Option.none();
  });

/** Evaluates a `when` expression; `true` and `false` are literals, unknown names read false. */
export const evaluateWhen = (
  node: KeybindingWhenNode,
  context: ShortcutContext
): boolean => {
  if (node.type === "identifier") {
    if (node.name === "true" || node.name === "false") {
      return node.name === "true";
    }

    return context[node.name] === true;
  }

  if (node.type === "not") {
    return !evaluateWhen(node.node, context);
  }

  return node.type === "and"
    ? evaluateWhen(node.left, context) && evaluateWhen(node.right, context)
    : evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
};

const matchesWhen = (
  rule: ResolvedKeybindingRule,
  context: ShortcutContext
): boolean =>
  Option.match(rule.whenAst, {
    onNone: () => true,
    onSome: (node) => evaluateWhen(node, context),
  });

/** Parses one rule; none when its shortcut or `when` does not parse. */
export const compileResolvedKeybindingRule = (
  rule: KeybindingRule
): Option.Option<ResolvedKeybindingRule> =>
  Option.flatMap(parseKeybindingShortcut(rule.key), (shortcut) => {
    if (Option.isNone(rule.when)) {
      return Option.some({
        command: rule.command,
        shortcut,
        whenAst: Option.none(),
      });
    }

    return Option.map(
      parseKeybindingWhenExpression(rule.when.value),
      (whenAst) => ({
        command: rule.command,
        shortcut,
        whenAst: Option.some(whenAst),
      })
    );
  });

/** Parses a configuration, dropping rules that do not parse and keeping the newest 256. */
export const compileResolvedKeybindingsConfig = (
  rules: ReadonlyArray<KeybindingRule>
): ReadonlyArray<ResolvedKeybindingRule> =>
  Array.getSomes(rules.map(compileResolvedKeybindingRule)).slice(
    -MAX_KEYBINDINGS_COUNT
  );

/** The defaults, parsed. */
export const DEFAULT_RESOLVED_KEYBINDINGS =
  compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

/** True on Apple platforms, where `mod` is Command. */
export const isMacPlatform = (platform: string): boolean =>
  /mac|iphone|ipad|ipod/iu.test(platform);

/** The chord as pressed: which modifiers, with `mod` resolved for the platform. */
const shortcutConflictKey = (
  shortcut: KeybindingShortcut,
  isMac: boolean
): string =>
  [
    shortcut.key,
    shortcut.metaKey || (shortcut.modKey && isMac) ? "meta" : "",
    shortcut.ctrlKey || (shortcut.modKey && !isMac) ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");

/**
 * The rules in force in `context`: walking from the newest rule, a rule whose `when` holds claims
 * its chord, and an older rule for the same chord is shadowed. Newest first.
 */
export const effectiveKeybindings = (
  keybindings: ReadonlyArray<ResolvedKeybindingRule>,
  context: ShortcutContext,
  isMac: boolean
): ReadonlyArray<ResolvedKeybindingRule> => {
  const claimed = new Set<string>();

  return keybindings.toReversed().filter((rule) => {
    if (!matchesWhen(rule, context)) {
      return false;
    }

    const key = shortcutConflictKey(rule.shortcut, isMac);

    if (claimed.has(key)) {
      return false;
    }

    claimed.add(key);

    return true;
  });
};

/** The shortcuts that run `command` in `context`, newest first. */
export const effectiveShortcutsForCommand = (
  keybindings: ReadonlyArray<ResolvedKeybindingRule>,
  command: KeybindingCommand,
  context: ShortcutContext,
  isMac: boolean
): ReadonlyArray<KeybindingShortcut> =>
  effectiveKeybindings(keybindings, context, isMac)
    .filter((rule) => rule.command === command)
    .map((rule) => rule.shortcut);

const NAMED_KEY_LABELS = new Map([
  [" ", "Space"],
  ["escape", "Esc"],
  ["arrowup", "Up"],
  ["arrowdown", "Down"],
  ["arrowleft", "Left"],
  ["arrowright", "Right"],
]);

/** How a key is printed in a label: "B", "Space", "Esc", "Up". */
export const formatShortcutKeyLabel = (key: string): string => {
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
    ...(showCtrl ? ["Ctrl"] : []),
    ...(shortcut.altKey ? ["Alt"] : []),
    ...(shortcut.shiftKey ? ["Shift"] : []),
    ...(showMeta ? ["Meta"] : []),
    keyLabel,
  ].join("+");
};

/** The label of the shortcut that runs `command` now, for tooltips; none when it has none. */
export const shortcutLabelForCommand = (
  keybindings: ReadonlyArray<ResolvedKeybindingRule>,
  command: KeybindingCommand,
  context: ShortcutContext,
  isMac: boolean
): Option.Option<string> =>
  Option.map(
    Array.head(
      effectiveShortcutsForCommand(keybindings, command, context, isMac)
    ),
    (shortcut) => formatShortcutLabel(shortcut, isMac)
  );

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
    ...(shortcut.modKey ? ["Mod"] : []),
    ...(shortcut.ctrlKey ? ["Control"] : []),
    ...(shortcut.metaKey ? ["Meta"] : []),
    ...(shortcut.altKey ? ["Alt"] : []),
    ...(shortcut.shiftKey ? ["Shift"] : []),
    key,
  ].join("+");
};

/**
 * Whether a rule may fire while the user types in a field: false when its `when` turns off with
 * `editableFocus` set (mod+z belongs to the text field then).
 */
export const firesWhileTyping = (
  rule: ResolvedKeybindingRule,
  context: ShortcutContext
): boolean => matchesWhen(rule, { ...context, editableFocus: true });
