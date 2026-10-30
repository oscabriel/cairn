// Workflow scripts (ADR 0012 as amended): a `codemode` script whose first statement is
// `export const meta = {...}`. This module reads that statement without running anything: `meta`
// must be a pure literal (no names, calls, spreads, computed keys or template interpolation), the
// rest of the script may export and import nothing and may not declare the prelude's names at its
// top level (as a `const`, `let` or `var` binding, destructured or not and in any declarator, or as
// a function or class name), and a script that sets its own `timeout_ms` is refused, because code
// mode stores the deadline and a rerun after a restart then fails. The source is hashed as submitted, so the gate
// can match a launched script to the one the user approved byte for byte.
//
// The `meta` rules follow Claude Code's workflow scripts (research 06 section 2.5); refusing before
// launch follows pi-subagents' `validate` action (github.com/nicobailon/pi-subagents,
// docs/workflows.md at 1a80e24), ideas only: no text was taken. The server does not depend on a
// JavaScript parser, so a small lexer here skips strings, comments, template literals and regular
// expressions, which is all the checks need. It tells a regular expression from a division by the
// token before the `/`, with two known limits. A `/` after the `)` of an `if`, `while`, `for` or
// `with` head is read as a regular expression, which is right for statements like
// `if (s) /x/.test(s)`; a division right after such a head is not valid JavaScript anyway. And a
// `}` counts as closing a block (so a regular expression may follow) when its `{` came after a `)`,
// `=>`, `else`, `try`, `finally` or `do`, or where a statement starts, so a division right after a
// function expression's body (`function () {} / 2`) is misread. None of these checks is a security
// boundary: the node tools check every call again.
//
// MIT License. Copyright (c) 2026 Nico Bailon
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

import { createHash } from "node:crypto";

import { DisplayText } from "@cairn/protocol/Ids";
import type { WorkflowPhase } from "@cairn/protocol/Policy";
import {
  CodemodeSourceError,
  parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import { Effect, Option, Schema } from "effect";

import {
  BUILT_IN_RECIPES,
  recipeReferenceOf,
} from "./recipes/BuiltInRecipes.ts";

/** Why a script was refused before it ran; the message tells the model what to change. */
export const RefusalReason = Schema.Literals([
  "not_a_workflow",
  "source_unreadable",
  "sets_timeout",
  "meta_not_literal",
  "meta_invalid",
  "export_outside_meta",
  "import_statement",
  "reserved_name",
  "args_invalid",
  "script_failed",
  "dry_run_timeout",
  "agent_options_invalid",
  "too_many_items",
  "no_nodes",
  "unknown_recipe",
]);

export type RefusalReason = typeof RefusalReason.Type;

/**
 * A workflow script that will not be launched as written. Nothing ran outside the dry run's
 * sandbox; fix the script and propose it again.
 */
export class WorkflowRefusal extends Schema.TaggedError<WorkflowRefusal>()(
  "WorkflowRefusal",
  {
    message: Schema.String,
    reason: RefusalReason,
  }
) {}

/** Names the prelude defines; a script may not declare them at its top level. */
export const PRELUDE_NAMES: ReadonlyArray<string> = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "budget",
  "args",
  "verify",
  "approve",
  "WORKFLOW",
  "SAMPLE",
];

/**
 * Every name the prelude keeps for itself starts with this; scripts may not use it at all. The rule
 * keeps a script's names from colliding with the prelude's, nothing more: the lexer can be fooled
 * and direct `eval` reaches the prelude's locals anyway, so the node tools are the guard.
 */
export const PRELUDE_PREFIX = "__cairn";

/** The longest a workflow's name may be: it is a recipe name and a label. */
const NAME_MAX = 64;

const PhaseLiteral = Schema.Struct({
  title: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  detail: Schema.optionalKey(DisplayText),
});

const MetaLiteral = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u),
    Schema.isMaxLength(NAME_MAX)
  ),
  description: Schema.Trimmed.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096)
  ),
  whenToUse: Schema.optionalKey(DisplayText),
  phases: Schema.optionalKey(Schema.Array(PhaseLiteral)),
});

const decodeMeta = Schema.decodeUnknownEffect(MetaLiteral, {
  onExcessProperty: "error",
  errors: "all",
});

