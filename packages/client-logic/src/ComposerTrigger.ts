// Ported from github.com/pingdotgg/t3code, packages/shared/src/composerTrigger.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the `/`, `/model`, `@` and skill triggers read
// from the text and caret alone, the path-word rule that keeps `/tmp/x` out of the slash menu, the
// markdown file link a picked path inserts, and the range replacement. Changed: the `#` pull
// request trigger is gone (Cairn has no pull request context), a skill trigger is a literal `$`
// only, not t3code's any-currency-symbol rule (plan D29), and "no trigger" is `Option.none()`.
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
import { Option, Schema } from "effect";

/** What a trigger opens: the file search, the command list, the model picker or the skill list. */
export const ComposerTriggerKind = Schema.Literals([
  "path",
  "slash-command",
  "slash-model",
  "skill",
]);

export type ComposerTriggerKind = typeof ComposerTriggerKind.Type;

/** A trigger under the caret: its kind, the query typed after it, and the text range it covers. */
export const ComposerTrigger = Schema.Struct({
  kind: ComposerTriggerKind,
  query: Schema.String,
  rangeStart: Schema.Int,
  rangeEnd: Schema.Int,
});

export type ComposerTrigger = typeof ComposerTrigger.Type;

/** The character that starts a skill reference. */
export const SKILL_TRIGGER = "$";

const basename = (path: string): string => {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  return separator >= 0 ? path.slice(separator + 1) : path;
};

const escapeLinkLabel = (label: string): string =>
  label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");

const encodeLinkDestination = (path: string): string =>
  encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");

/** The markdown link a picked file becomes: its basename as the label, its encoded path as the target. */
export const serializeComposerFileLink = (path: string): string =>
  `[${escapeLinkLabel(basename(path))}](${encodeLinkDestination(path)})`;

const clampCursor = (text: string, cursor: number): number =>
  Number.isFinite(cursor)
    ? Math.max(0, Math.min(text.length, Math.floor(cursor)))
    : text.length;

const isWhitespace = (character: string): boolean =>
  character === " " ||
  character === "\n" ||
  character === "\t" ||
  character === "\r";

/**
 * A slash word with a second slash, such as `/tmp/build.sh`, is a path, not a command. The whole
 * word counts, so a caret before the second slash still sees it.
 */
export const isPathWord = (
  text: string,
  wordStart: number,
  cursor: number
): boolean => {
  let wordEnd = cursor;

  while (wordEnd < text.length && !isWhitespace(text.charAt(wordEnd))) {
    wordEnd += 1;
  }

  return text.slice(wordStart + 1, wordEnd).includes("/");
};

const trigger = (
  kind: ComposerTriggerKind,
  query: string,
  rangeStart: number,
  rangeEnd: number
): Option.Option<ComposerTrigger> =>
  Option.some({ kind, query, rangeStart, rangeEnd });

const lineStartTrigger = (
  text: string,
  cursor: number,
  lineStart: number
): Option.Option<Option.Option<ComposerTrigger>> => {
  const linePrefix = text.slice(lineStart, cursor);

  if (!linePrefix.startsWith("/")) {
    return Option.none();
  }

  const command = /^\/(?<query>\S*)$/u.exec(linePrefix);

  if (command !== null) {
    if (isPathWord(text, lineStart, cursor)) {
      return Option.some(Option.none());
    }

    const query = command.groups?.query ?? "";

    return Option.some(
      query.toLowerCase() === "model"
        ? trigger("slash-model", "", lineStart, cursor)
        : trigger("slash-command", query, lineStart, cursor)
    );
  }

  const model = /^\/model(?:\s+(?<query>.*))?$/u.exec(linePrefix);

  return model === null
    ? Option.none()
    : Option.some(
        trigger(
          "slash-model",
          (model.groups?.query ?? "").trim(),
          lineStart,
          cursor
        )
      );
};

/**
 * The trigger the caret sits in, if any. A `/` that opens a line is a command (or `/model` and its
 * query); elsewhere a word starting with `/` is a command unless it is a path, `$` starts a skill and
 * `@` a file search.
 */
export const detectComposerTrigger = (
  text: string,
  cursorInput: number
): Option.Option<ComposerTrigger> => {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const atLineStart = lineStartTrigger(text, cursor, lineStart);

  if (Option.isSome(atLineStart)) {
    return atLineStart.value;
  }

  let index = cursor - 1;

  while (index >= 0 && !isWhitespace(text.charAt(index))) {
    index -= 1;
  }

  const tokenStart = index + 1;
  const token = text.slice(tokenStart, cursor);

  if (token.startsWith("/")) {
    return isPathWord(text, tokenStart, cursor)
      ? Option.none()
      : trigger("slash-command", token.slice(1), tokenStart, cursor);
  }

  if (token.startsWith(SKILL_TRIGGER)) {
    return trigger(
      "skill",
      token.slice(SKILL_TRIGGER.length),
      tokenStart,
      cursor
    );
  }

  return token.startsWith("@")
    ? trigger("path", token.slice(1), tokenStart, cursor)
    : Option.none();
};

/** Text with `[rangeStart, rangeEnd)` replaced, and the caret just after the replacement. */
export interface TextReplacement {
  readonly text: string;
  readonly cursor: number;
}

/** Replaces a range of `text`, clamping a stale range into the text. */
export const replaceTextRange = (
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string
): TextReplacement => {
  const start = Math.max(0, Math.min(text.length, rangeStart));
  const end = Math.max(start, Math.min(text.length, rangeEnd));

  return {
    text: `${text.slice(0, start)}${replacement}${text.slice(end)}`,
    cursor: start + replacement.length,
  };
};

/**
 * Applies a menu pick to the trigger it was read from, refusing when the text in the trigger's
 * range changed since (the user typed on while results loaded).
 */
export const applyTriggerReplacement = (
  text: string,
  read: ComposerTrigger,
  expectedRangeText: string,
  replacement: string
): Option.Option<TextReplacement> =>
  text.slice(read.rangeStart, read.rangeEnd) === expectedRangeText
    ? Option.some(
        replaceTextRange(text, read.rangeStart, read.rangeEnd, replacement)
      )
    : Option.none();
