// The `next` tooltip: a short line on the overlay surface that names what a pointer rests on. It
// repeats a name the control already has (an icon button's `aria-label`) and never holds the only
// copy of anything, since a phone has no hover. @foldkit/ui's tooltip owns the delay, the anchoring
// and visibility through `tooltipToView`; `tooltipBubble` draws the bubble alone, for the catalogue.
// `withTooltip` is the live views' form (U-15): the same bubble under a control, shown by CSS from
// `md` while the pointer rests on it or it has keyboard focus, so a header or a row needs no state
// per control.

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

/**
 * Where a hover tooltip sits: under its control or over it (for a control at the foot of the
 * screen), lined up with the control's start edge, its centre or its end edge, so it stays on
 * screen at either end.
 */
export type TooltipAlign =
  | "start"
  | "center"
  | "end"
  | "above-center"
  | "above-end";

const ALIGN: Readonly<Record<TooltipAlign, string>> = {
  start: "top-full mt-(--space-1) start-0",
  center: "top-full mt-(--space-1) start-1/2 -translate-x-1/2",
  end: "top-full mt-(--space-1) end-0",
  "above-center": "bottom-full mb-(--space-1) start-1/2 -translate-x-1/2",
  "above-end": "bottom-full mb-(--space-1) end-0",
};

/**
 * `control` with its tooltip under it (or over it, `align`): from `md`, the bubble shows while the pointer rests on the
 * control or the control has keyboard focus, and never on a phone or while the menu the control
 * opens is open. It repeats the control's own accessible name, so it is hidden from assistive
 * technology, which already hears the name.
 */
export const withTooltip = <Message>(
  h: HtmlBuilder<Message>,
  control: Html,
  text: string,
  align: TooltipAlign = "center"
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "tooltip-anchor"),
      h.Class("group/tooltip relative inline-flex shrink-0"),
    ],
    [
      control,
      h.span(
        [
          h.DataAttribute("slot", "tooltip"),
          h.AriaHidden(true),
          h.Class(
            classNames(
              TOOLTIP_CLASS,
              "pointer-events-none absolute z-(--layer-tooltip) hidden md:group-hover/tooltip:block md:group-has-[:focus-visible]/tooltip:block group-has-[[aria-expanded=true]]/tooltip:invisible",
              ALIGN[align]
            )
          ),
        ],
        [text]
      ),
    ]
  );