/** What a workflow's `meta` declares. */
export interface WorkflowMeta {
  /** Lowercase words joined by `-`: the recipe name and the steps panel's title. */
  readonly name: string;
  readonly description: string;
  /** Shown beside the name in a recipe list. */
  readonly whenToUse: Option.Option<string>;
  /** Declared phases in order; phases a run reaches that are not here are appended then. */
  readonly phases: ReadonlyArray<WorkflowPhase>;
}

/** A parsed workflow script, ready for the dry run and the rewrite. */
export interface WorkflowScript {
  /** The source exactly as submitted, options line included. */
  readonly source: string;
  /** `sha256-<hex>` of `source`, what a launch approval binds. */
  readonly hash: string;
  readonly meta: WorkflowMeta;
  /** Offset in `source` of the `export` keyword that opens the meta statement. */
  readonly exportAt: number;
  /** Offset in `source` just past the meta statement (its `;` when it has one). */
  readonly metaEnd: number;
}

/** `sha256-<hex>` of a script's source as submitted. */
export const scriptHash = (source: string) =>
  `sha256-${createHash("sha256").update(source, "utf-8").digest("hex")}`;

// ---------------------------------------------------------------------------------------------
// The lexer: just enough JavaScript to step over what can hide a keyword.

const IDENT_START = /[A-Za-z_$\u0080-￿]/u;

const IDENT_PART = /[\w$\u0080-￿]/u;

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

interface Token {
  readonly kind: "word" | "punct" | "literal";
  readonly text: string;
  readonly start: number;
  /** Curly-brace depth where the token starts, template interpolations included. */
  readonly depth: number;
  /** For a `)`: it closes the head of an `if`, `while`, `for` or `with`, so a statement follows. */
  readonly closesHead?: boolean;
  /** For a `}`: it closes a block rather than an object literal, so a statement may follow. */
  readonly closesBlock?: boolean;
}

/** Keywords after which a `{` opens a block. */
const BLOCK_AFTER_WORDS = new Set(["else", "try", "finally", "do"]);

/** Keywords whose parenthesised head is followed by a statement, which may open with a regex. */
const HEAD_WORDS = new Set(["if", "while", "for", "with"]);

/** A place in the source the lexer or the literal reader could not go past. */
class SourceProblemError extends globalThis.Error {
  readonly offset: number;
  readonly problem: string;

  constructor(offset: number, problem: string) {
    super(problem);
    this.name = "SourceProblemError";
    this.offset = offset;
    this.problem = problem;
  }
}

/** The 1-based line of `offset` in `text`. */
const lineOf = (text: string, offset: number) => {
  let line = 1;

  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }

  return line;
};

/** The offset after any whitespace and comments from `from`. */
const skipTrivia = (text: string, from: number): number => {
  let at = from;

  while (at < text.length) {
    const char = text[at];

    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\r" ||
      char === "﻿"
    ) {
      at += 1;
    } else if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);

      at = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);

      if (end === -1) {
        throw new SourceProblemError(at, "a block comment is never closed");
      }

      at = end + 2;
    } else {
      return at;
    }
  }

  return at;
};

/** True when only spaces, tabs and comments without a line break sit between `from` and the line's end. */
const restOfLineIsBlank = (text: string, from: number) => {
  let at = from;

  while (at < text.length) {
    const char = text[at];

    if (char === " " || char === "\t" || char === "\r") {
      at += 1;
    } else if (char === "\n" || text.startsWith("//", at)) {
      return true;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      const comment = end === -1 ? text.slice(at) : text.slice(at, end);

      if (comment.includes("\n")) {
        return true;
      }

      at = end === -1 ? text.length : end + 2;
    } else {
      return false;
    }
  }

  return true;
};

/** The offset after a quoted string that opens at `from`. */
const skipString = (text: string, from: number): number => {
  const quote = text[from];
  let at = from + 1;

  while (at < text.length) {
    const char = text[at];

    if (char === "\\") {
      at += 2;
    } else if (char === quote) {
      return at + 1;
    } else if (char === "\n") {
      break;
    } else {
      at += 1;
    }
  }

  throw new SourceProblemError(from, "a string is never closed");
};

/** The offset after a regular expression literal that opens at `from`. */
const skipRegex = (text: string, from: number): number => {
  let at = from + 1;
  let inClass = false;

  while (at < text.length) {
    const char = text[at];

    if (char === "\\") {
      at += 2;
    } else if (char === "\n") {
      break;
    } else if (inClass) {
      inClass = char !== "]";
      at += 1;
    } else if (char === "[") {
      inClass = true;
      at += 1;
    } else if (char === "/") {
      at += 1;

      while (at < text.length && IDENT_PART.test(text.charAt(at))) {
        at += 1;
      }

      return at;
    } else {
      at += 1;
    }
  }

  throw new SourceProblemError(from, "a regular expression is never closed");
};

