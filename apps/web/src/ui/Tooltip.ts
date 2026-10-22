// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/tooltip.tsx (TooltipPopup) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the popup and viewport class strings of the
// default and code looks. Changed: @foldkit/ui's tooltip Submodel owns the state, the delay and the
// anchoring; this module renders its trigger and panel with t3code's classes.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import type { RenderInfo } from "@foldkit/ui/tooltip";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

/** The tooltip looks t3code uses. */
export type TooltipVariant = "default" | "code";

const POPUP_CLASS =
  "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)] border bg-popover not-dark:bg-clip-padding shadow-md/5";

const VARIANT: Readonly<Record<TooltipVariant, string>> = {
  default: "max-w-80 wrap-anywhere whitespace-normal leading-snug",
  code: "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed",
};

const VIEWPORT_CLASS =
  "relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)]";

/**
 * The renderer @foldkit/ui's tooltip view takes as `toView`: the trigger wraps `trigger`, and the
 * panel shows `content` while the tooltip is visible.
 */
export const tooltipToView =
  <Message>(
    h: HtmlBuilder<Message>,
    variant: TooltipVariant,
    trigger: ReadonlyArray<Child>,
    content: ReadonlyArray<Child>
  ) =>
  (render: RenderInfo): Html =>
    h.span(
      [h.Class("inline-flex")],
      [
        h.span([...render.trigger, h.Class("inline-flex")], trigger),
        render.isVisible
          ? h.div(
              [
                ...render.panel,
                h.DataAttribute("slot", "tooltip-popup"),
                h.Class(classNames(POPUP_CLASS, VARIANT[variant])),
              ],
              [
                h.div(
                  [
                    h.DataAttribute("slot", "tooltip-viewport"),
                    h.Class(VIEWPORT_CLASS),
                  ],
                  content
                ),
              ]
            )
          : h.empty,
      ]
    );
