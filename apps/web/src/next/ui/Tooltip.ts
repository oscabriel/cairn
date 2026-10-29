// The `next` tooltip: a short line on the overlay surface that names what a pointer rests on. It
// repeats a name the control already has (an icon button's `aria-label`) and never holds the only
// copy of anything, since a phone has no hover. @foldkit/ui's tooltip owns the delay, the anchoring
// and visibility through `tooltipToView`; `tooltipBubble` draws the bubble alone, for the catalogue.

import type { RenderInfo } from "@foldkit/ui/tooltip";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE } from "./Classes.ts";

/** The class string of the tooltip's bubble. */
export const TOOLTIP_CLASS = classNames(
  "max-w-[min(20rem,calc(100vw-2rem))] w-max rounded-(--radius-small) border border-stroke-1 bg-surface-overlay px-(--space-2) py-(--space-1) text-ink-1 shadow-(--elevation-2) wrap-break-word",
  TYPE.small
);

/** The bubble alone, with the tooltip role; `id` is what its trigger's `aria-describedby` names. */
export const tooltipBubble = <Message>(
  h: HtmlBuilder<Message>,
  id: string,
  text: string,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.div(
    [
      h.Id(id),
      h.Role("tooltip"),
      h.DataAttribute("slot", "tooltip"),
      ...attributes,
      h.Class(TOOLTIP_CLASS),
    ],
    [text]
  );

/**
 * The renderer @foldkit/ui's tooltip view takes as `toView`: the trigger wraps `trigger`, and the
 * bubble shows `text` while the tooltip is visible.
 */
export const tooltipToView =
  <Message>(h: HtmlBuilder<Message>, trigger: Html, text: string) =>
  (render: RenderInfo): Html =>
    h.span(
      [h.Class("inline-flex")],
      [
        h.span([...render.trigger, h.Class("inline-flex")], [trigger]),
        render.isVisible
          ? h.div(
              [
                ...render.panel,
                h.DataAttribute("slot", "tooltip"),
                h.Class(classNames(TOOLTIP_CLASS, "z-(--layer-tooltip)")),
              ],
              [text]
            )
          : h.empty,
      ]
    );