/** Every token of `text` from `from` on, strings, comments and template text stepped over. */
const tokenize = (text: string, from: number): ReadonlyArray<Token> => {
  const tokens: Array<Token> = [];
  // One entry per open template interpolation: the brace depth its `${` opened at.
  const templates: Array<number> = [];
  let depth = 0;
  let at = from;

  /** Steps over template text from `at` to its end or its next `${`. */
  const templateText = () => {
    const opened = at;

    while (at < text.length) {
      const char = text[at];

      if (char === "\\") {
        at += 2;
      } else if (char === "`") {
        at += 1;

        return;
      } else if (text.startsWith("${", at)) {
        at += 2;
        templates.push(depth);
        depth += 1;

        return;
      } else {
        at += 1;
      }
    }

    throw new SourceProblemError(opened, "a template literal is never closed");
  };

  // One entry per open `(`: whether it opens the head of `if`, `while`, `for` or `with`.
  const parens: Array<boolean> = [];

  /** True when the tokens before end in a postfix `++` or `--`, after which `/` divides. */
  const endsInPostfix = () => {
    const [operand, first, second] = tokens.slice(-3);

    return (
      operand !== undefined &&
      first !== undefined &&
      second !== undefined &&
      first.kind === "punct" &&
      second.kind === "punct" &&
      (first.text === "+" || first.text === "-") &&
      second.text === first.text &&
      second.start === first.start + 1 &&
      (operand.kind === "literal" ||
        (operand.kind === "word" && !REGEX_AFTER_WORDS.has(operand.text)) ||
        operand.text === ")" ||
        operand.text === "]")
    );
  };

  // One entry per open `{` outside template interpolations: whether it opens a block.
  const braces: Array<boolean> = [];

  /** True when a `{` here opens a block: after a `)`, `=>`, a block keyword or a statement's end. */
  const opensBlock = () => {
    const [arrowHead, before] = tokens.slice(-2);

    if (before === undefined) {
      return true;
    }

    if (before.kind === "word") {
      return BLOCK_AFTER_WORDS.has(before.text);
    }

    if (before.kind !== "punct") {
      return false;
    }

    if (before.text === ">") {
      return arrowHead?.text === "=" && arrowHead.start === before.start - 1;
    }

    return [")", ";", "{", "}"].includes(before.text);
  };

  /** Pushes a one-character punctuator, noting which `)` closes a statement head. */
  const punct = (char: string, start: number) => {
    if (char === "(") {
      const before = tokens.at(-1);

      parens.push(before?.kind === "word" && HEAD_WORDS.has(before.text));
    }

    tokens.push(
      char === ")"
        ? {
            kind: "punct",
            text: char,
            start,
            depth,
            closesHead: parens.pop() === true,
          }
        : { kind: "punct", text: char, start, depth }
    );
  };

  const regexAllowed = () => {
    const last = tokens.at(-1);

    if (last === undefined) {
      return true;
    }

    if (last.kind === "word") {
      // `o.return / 2` names a property; a keyword, or one after a spread's `...`, may start one.
      const [spread, dot] = tokens.slice(-3, -1);

      const isProperty =
        dot?.kind === "punct" &&
        dot.text === "." &&
        !(spread?.kind === "punct" && spread.text === ".");

      return !isProperty && REGEX_AFTER_WORDS.has(last.text);
    }

    if (last.closesHead === true || last.closesBlock === true) {
      return true;
    }

    return (
      last.kind === "punct" &&
      last.text !== ")" &&
      last.text !== "]" &&
      last.text !== "}" &&
      !endsInPostfix()
    );
  };

  for (;;) {
    at = skipTrivia(text, at);

    if (at >= text.length) {
      break;
    }

    const start = at;
    const char = text.charAt(at);

    if (char === '"' || char === "'") {
      at = skipString(text, at);
      tokens.push({ kind: "literal", text: "string", start, depth });
    } else if (char === "`") {
      at += 1;
      templateText();
      tokens.push({ kind: "literal", text: "template", start, depth });
    } else if (char === "/" && regexAllowed()) {
      at = skipRegex(text, at);
      tokens.push({ kind: "literal", text: "regex", start, depth });
    } else if (IDENT_START.test(char)) {
      at += 1;

      while (at < text.length && IDENT_PART.test(text.charAt(at))) {
        at += 1;
      }

      tokens.push({ kind: "word", text: text.slice(start, at), start, depth });
    } else if (
      /\d/u.test(char) ||
      (char === "." && /\d/u.test(text.charAt(at + 1)))
    ) {
      at += 1;

      while (at < text.length && /[\w.]/u.test(text.charAt(at))) {
        at += 1;
      }

      tokens.push({ kind: "literal", text: "number", start, depth });
    } else if (char === "{") {
      braces.push(opensBlock());
      tokens.push({ kind: "punct", text: char, start, depth });
      depth += 1;
      at += 1;
    } else if (char === "}") {
      at += 1;

      if (templates.length > 0 && templates.at(-1) === depth - 1) {
        templates.pop();
        depth -= 1;
        templateText();
        tokens.push({ kind: "literal", text: "template", start, depth });
      } else {
        depth -= 1;
        tokens.push({
          kind: "punct",
          text: char,
          start,
          depth,
          closesBlock: braces.pop() === true,
        });
      }
    } else {
      punct(char, start);
      at += 1;
    }
  }

  return tokens;
};

