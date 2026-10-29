// The `next` tally (the surfaces note's Tally): counts with their words on one line, "4 agents ·
// 2 working · 1 done", for a fold line (S12), a rollup or a previous-agents fold. Counts are in
// tabular figures, so a count that changes keeps its width and the words after it stay put. Each
// part's word says what it counts, so a part's tone is never its only sign.

import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE } from "./Classes.ts";
import type { Tone } from "./Tone.ts";
import { TONE_TEXT } from "./Tone.ts";

/** One count and its word: `{ count: 2, word: "working", tone: "working" }`. */
export interface TallyPart {
  readonly count: number;
  readonly word: string;
  /** The part's ink; `neutral` for the quiet ink. */
  readonly tone: Tone;
}

/**
 * The parts a tally shows: the first always (the total, even at zero), then each later part that
 * counts something. "3 agents · 0 failed" says nothing the first part did not.
 */
export const shownParts = (
  parts: ReadonlyArray<TallyPart>
): ReadonlyArray<TallyPart> =>
  parts.filter((part, index) => index === 0 || part.count > 0);

/** The tally's words as one string, as it reads: "4 agents · 2 working · 1 done". */
export const tallyText = (parts: ReadonlyArray<TallyPart>): string =>
  shownParts(parts)
    .map((part) => `${String(part.count)} ${part.word}`)
    .join(" · ");

/** A tally: each shown part's count in tabular figures and its word, separated by middle dots. */
export const tally = <Message>(
  h: HtmlBuilder<Message>,
  parts: ReadonlyArray<TallyPart>,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "tally"),
      ...attributes,
      h.Class(
        classNames(
          "inline-flex min-w-0 flex-wrap items-baseline gap-x-(--space-1) text-ink-2",
          TYPE.small
        )
      ),
    ],
    shownParts(parts).flatMap((part, index) => [
      index === 0
        ? h.empty
        : h.span([h.AriaHidden(true), h.Class("text-ink-3")], ["·"]),
      h.span(
        [
          h.DataAttribute("tally-part", part.word),
          h.Class(classNames("whitespace-nowrap", TONE_TEXT[part.tone])),
        ],
        [
          h.span([h.Class("tabular-nums")], [String(part.count)]),
          ` ${part.word}`,
        ]
      ),
    ])
  );
