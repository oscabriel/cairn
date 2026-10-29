// The status chip: one state as its mark, its word and its tone, never colour alone (surfaces
// note, StatusMark and StateWord). A thread's state reaches it through `labelChip`, from the one
// thread-state function's `THREAD_LABELS` and `HOLD_LABELS`, so a row, a banner and a header say
// the same word in the same tone.

import type { ThreadTone } from "@cairn/client-logic/ThreadState";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_MEDIUM } from "./Classes.ts";
import type { StatusMark } from "./Glyph.ts";
import { markOfTone, statusGlyph } from "./Glyph.ts";
import type { Tone } from "./Tone.ts";
import { TONE_TEXT, TONE_WASH, toneOfThreadTone } from "./Tone.ts";

/** A status: its tone, its mark and its word. */
export interface Status {
  readonly tone: Tone;
  readonly mark: StatusMark;
  readonly word: string;
}

/** The class string of a status chip in `tone`. */
export const statusChipClass = (tone: Tone): string =>
  classNames(
    "inline-flex shrink-0 items-center gap-(--space-1) whitespace-nowrap rounded-(--radius-round) py-(--space-0-5) ps-(--space-1-5) pe-(--space-2)",
    TYPE.small,
    WEIGHT_MEDIUM,
    TONE_WASH[tone],
    TONE_TEXT[tone]
  );

/** A status as a chip: its mark, then its word, on its tone's wash. */
export const statusChip = <Message>(
  h: HtmlBuilder<Message>,
  status: Status,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "status-chip"),
      h.DataAttribute("tone", status.tone),
      ...attributes,
      h.Class(statusChipClass(status.tone)),
    ],
    [statusGlyph(h, status.mark, "small"), h.span([], [status.word])]
  );

/** The status a thread label draws as: its word, its tone, and that tone's mark. */
export const statusOfLabel = (label: {
  readonly word: string;
  readonly tone: ThreadTone;
}): Status => {
  const tone = toneOfThreadTone(label.tone);

  return { tone, mark: markOfTone(tone), word: label.word };
};
