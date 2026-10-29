// The `next` chip: a short label on a tone's wash, with an optional leading glyph and a count in
// tabular figures. A plain chip only shows; a toggle chip is a button that filters (`aria-pressed`)
// and is a full touch target on a coarse pointer. Status chips, which always carry a word and a
// mark, are `StatusChip.ts`.

import * as FoldkitButton from "@foldkit/ui/button";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
} from "./Classes.ts";
import type { Tone } from "./Tone.ts";
import { TONE_TEXT, TONE_WASH } from "./Tone.ts";

const BASE = classNames(
  "inline-flex max-w-full min-w-0 shrink-0 items-center gap-(--space-1) rounded-(--radius-round) px-(--space-2) py-(--space-0-5)",
  TYPE.small,
  WEIGHT_MEDIUM
);

const TOGGLE = classNames(
  "cursor-pointer border border-stroke-2 text-ink-2 not-aria-pressed:hover:bg-select-1 data-hover:bg-select-1 aria-pressed:border-stroke-focus aria-pressed:bg-accent-wash aria-pressed:text-ink-1",
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

/** The class string of a plain chip in `tone`. */
export const chipClass = (tone: Tone): string =>
  classNames(BASE, TONE_WASH[tone], TONE_TEXT[tone]);

/** What a chip shows. */
export interface ChipContent {
  /** Drawn before the label, in the chip's ink. */
  readonly glyph: Option.Option<Html>;
  readonly label: string;
  /** A count after the label, in tabular figures. */
  readonly count: Option.Option<number>;
}

const contentOf = <Message>(
  h: HtmlBuilder<Message>,
  content: ChipContent
): ReadonlyArray<Html> => [
  Option.getOrElse(content.glyph, () => h.empty),
  h.span([h.Class("min-w-0 truncate")], [content.label]),
  Option.match(content.count, {
    onNone: () => h.empty,
    onSome: (count) =>
      h.span(
        [h.DataAttribute("chip-count", ""), h.Class("tabular-nums text-ink-3")],
        [String(count)]
      ),
  }),
];

/** A chip that only shows: a label in a tone. */
export const chip = <Message>(
  h: HtmlBuilder<Message>,
  tone: Tone,
  content: ChipContent,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "chip"),
      h.DataAttribute("tone", tone),
      ...attributes,
      h.Class(chipClass(tone)),
    ],
    contentOf(h, content)
  );

/** A toggle chip's state and click. */
export interface ToggleChipConfig<Message> {
  readonly isPressed: boolean;
  readonly onClick: Option.Option<Message>;
  readonly attributes: ReadonlyArray<Attribute<Message>>;
}

/** A chip that filters: a button whose pressed state is `aria-pressed`. */
export const toggleChip = <Message>(
  h: HtmlBuilder<Message>,
  config: ToggleChipConfig<Message>,
  content: ChipContent
): Html =>
  FoldkitButton.view(
    {
      ...Option.match(config.onClick, {
        onNone: () => ({}),
        onSome: (onClick) => ({ onClick }),
      }),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.DataAttribute("slot", "chip"),
            h.AriaPressed(config.isPressed ? "true" : "false"),
            ...config.attributes,
            h.Class(classNames(BASE, TOGGLE)),
          ],
          contentOf(h, content)
        ),
    },
    h
  );
