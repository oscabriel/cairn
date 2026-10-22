// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/dialog-styles.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the backdrop, popup and mobile sheet class
// strings. Changed: @foldkit/ui's dialog Submodel owns the native `<dialog>`, focus and scroll lock;
// this module renders its parts with t3code's classes. The media look is left out.
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
import type { RenderInfo } from "@foldkit/ui/dialog";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

/** The class string of the dimmed layer behind a dialog. */
export const DIALOG_BACKDROP_CLASS =
  "dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0";

/** The class string of the dialog's card. */
export const DIALOG_POPUP_CLASS =
  "dialog-glass -translate-y-[calc(1.25rem*var(--nested-dialogs))] relative flex min-h-0 w-full min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag] rounded-2xl border";

/** The phone layout: the card becomes a sheet at the bottom. */
export const DIALOG_MOBILE_SHEET_CLASS =
  "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4";

/** The class string of the layer that centres the card (a bottom sheet on phones). */
export const DIALOG_VIEWPORT_CLASS =
  "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12";

const HEADER_CLASS =
  "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4";

const TITLE_CLASS = "wrap-anywhere font-semibold text-xl leading-none";

const DESCRIPTION_CLASS = "text-muted-foreground text-sm";

const PANEL_CLASS =
  "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1";

const FOOTER_CLASS =
  "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 py-4";

/** A dialog's text. */
export interface DialogText {
  readonly title: string;
  readonly description: string;
}

/**
 * The renderer @foldkit/ui's dialog view takes as `toView`: a titled card with a description,
 * `body` and `footer` (its actions).
 */
export const dialogToView =
  <Message>(
    h: HtmlBuilder<Message>,
    text: DialogText,
    body: ReadonlyArray<Child>,
    footer: ReadonlyArray<Child>
  ) =>
  (render: RenderInfo): Html =>
    h.dialog(
      [...render.dialog, h.Class("bg-transparent p-0 backdrop:bg-transparent")],
      [
        h.div([...render.backdrop, h.Class(DIALOG_BACKDROP_CLASS)]),
        h.div(
          [
            h.DataAttribute("slot", "dialog-viewport"),
            h.Class(DIALOG_VIEWPORT_CLASS),
          ],
          [
            h.div(
              [
                ...render.panel,
                h.DataAttribute("slot", "dialog-popup"),
                h.Class(
                  classNames(
                    DIALOG_POPUP_CLASS,
                    "row-start-2 text-popover-foreground max-h-full max-w-lg",
                    DIALOG_MOBILE_SHEET_CLASS
                  )
                ),
              ],
              [
                h.div(
                  [
                    h.DataAttribute("slot", "dialog-header"),
                    h.Class(HEADER_CLASS),
                  ],
                  [
                    h.h2([...render.title, h.Class(TITLE_CLASS)], [text.title]),
                    h.p(
                      [...render.description, h.Class(DESCRIPTION_CLASS)],
                      [text.description]
                    ),
                  ]
                ),
                h.div(
                  [
                    h.DataAttribute("slot", "dialog-panel"),
                    h.Class(PANEL_CLASS),
                  ],
                  body
                ),
                h.div(
                  [
                    h.DataAttribute("slot", "dialog-footer"),
                    h.Class(FOOTER_CLASS),
                  ],
                  footer
                ),
              ]
            ),
          ]
        ),
      ]
    );
