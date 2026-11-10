// The status chip: one state as its mark, its word and its tone, never colour alone (surfaces
// note, StatusMark and StateWord). A thread's state reaches it through `statusOfLabel`, from the one
// state table (`STATE_LOOKS`, which `THREAD_LABELS` and `HOLD_LABELS` read), so a row, a banner
// and a header say the same word in the same tone with the same mark.

import type { StateLook } from "@cairn/client-logic/ThreadState";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { TYPE, WEIGHT_MEDIUM } from "./Classes.ts";
import { classNames } from "./ClassNames.ts";
import type { StatusMark } from "./Glyph.ts";
import { statusGlyph } from "./Glyph.ts";
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

/** The status a state draws as: its word, its tone and its mark, all from the one state table. */
export const statusOfLabel = (label: StateLook): Status => ({
  tone: toneOfThreadTone(label.tone),
  mark: label.mark,
  word: label.word,
});