// ---------------------------------------------------------------------------------------------
// The meta literal.

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["b", "\b"],
  ["f", "\f"],
  ["v", "\v"],
  ["0", "\0"],
]);

/** Reads one pure literal value at `from`; answers it and the offset after it. */
class LiteralReader {
  readonly text: string;
  at: number;

  constructor(text: string, from: number) {
    this.text = text;
    this.at = from;
  }

  /** Stops reading; past the end of the source the problem is always that the object ends early. */
  fail(problem: string, offset: number = this.at): never {
    throw new SourceProblemError(
      offset,
      skipTrivia(this.text, offset) >= this.text.length
        ? "the meta object ends early"
        : problem
    );
  }

  value(): Schema.Json {
    this.at = skipTrivia(this.text, this.at);
    const char = this.text.charAt(this.at);

    if (char === "{") {
      return this.object();
    }

    if (char === "[") {
      return this.array();
    }

    if (char === '"' || char === "'" || char === "`") {
      return this.string();
    }

    if (this.text.startsWith("...", this.at)) {
      return this.fail(
        "a spread (`...`) is not a literal; write the values out"
      );
    }

    if (char === "-" || char === "+" || /[\d.]/u.test(char)) {
      return this.number();
    }

    if (IDENT_START.test(char)) {
      const word = this.word();

      if (word === "true") {
        return true;
      }

      if (word === "false") {
        return false;
      }

      if (word === "null") {
        return null;
      }

      return this.fail(
        `\`${word}\` is a name, not a literal; meta may hold only strings, numbers, booleans, null, arrays and objects written out`,
        this.at - word.length
      );
    }

    return this.fail(
      char === ""
        ? "the meta object ends early"
        : `\`${char}\` cannot start a literal value`
    );
  }

  word() {
    const start = this.at;

    while (
      this.at < this.text.length &&
      IDENT_PART.test(this.text.charAt(this.at))
    ) {
      this.at += 1;
    }

    return this.text.slice(start, this.at);
  }

  expect(char: string, problem: string) {
    this.at = skipTrivia(this.text, this.at);

    if (this.text.charAt(this.at) !== char) {
      this.fail(problem);
    }

    this.at += 1;
  }

  object(): Schema.Json {
    const result: Record<string, Schema.Json> = {};

    this.at += 1;

    for (;;) {
      this.at = skipTrivia(this.text, this.at);
      const char = this.text.charAt(this.at);

      if (char === "}") {
        this.at += 1;

        return result;
      }

      const keyAt = this.at;
      let key: string;

      if (char === '"' || char === "'") {
        key = this.string();
      } else if (char === "`") {
        return this.fail(
          "a template literal cannot be a key; use a plain string"
        );
      } else if (char === "[") {
        return this.fail(
          "a computed key (`[...]`) is not a literal; write the key out"
        );
      } else if (char === ".") {
        return this.fail(
          "a spread (`...`) is not a literal; write the properties out"
        );
      } else if (IDENT_START.test(char)) {
        key = this.word();
      } else if (/\d/u.test(char)) {
        key = String(this.number());
      } else {
        return this.fail(
          char === ""
            ? "the meta object ends early"
            : `\`${char}\` cannot start a key`
        );
      }

      if (key === "__proto__" || Object.hasOwn(result, key)) {
        return this.fail(
          `the key \`${key}\` is not allowed or appears twice`,
          keyAt
        );
      }

      this.at = skipTrivia(this.text, this.at);

      if (this.text.charAt(this.at) !== ":") {
        return this.fail(
          `\`${key}\` needs \`: value\`; shorthand properties and methods are not literals`,
          keyAt
        );
      }

      this.at += 1;
      result[key] = this.value();
      this.at = skipTrivia(this.text, this.at);

      if (this.text.charAt(this.at) === ",") {
        this.at += 1;
      } else if (this.text.charAt(this.at) !== "}") {
        return this.fail("expected `,` or `}` after a property");
      }
    }
  }

