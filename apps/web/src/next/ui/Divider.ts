// The `next` divider: a hairline in `--stroke-1` across a list or between toolbar groups, and the
// labelled form ("Previous agents", a day) with the words centred on the line.

import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_MEDIUM } from "./Classes.ts";

/** A divider's direction: across a column, or upright between items in a row. */
export type DividerOrientation = "horizontal" | "vertical";

/** A plain hairline. */
export const divider = <Message>(
  h: HtmlBuilder<Message>,
  orientation: DividerOrientation
): Html =>
  h.div([
    h.Role("separator"),
    h.AriaOrientation(orientation),
    h.DataAttribute("slot", "divider"),
    h.Class(
      orientation === "horizontal"
        ? "h-px w-full shrink-0 bg-stroke-1"
        : "w-px self-stretch shrink-0 bg-stroke-1"
    ),
  ]);

/** A horizontal hairline with words on it. */
export const labelledDivider = <Message>(
  h: HtmlBuilder<Message>,
  label: string
): Html =>
  h.div(
    [
      h.Role("separator"),
      h.AriaLabel(label),
      h.DataAttribute("slot", "divider"),
      h.Class(
        classNames(
          "flex min-w-0 items-center gap-(--space-3) text-ink-3 before:h-px before:flex-1 before:bg-stroke-1 after:h-px after:flex-1 after:bg-stroke-1",
          TYPE.small,
          WEIGHT_MEDIUM
        )
      ),
    ],
    [
      h.span(
        [
          h.AriaHidden(true),
          h.Class("min-w-0 max-w-[70%] text-center break-words"),
        ],
        [label]
      ),
    ]
  );
