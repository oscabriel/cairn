// The usage page the sidebar's foot opens: a place held for the spend and plan-window meters, which
// a later package fills (plan wave 6, 6G). Until then it says so.

import type { Html, HtmlBuilder } from "foldkit/html";
import { Gauge } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_STRONG } from "../ui/Classes.ts";
import { glyph } from "../ui/Glyph.ts";

/** The usage page's placeholder. */
export const usagePage = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute("testid", "usage-page"),
      h.Class(
        "flex flex-1 flex-col items-center justify-center gap-(--space-3) p-(--space-6) text-center text-ink-2"
      ),
    ],
    [
      h.span([h.Class("text-ink-3")], [glyph(h, Gauge, "gauge", "large")]),
      h.h2(
        [h.Class(classNames("text-ink-1", TYPE.title, WEIGHT_STRONG))],
        ["Usage"]
      ),
      h.p(
        [h.Class(classNames("max-w-md", TYPE.ui))],
        [
          "What each thread and workflow spent, and the model plans' windows, will show here.",
        ]
      ),
    ]
  );