  array(): Schema.Json {
    const result: Array<Schema.Json> = [];

    this.at += 1;

    for (;;) {
      this.at = skipTrivia(this.text, this.at);
      const char = this.text.charAt(this.at);

      if (char === "]") {
        this.at += 1;

        return result;
      }

      if (char === ",") {
        return this.fail(
          "an array hole is not a literal value; remove the extra `,`"
        );
      }

      result.push(this.value());
      this.at = skipTrivia(this.text, this.at);

      if (this.text.charAt(this.at) === ",") {
        this.at += 1;
      } else if (this.text.charAt(this.at) !== "]") {
        return this.fail("expected `,` or `]` after an element");
      }
    }
  }

  number(): number {
    const start = this.at;
    const sign = this.text.charAt(this.at);

    if (sign === "-" || sign === "+") {
      this.at += 1;
    }

    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(
      this.text.slice(this.at)
    );

    if (
      match === null ||
      IDENT_PART.test(this.text.charAt(this.at + match[0].length))
    ) {
      return this.fail("only decimal numbers are literals here", start);
    }

    this.at += match[0].length;

    return Number(this.text.slice(start, this.at));
  }

  string(): string {
    const start = this.at;
    const quote = this.text.charAt(this.at);
    let result = "";

    this.at += 1;

    while (this.at < this.text.length) {
      const char = this.text.charAt(this.at);

      if (char === quote) {
        this.at += 1;

        return result;
      }

      if (quote === "`" && this.text.startsWith("${", this.at)) {
        return this.fail(
          "a template literal with interpolation is not a literal; write the text out"
        );
      }

      if (char === "\n" && quote !== "`") {
        break;
      }

      if (char === "\\") {
        result += this.escape();
      } else {
        result += char;
        this.at += 1;
      }
    }

    return this.fail("a string is never closed", start);
  }

  escape(): string {
    const next = this.text.charAt(this.at + 1);

    this.at += 2;

    if (next === "\n") {
      return "";
    }

    if (next === "\r") {
      if (this.text.charAt(this.at) === "\n") {
        this.at += 1;
      }

      return "";
    }

    if (next === "x") {
      return this.codePoint(/^[\da-fA-F]{2}/u);
    }

    if (next === "u") {
      if (this.text.charAt(this.at) === "{") {
        const close = this.text.indexOf("}", this.at);
        const hex = close === -1 ? "" : this.text.slice(this.at + 1, close);

        if (
          !/^[\da-fA-F]{1,6}$/u.test(hex) ||
          Number.parseInt(hex, 16) > 0x10_ff_ff
        ) {
          return this.fail("a `\\u{...}` escape is malformed");
        }

        this.at = close + 1;

        return String.fromCodePoint(Number.parseInt(hex, 16));
      }

      return this.codePoint(/^[\da-fA-F]{4}/u);
    }

    return ESCAPES.get(next) ?? next;
  }

  codePoint(pattern: RegExp): string {
    const match = pattern.exec(this.text.slice(this.at));

    if (match === null) {
      return this.fail("a hexadecimal escape is malformed");
    }

    this.at += match[0].length;

    return String.fromCodePoint(Number.parseInt(match[0], 16));
  }
}

/** Characters that, opening the next line, would continue the meta expression instead of ending it. */
const CONTINUES_EXPRESSION = new Set([
  "(",
  "[",
  ".",
  "`",
  "+",
  "-",
  "*",
  "/",
  "%",
  ",",
  "?",
  "=",
  "<",
  ">",
  "&",
  "|",
  "^",
  "!",
]);

const META_OPENING = /^export\s+const\s+meta\s*=/u;

