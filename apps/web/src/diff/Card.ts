// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ChangedFilesTree.tsx
// (`ChangedFilesCard`'s props) and apps/web/src/components/chat/DiffStatLabel.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the card's input (the turn, its files and what
// opening the diff sends), the stat label with one label for screen readers, and a compact count
// above a thousand. Changed: generic over its parent's Message, and a count of the files the brain
// counted but did not list (it lists the first 500). The diff panel (`View.ts`) draws the label;
// the transcript's card is `CardView.ts`, and the classic card's view was deleted (W-6).
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

import type { DiffStat, TurnDiffFile } from "@cairn/client-logic/DiffTree";
import type { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

/** What the card shows and the Message it sends to open the diff. */
export interface ChangedFilesCardInput<Message> {
  readonly turn: number;
  readonly files: ReadonlyArray<TurnDiffFile>;
  /** Files the brain counted but did not list. */
  readonly moreFiles: number;
  /** The Message that opens the turn's diff, at a file when one is given. */
  readonly onOpen: (path: Option.Option<string>) => Message;
}

/** True when a stat has something to show. */
export const hasNonZeroStat = (stat: DiffStat): boolean =>
  stat.additions > 0 || stat.deletions > 0;

/** `1234` as `1.2k`, as t3code shows large counts. */
export const formatCompactCount = (value: number): string => {
  const scaled = (divisor: number, suffix: string) => {
    const amount = value / divisor;

    return `${amount < 10 ? amount.toFixed(1).replace(/\.0$/u, "") : String(Math.round(amount))}${suffix}`;
  };

  if (value < 1000) {
    return String(value);
  }

  return value < 1_000_000 ? scaled(1000, "k") : scaled(1_000_000, "m");
};

/** `+3 -1`, green and red, with one label for screen readers. */
export const diffStatLabel = <Message>(
  h: HtmlBuilder<Message>,
  stat: DiffStat,
  layout: "aligned" | "inline",
  className = ""
): Html =>
  h.span(
    [
      h.Role("group"),
      h.AriaLabel(
        `${String(stat.additions)} additions, ${String(stat.deletions)} deletions`
      ),
      h.Class(
        `${layout === "inline" ? "inline-flex items-center gap-1 tabular-nums align-middle" : "inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle"} ${className}`
      ),
    ],
    [
      h.span(
        [h.AriaHidden(true), h.Class("font-mono text-diff-addition")],
        [`+${formatCompactCount(stat.additions)}`]
      ),
      h.span(
        [h.AriaHidden(true), h.Class("font-mono text-diff-deletion")],
        [`-${formatCompactCount(stat.deletions)}`]
      ),
    ]
  );
