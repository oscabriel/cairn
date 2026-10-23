// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/switch.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the track and thumb class strings and both sizes.
// Changed: a Foldkit view over @foldkit/ui's switch, which owns the ARIA and the hidden input; the
// mixed state is left out.
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
import * as Switch from "@foldkit/ui/switch";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "./ClassNames.ts";

/** The switch sizes. */
export type SwitchSize = "default" | "sm";

const TRACK_CLASS =
  "inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-64 data-[mixed]:bg-input";

const SIZE: Readonly<Record<SwitchSize, string>> = {
  default: "[--thumb-size:--spacing(5)] sm:[--thumb-size:--spacing(4)]",
  sm: "[--thumb-size:--spacing(4)] sm:[--thumb-size:--spacing(3.5)]",
};

const THUMB_CLASS =
  "pointer-events-none block size-[calc(var(--thumb-size)-2px)] shrink-0 origin-left in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] rounded-(--thumb-size) bg-background shadow-sm/5 dark:data-unchecked:bg-muted-foreground [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-right data-checked:translate-x-[calc(var(--thumb-size)-4px)]";

/** A switch's state and wiring. */
export interface SwitchConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly size: SwitchSize;
  readonly isChecked: boolean;
  readonly isDisabled: boolean;
  readonly onToggle: (isChecked: boolean) => Message;
}

/** A t3code-styled switch with a visible label after it. */
export const switchView = <Message>(
  h: HtmlBuilder<Message>,
  config: SwitchConfig<Message>
): Html =>
  Switch.view(
    {
      id: config.id,
      isChecked: config.isChecked,
      isDisabled: config.isDisabled,
      onToggle: config.onToggle,
      toView: (attributes) =>
        h.div(
          [h.Class("flex items-center gap-2")],
          [
            h.button(
              [
                ...attributes.button,
                h.DataAttribute("slot", "switch"),
                h.DataAttribute("size", config.size),
                // @foldkit/ui sets only data-checked; Base UI also marks the unchecked track, which
                // its `data-unchecked:bg-input` keys on.
                ...(config.isChecked ? [] : [h.DataAttribute("unchecked", "")]),
                h.Class(classNames(TRACK_CLASS, SIZE[config.size])),
              ],
              [
                h.span([
                  h.DataAttribute("slot", "switch-thumb"),
                  // The thumb's classes key on its own state attribute, as Base UI sets it.
                  h.DataAttribute(
                    config.isChecked ? "checked" : "unchecked",
                    ""
                  ),
                  h.Class(THUMB_CLASS),
                ]),
              ]
            ),
            h.label([...attributes.label, h.Class("text-sm")], [config.label]),
            h.input(attributes.hiddenInput),
          ]
        ),
    },
    h
  );