/** Where the meta statement is, in `code` (the source with its options line blanked). */
interface MetaStatement {
  readonly exportAt: number;
  readonly literal: Schema.Json;
  readonly end: number;
}

/** Finds and reads the meta statement; null when the first statement is something else. */
const readMetaStatement = (code: string): MetaStatement | null => {
  const exportAt = skipTrivia(code, 0);
  const opening = META_OPENING.exec(code.slice(exportAt));

  if (opening === null) {
    return null;
  }

  const reader = new LiteralReader(code, exportAt + opening[0].length);
  const valueAt = skipTrivia(code, reader.at);

  if (code.charAt(valueAt) !== "{") {
    return reader.fail(
      "`meta` must be an object literal: `export const meta = { name, description, phases }`",
      valueAt
    );
  }

  const literal = reader.value();
  const afterValue = reader.at;
  const next = skipTrivia(code, afterValue);

  if (code.charAt(next) === ";") {
    return { exportAt, literal, end: next + 1 };
  }

  if (
    next < code.length &&
    (!restOfLineIsBlank(code, afterValue) ||
      CONTINUES_EXPRESSION.has(code.charAt(next)))
  ) {
    return reader.fail(
      "the meta object must end its statement; put a `;` after its closing `}`",
      next
    );
  }

  return { exportAt, literal, end: afterValue };
};

// ---------------------------------------------------------------------------------------------
// Top-level declarations: the names a `const`, `let` or `var` statement binds.

const OPENERS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

const isCloser = (text: string) => text === ")" || text === "]" || text === "}";

const isPunct = (token: Token | undefined, text: string) =>
  token?.kind === "punct" && token.text === text;

/** True when a line break separates `token` from the one before it. */
const startsLine = (
  code: string,
  tokens: ReadonlyArray<Token>,
  index: number
) => {
  const before = tokens[index - 1];
  const token = tokens[index];

  return (
    before !== undefined &&
    token !== undefined &&
    code.slice(before.start, token.start).includes("\n")
  );
};

/** True when `token` can end an expression, so a line break after it may end the statement. */
const endsExpression = (token: Token | undefined) =>
  token !== undefined &&
  (token.kind === "literal" ||
    (token.kind === "word" && !REGEX_AFTER_WORDS.has(token.text)) ||
    token.text === ")" ||
    token.text === "]" ||
    token.text === "}");

/** Reads the binding names of one declaration, from the token after its keyword. */
class DeclarationReader {
  readonly code: string;
  readonly tokens: ReadonlyArray<Token>;
  at: number;
  readonly names: Array<Token> = [];

  constructor(code: string, tokens: ReadonlyArray<Token>, from: number) {
    this.code = code;
    this.tokens = tokens;
    this.at = from;
  }

  /** Every declarator: `pattern (= init)?`, separated by commas. */
  read(): ReadonlyArray<Token> {
    for (;;) {
      this.pattern();

      if (isPunct(this.tokens[this.at], "=")) {
        this.at += 1;
        this.expression(new Set([","]), true);
      }

      if (!isPunct(this.tokens[this.at], ",")) {
        return this.names;
      }

      this.at += 1;
    }
  }

  /** A binding: a name, or an object or array pattern. */
  pattern() {
    const token = this.tokens[this.at];

    if (token === undefined) {
      return;
    }

    if (token.kind === "word") {
      this.names.push(token);
      this.at += 1;
    } else if (isPunct(token, "[")) {
      this.at += 1;
      this.elements("]", () => {
        this.pattern();
      });
    } else if (isPunct(token, "{")) {
      this.at += 1;
      this.elements("}", () => {
        this.property();
      });
    }
  }

  /** The elements of a pattern up to `close`, each with an optional default. */
  elements(close: string, element: () => void) {
    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at];

      if (isPunct(token, close)) {
        this.at += 1;

        return;
      }

