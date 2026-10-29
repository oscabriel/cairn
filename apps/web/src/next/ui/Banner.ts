// The `next` banner: one line across a page or above the composer that says something holds (a
// parked thread, a provider limit, a parent waiting on its child), in a tone, with its mark, its
// words and at most two actions. Its words wrap on the phone and the actions drop under them, so
// nothing is cut. A failed or waiting banner is announced (`role="alert"` or `"status"`).

import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_MEDIUM } from "./Classes.ts";
import type { StatusMark } from "./Glyph.ts";
import { markOfTone, statusGlyph } from "./Glyph.ts";
import type { Tone } from "./Tone.ts";
import { TONE_RULE, TONE_TEXT, TONE_WASH } from "./Tone.ts";

/** What a banner says. */
export interface BannerContent {
  readonly tone: Tone;
  /** The mark before the words; the tone's own when none. */
  readonly mark: Option.Option<StatusMark>;
  /** The few words that say what holds. */
  readonly title: string;
  /** More words after the title, quieter. */
  readonly detail: Option.Option<string>;
  readonly actions: ReadonlyArray<Html>;
}

/** The class string of a banner in `tone`. */
export const bannerClass = (tone: Tone): string =>
  classNames(
    "flex min-w-0 flex-wrap items-center gap-x-(--space-3) gap-y-(--space-2) rounded-(--radius-small) border-l-3 px-(--space-3) py-(--space-2) text-ink-1",
    TYPE.ui,
    TONE_WASH[tone],
    TONE_RULE[tone]
  );

/** A banner: mark, title and detail, then its actions. */
export const banner = <Message>(
  h: HtmlBuilder<Message>,
  content: BannerContent,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "banner"),
      h.DataAttribute("tone", content.tone),
      h.Role(content.tone === "failed" ? "alert" : "status"),
      ...attributes,
      h.Class(bannerClass(content.tone)),
    ],
    [
      h.div(
        [h.Class("flex min-w-0 flex-[1_1_16rem] items-start gap-(--space-2)")],
        [
          h.span(
            [h.Class(classNames("mt-0.5", TONE_TEXT[content.tone]))],
            [
              statusGlyph(
                h,
                Option.getOrElse(content.mark, () => markOfTone(content.tone)),
                "regular"
              ),
            ]
          ),
          h.p(
            [h.Class("min-w-0 break-words")],
            [
              h.span([h.Class(WEIGHT_MEDIUM)], [content.title]),
              ...Option.match(content.detail, {
                onNone: () => [],
                onSome: (detail) => [
                  " ",
                  h.span([h.Class("text-ink-2")], [detail]),
                ],
              }),
            ]
          ),
        ]
      ),
      content.actions.length === 0
        ? h.empty
        : h.div(
            [h.Class("ms-auto flex shrink-0 flex-wrap gap-(--space-2)")],
            content.actions
          ),
    ]
  );
