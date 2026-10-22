// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/popover.tsx (PopoverPopup) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the popup, width and viewport padding class
// strings of the default (glass) look. Changed: @foldkit/ui's popover Submodel owns the state,
// focus and anchoring; this module renders its button and panel with t3code's classes. The panel
// and tooltip-style looks are left out until a surface needs them.
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
import type { RenderInfo } from "@foldkit/ui/popover";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

/** The popup widths t3code offers. */
export type PopoverWidth = "auto" | "sm" | "md" | "lg";

/** The viewport paddings t3code offers. */
export type PopoverPadding = "default" | "compact" | "none";

const POPUP_CLASS =
  "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)] dropdown-glass shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]";

const WIDTH: Readonly<Record<PopoverWidth, string>> = {
  auto: "",
  sm: "max-w-[calc(100vw-2rem)] w-64",
  md: "max-w-[calc(100vw-2rem)] w-80",
  lg: "max-w-[calc(100vw-2rem)] w-96",
};

const VIEWPORT_CLASS =
  "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) not-data-transitioning:overflow-y-auto";

const PADDING: Readonly<Record<PopoverPadding, string>> = {
  default: "py-4 [--viewport-inline-padding:--spacing(4)]",
  compact: "py-2 [--viewport-inline-padding:--spacing(3)]",
  none: "rounded-[calc(var(--radius-lg)-1px)] py-0 [--viewport-inline-padding:0px]",
};

/** The look of one popover. */
export interface PopoverLook {
  readonly width: PopoverWidth;
  readonly padding: PopoverPadding;
  readonly buttonClass: string;
}

/**
 * The renderer @foldkit/ui's popover view takes as `toView`: the button shows `button`, and the
 * panel shows `content` while the popover is visible.
 */
export const popoverToView =
  <Message>(
    h: HtmlBuilder<Message>,
    look: PopoverLook,
    button: ReadonlyArray<Child>,
    content: ReadonlyArray<Child>
  ) =>
  (render: RenderInfo): Html =>
    h.div(
      [h.Class("contents")],
      [
        h.button([...render.button, h.Class(look.buttonClass)], button),
        render.isVisible
          ? h.div(
              [
                ...render.panel,
                h.DataAttribute("slot", "popover-popup"),
                h.Class(classNames(POPUP_CLASS, WIDTH[look.width])),
              ],
              [
                h.div(
                  [
                    h.DataAttribute("slot", "popover-viewport"),
                    h.Class(classNames(VIEWPORT_CLASS, PADDING[look.padding])),
                  ],
                  content
                ),
              ]
            )
          : h.empty,
      ]
    );