      if (isPunct(token, ",")) {
        this.at += 1;
      } else {
        while (isPunct(this.tokens[this.at], ".")) {
          this.at += 1;
        }

        const before = this.at;

        element();

        if (isPunct(this.tokens[this.at], "=")) {
          this.at += 1;
          this.expression(new Set([",", close]), false);
        } else if (this.at === before) {
          // Something a pattern cannot hold: step over it rather than loop.
          this.at += 1;
        }
      }
    }
  }

  /** One property of an object pattern: `key: pattern`, `[computed]: pattern` or a shorthand name. */
  property() {
    const token = this.tokens[this.at];

    if (isPunct(token, "[")) {
      this.at += 1;
      this.expression(new Set(["]"]), false);
      this.at += 1;
    } else if (
      token?.kind === "word" &&
      !isPunct(this.tokens[this.at + 1], ":")
    ) {
      this.names.push(token);
      this.at += 1;

      return;
    } else {
      this.at += 1;
    }

    if (isPunct(this.tokens[this.at], ":")) {
      this.at += 1;
      this.pattern();
    }
  }

  /**
   * Steps over an expression to the first of `stops` outside any bracket, a `;`, or (when
   * `statement` is set) a line break after which the statement has ended.
   */
  expression(stops: ReadonlySet<string>, statement: boolean) {
    const open: Array<string> = [];

    while (this.at < this.tokens.length) {
      const token = this.tokens[this.at];

      if (token === undefined) {
        return;
      }

      if (open.length === 0) {
        if (
          token.kind === "punct" &&
          (stops.has(token.text) || token.text === ";" || isCloser(token.text))
        ) {
          return;
        }

        if (
          statement &&
          startsLine(this.code, this.tokens, this.at) &&
          endsExpression(this.tokens[this.at - 1]) &&
          !CONTINUES_EXPRESSION.has(token.text.charAt(0))
        ) {
          return;
        }
      }

      const closer =
        token.kind === "punct" ? OPENERS.get(token.text) : undefined;

      if (closer !== undefined) {
        open.push(closer);
      } else if (token.kind === "punct" && token.text === open.at(-1)) {
        open.pop();
      }

      this.at += 1;
    }
  }
}

/** The names a declaration keyword at `index` binds: one, or several for patterns and lists. */
const declaredNames = (
  code: string,
  tokens: ReadonlyArray<Token>,
  index: number
): ReadonlyArray<Token> => {
  const keyword = tokens[index];
  let next = index + 1;

  if (keyword?.text === "function" && isPunct(tokens[next], "*")) {
    next += 1;
  }

  const name = tokens[next];

  if (keyword?.text === "function" || keyword?.text === "class") {
    return name?.kind === "word" ? [name] : [];
  }

  return new DeclarationReader(code, tokens, next).read();
};

/** The first problem with the body after the meta statement, or null. */
const bodyProblem = (
  code: string,
  from: number
): {
  readonly reason: RefusalReason;
  readonly offset: number;
  readonly problem: string;
} | null => {
  const tokens = tokenize(code, from);
  const reserved = new Set(PRELUDE_NAMES);

  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "word") {
      continue;
    }

    const before = tokens[index - 1];
    const after = tokens[index + 1];

    // `x.export` and `{ export: 1 }` name a property, not the keyword. A word before `:` is a key
    // only after `{` or `,`; after `?` or `case` it is a value and the rules below apply.
    const isProperty =
      (before?.kind === "punct" && before.text === ".") ||
      (after?.kind === "punct" &&
        after.text === ":" &&
        before?.kind === "punct" &&
        (before.text === "{" || before.text === ","));

    if (isProperty) {
      continue;
    }

    if (token.text === "export") {
      return {
        reason: "export_outside_meta",
        offset: token.start,
        problem: "only `meta` may be exported; remove this `export`",
      };
    }

    if (token.text === "import") {
      return {
        reason: "import_statement",
        offset: token.start,
        problem:
          "workflow scripts cannot import modules; the prelude and `tools` are all there is",
      };
    }

    if (token.text.startsWith(PRELUDE_PREFIX)) {
      return {
        reason: "reserved_name",
        offset: token.start,
        problem: `names starting with \`${PRELUDE_PREFIX}\` belong to the prelude; rename \`${token.text}\``,
      };
    }

    const declares = ["const", "let", "var", "function", "class"].includes(
      token.text
    );

    const shadowed =
      declares && token.depth === 0
        ? declaredNames(code, tokens, index).find((name) =>
            reserved.has(name.text)
          )
        : undefined;

    if (shadowed !== undefined) {
      return {
        reason: "reserved_name",
        offset: shadowed.start,
        problem: `\`${shadowed.text}\` is defined by the workflow prelude; use another name`,
      };
    }
  }

  return null;
};

const refusal = (reason: RefusalReason, message: string) =>
  new WorkflowRefusal({ message, reason });

/** The refusal for a problem found at `offset` of `code`. */
const refusalAt = (
  code: string,
  reason: RefusalReason,
  offset: number,
  problem: string
) =>
  refusal(reason, `Workflow script line ${lineOf(code, offset)}: ${problem}.`);

