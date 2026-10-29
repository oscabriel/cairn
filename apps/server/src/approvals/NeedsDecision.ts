// Ported from github.com/HazAT/ultimate, extensions/messages/triage.ts at
// 8b26338680fc5bc970b68c281c4e9b03a09887c1 (`needsDecision`). Changed: written to Cairn's
// standards with `Predicate` and `Option`, and used by the subagent relay (ADR 0027) rather than by
// a triage model's shortcut: a subagent's final plain answer that asks for a decision becomes a
// question to its parent instead of a result.
//
// MIT License. Copyright (c) 2026 Daniel Griesser.
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

import { Option } from "effect";

/** A line without its surrounding space and any trailing emphasis or code marks. */
const bare = (line: string) => line.trim().replace(/[*_`]+$/u, "");

/** A numbered list item: `1.` or `1)` and a space. */
const NUMBERED = /^\d+[.)]\s/u;

/** A numbered item, or a line indented under one. */
const ITEM_OR_INDENTED = /^\s*\d+[.)]\s|^\s{2,}\S/u;

/** Words that make a lead line ending in a colon introduce a decision. */
const DECISION_WORDS = /decision|option|choose|choice|pick/iu;

/** Lettered options on a numbered line: a decisions block. */
const LETTERED = /^\s*\d+[.)]\s.*\(a\)/mu;

/**
 * Whether an answer asks for a decision: it ends with a question, or with numbered options. A
 * numbered list led by a line such as "Once it has landed, I'll:" is plan steps, unless that line
 * names a decision or the answer has lettered options.
 */
export const needsDecision = (text: string): boolean => {
  const lines = text.trim().split("\n");
  const last = bare(lines.at(-1) ?? "");

  if (last.endsWith("?")) {
    return true;
  }

  if (!NUMBERED.test(last)) {
    return false;
  }

  const lead = Option.fromUndefinedOr(
    lines.findLast((line) => line.trim() !== "" && !ITEM_OR_INDENTED.test(line))
  );

  return Option.match(lead, {
    onNone: () => true,
    onSome: (found) =>
      !bare(found).endsWith(":") ||
      DECISION_WORDS.test(found) ||
      LETTERED.test(text),
  });
};

/** A top-level numbered item: its number and its label. */
const NUMBERED_ITEM = /^(?<number>\d+)[.)]\s+(?<label>\S.*)$/u;

/**
 * The options an answer ends with (Cairn's own, not in the source): the labels of a trailing list
 * of top-level items numbered `1` to `n` in order, without trailing emphasis marks. Empty when the
 * answer does not end with such a list, its numbers do not run from 1, or it has one item.
 */
export const decisionOptions = (text: string): ReadonlyArray<string> => {
  const items: Array<{ readonly number: number; readonly label: string }> = [];

  for (const line of text.trim().split("\n").toReversed()) {
    const item = NUMBERED_ITEM.exec(line.trimEnd());

    if (item === null) {
      break;
    }

    const number = item.groups?.number ?? "";

    items.unshift({
      number: Number(number),
      label: bare(item.groups?.label ?? ""),
    });

    if (number === "1") {
      break;
    }
  }

  const inOrder = items.every((item, index) => item.number === index + 1);

  return items.length >= 2 && inOrder ? items.map((item) => item.label) : [];
};
