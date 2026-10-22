// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/toast.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the toast card, content, title, description and
// corner dismiss class strings. Changed: @foldkit/ui's toast container, bound to Cairn's payload,
// owns the stack, timers and swipe; this module renders one entry with t3code's classes. The
// expandable detail and action buttons are left out until a surface needs them.
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
import * as UiToast from "@foldkit/ui/toast";
import type { EntryHandlers } from "@foldkit/ui/toast";
import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

/** What one toast says. */
export const ToastPayload = Schema.Struct({
  title: Schema.String,
  description: Schema.Option(Schema.String),
});

export type ToastPayload = typeof ToastPayload.Type;

/** The toast container bound to Cairn's payload: its Model, Messages, update and view. */
export const Toast = UiToast.make(ToastPayload);

/** One entry as the container holds it. */
export type ToastEntry = typeof Toast.Entry.Type;

const CARD_CLASS =
  "dropdown-glass relative w-full overflow-visible select-none rounded-lg text-popover-foreground shadow-xl shadow-black/25";

const CONTENT_CLASS =
  "pointer-events-auto flex min-h-0 items-center justify-between gap-1.5 overflow-y-visible py-3 pr-3.5 pl-3.5 text-sm [overflow-x:clip]";

const DISMISS_CLASS = "absolute z-20 -top-1.5 -right-1.5";

const DISMISS_ORB_CLASS =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

/** The renderer the container takes as `entryToView`. */
export const toastEntryView =
  <Message>(h: HtmlBuilder<Message>) =>
  (entry: ToastEntry, handlers: EntryHandlers): Html =>
    h.div(
      [
        h.DataAttribute("slot", "toast-popup"),
        h.DataAttribute("type", entry.variant.toLowerCase()),
        h.Class(CARD_CLASS),
      ],
      [
        h.div(
          [h.Class(DISMISS_CLASS)],
          [
            h.button(
              [
                ...handlers.dismiss,
                h.AriaLabel("Dismiss"),
                h.Class(DISMISS_ORB_CLASS),
              ],
              ["×"]
            ),
          ]
        ),
        h.div(
          [h.Class(CONTENT_CLASS)],
          [
            h.div(
              [h.Class("flex min-h-0 min-w-0 flex-1 flex-col gap-0.5")],
              [
                h.div(
                  [
                    h.DataAttribute("slot", "toast-title"),
                    h.Class("min-w-0 wrap-break-word font-medium"),
                  ],
                  [entry.payload.title]
                ),
                Option.match(entry.payload.description, {
                  onNone: () => h.empty,
                  onSome: (description) =>
                    h.div(
                      [
                        h.DataAttribute("slot", "toast-description"),
                        h.Class(
                          "min-w-0 select-text wrap-break-word text-muted-foreground"
                        ),
                      ],
                      [description]
                    ),
                }),
              ]
            ),
          ]
        ),
      ]
    );