/** The meta literal decoded, or the refusal naming each problem. */
const metaFrom = (literal: Schema.Json) =>
  decodeMeta(literal).pipe(
    Effect.mapError((issue) =>
      refusal(
        "meta_invalid",
        `Workflow meta is not valid: ${issue.message}. It needs \`name\` (lowercase words joined by \`-\`), \`description\`, and optionally \`whenToUse\` and \`phases: [{ title, detail? }]\`; nothing else.`
      )
    ),
    Effect.map((meta): WorkflowMeta => ({
      name: meta.name,
      description: meta.description,
      whenToUse: Option.fromUndefinedOr(meta.whenToUse),
      phases: (meta.phases ?? []).map((phase) => ({
        title: phase.title,
        detail: phase.detail ?? null,
      })),
    }))
  );

/** True when `source`'s first statement is `export const meta =`, the mark of a workflow script. */
export const isWorkflowSource = (source: string): boolean => {
  try {
    const { code } = parseCodemodeSource(source);

    return META_OPENING.test(code.slice(skipTrivia(code, 0)));
  } catch {
    return false;
  }
};

/**
 * The script a source stands for: the built-in recipe a recipe reference names
 * (`export const meta = { name: "council" };`, `recipes/BuiltInRecipes.ts`), else the source as
 * written. Fails with `WorkflowRefusal` when the reference names no recipe.
 */
export const resolveRecipe = (
  source: string
): Effect.Effect<string, WorkflowRefusal> =>
  Option.match(recipeReferenceOf(source), {
    onNone: () => Effect.succeed(source),
    onSome: (name) =>
      Effect.fromOption(
        Option.fromUndefinedOr(BUILT_IN_RECIPES.get(name))
      ).pipe(
        Effect.mapError(() =>
          refusal(
            "unknown_recipe",
            `No recipe is named \`${name}\`. The recipes are ${[...BUILT_IN_RECIPES.keys()].map((known) => `\`${known}\``).join(", ")}; or write the whole script.`
          )
        )
      ),
  });

/**
 * Parses a workflow script without running it. Fails with `WorkflowRefusal` when the source is not
 * a workflow, its options line is malformed or sets `timeout_ms`, `meta` is not a pure literal or
 * not a valid meta, or the body exports, imports or redeclares a prelude name.
 */
export const parseWorkflowScript = Effect.fn("WorkflowScript.parse")(function* (
  source: string
) {
  const split = yield* Effect.try({
    try: () => parseCodemodeSource(source),
    catch: (cause) =>
      refusal(
        "source_unreadable",
        `Workflow script cannot be read: ${cause instanceof CodemodeSourceError ? cause.message : String(cause)}.`
      ),
  });

  if (split.options.timeoutMs !== undefined) {
    return yield* refusal(
      "sets_timeout",
      "Workflow scripts run without a deadline, and a script that sets `timeout_ms` cannot resume after a restart. Remove the `// @options` timeout."
    );
  }

  const { code } = split;
  // `parseCodemodeSource` drops the options line's text and keeps its newline.
  const shift = source.length - code.length;

  const statement = yield* Effect.try({
    try: () => readMetaStatement(code),
    catch: (cause) =>
      cause instanceof SourceProblemError
        ? refusalAt(code, "meta_not_literal", cause.offset, cause.problem)
        : refusal(
            "source_unreadable",
            `Workflow script cannot be read: ${String(cause)}.`
          ),
  });

  if (statement === null) {
    return yield* refusal(
      "not_a_workflow",
      "A workflow script starts with `export const meta = { name, description, phases }` as its first statement, before any other code."
    );
  }

  const problem = yield* Effect.try({
    try: () => bodyProblem(code, statement.end),
    catch: (cause) =>
      cause instanceof SourceProblemError
        ? refusalAt(code, "source_unreadable", cause.offset, cause.problem)
        : refusal(
            "source_unreadable",
            `Workflow script cannot be read: ${String(cause)}.`
          ),
  });

  if (problem !== null) {
    return yield* refusalAt(
      code,
      problem.reason,
      problem.offset,
      problem.problem
    );
  }

  const meta = yield* metaFrom(statement.literal);

  return {
    source,
    hash: scriptHash(source),
    meta,
    exportAt: statement.exportAt + shift,
    metaEnd: statement.end + shift,
  } satisfies WorkflowScript;
});
