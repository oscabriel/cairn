// The `next` disclosure (the surfaces note's Disclosure): a fold line, a workflow phase, or
// "Previous agents", whose header opens a body below it. Behaviour is @foldkit/ui's disclosure: a
// button with `aria-expanded`, `aria-controls` while open, Enter and Space, and no toggle while
// disabled.
//
// Opening one moves nothing above it, and nothing in its own header line: the header keeps one
// height in both states (its title truncates rather than wrapping, and it is at least `min-h-9`),
// the chevron turns in place, and the tally keeps its slot at the line's end, so the body is the
// only thing that grows, and it grows downward. The body is drawn only while open, so a folded
// disclosure holds nothing for assistive technology or for Tab. `judges/look-rules.ts` opens each
// live disclosure in the catalogue and fails if anything above or on its header moved.
//
// States: folded, open, hover, focus, disabled.

import * as FoldkitDisclosure from "@foldkit/ui/disclosure";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { ChevronRight } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import {
  DISABLED,
  FEEDBACK_MOTION,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
} from "./Classes.ts";
import { glyph } from "./Glyph.ts";

/** A disclosure's id, state and toggle. */
export interface DisclosureConfig<Message> {
  /** The base id; the button and body ids derive from it. Unique on the page. */
  readonly id: string;
  readonly isOpen: boolean;
  /** What a toggle sends, with the state it asks for. */
  readonly onToggle: (isOpen: boolean) => Message;
  readonly isDisabled: boolean;
  /** More attributes on the header button: test ids, `data-hover` and `data-focus`. */
  readonly attributes: ReadonlyArray<Attribute<Message>>;
}

/** What a disclosure shows. */
export interface DisclosureContent {
  /** A status mark or avatar after the chevron. */
  readonly glyph: Option.Option<Html>;
  readonly title: string;
  /** At the header's end: a tally, a steps pill. */
  readonly tally: Option.Option<Html>;
  readonly body: ReadonlyArray<Html>;
}

const HEADER = classNames(
  "group/disclosure flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1) text-start text-ink-2 not-aria-disabled:hover:bg-select-1 not-aria-disabled:hover:text-ink-1 data-hover:bg-select-1 data-hover:text-ink-1 aria-expanded:text-ink-1",
  TYPE.ui,
  WEIGHT_MEDIUM,
  HIT_HEIGHT,
  FOCUS_RING_INSET,
  FEEDBACK_MOTION,
  DISABLED
);

const CHEVRON =
  "inline-flex shrink-0 text-ink-3 motion-safe:transition-transform motion-safe:duration-(--duration-feedback) group-aria-expanded/disclosure:rotate-90";

/** A disclosure: its header line, then its body while open. */
export const disclosure = <Message>(
  h: HtmlBuilder<Message>,
  config: DisclosureConfig<Message>,
  content: DisclosureContent
): Html =>
  FoldkitDisclosure.view(
    {
      id: config.id,
      isOpen: config.isOpen,
      isDisabled: config.isDisabled,
      onToggle: config.onToggle,
      toView: ({ button, panel }) =>
        h.div(
          [
            h.DataAttribute("slot", "disclosure"),
            h.Class("flex min-w-0 flex-col"),
          ],
          [
            h.button(
              [
                ...button,
                h.DataAttribute("slot", "disclosure-header"),
                ...config.attributes,
                h.Class(HEADER),
              ],
              [
                h.span(
                  [h.Class(CHEVRON)],
                  [glyph(h, ChevronRight, "chevron-right", "regular")]
                ),
                Option.getOrElse(content.glyph, () => h.empty),
                h.span([h.Class("min-w-0 flex-1 truncate")], [content.title]),
                Option.match(content.tally, {
                  onNone: () => h.empty,
                  onSome: (tally) =>
                    h.span(
                      [
                        h.DataAttribute("slot", "disclosure-tally"),
                        h.Class("ms-auto shrink-0"),
                      ],
                      [tally]
                    ),
                }),
              ]
            ),
            config.isOpen
              ? h.div(
                  [
                    ...panel,
                    h.DataAttribute("slot", "disclosure-body"),
                    h.Class("min-w-0 ps-(--space-8) pe-(--space-2)"),
                  ],
                  content.body
                )
              : h.empty,
          ]
        ),
    },
    h
  );
