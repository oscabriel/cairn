// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/select.tsx (selectTriggerVariants
// and the item classes) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the trigger's base and
// default class strings. Changed: a native `<select>` through @foldkit/ui's select stands in for
// Base UI's popup select, which suits the settings page and the phone; the popup classes are kept
// below for the custom pickers that will need them.
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
import * as Select from "@foldkit/ui/select";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "./ClassNames.ts";

/** The class string of the trigger's frame, shared by every select look. */
export const SELECT_TRIGGER_BASE_CLASS =
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 border rounded-lg text-left text-base outline-none transition-[color,box-shadow,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4";

/** The class string of the default (input-like) trigger. */
export const SELECT_TRIGGER_DEFAULT_CLASS =
  "w-full min-w-36 border-input bg-background not-dark:bg-clip-padding text-foreground shadow-xs/5 ring-ring/24 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-inset aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 dark:bg-input/32 dark:aria-invalid:ring-destructive/24 dark:not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='text-'])]:text-icon-muted [[data-disabled],:focus-visible,[aria-invalid],[data-pressed]]:shadow-none";

/** The class string of the popup's frame, for custom pickers. */
export const SELECT_POPUP_CLASS =
  "dropdown-glass relative h-full rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]";

/** The class string of one option in a custom picker. */
export const SELECT_ITEM_CLASS =
  "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none data-selected:bg-foreground/[0.08] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

/** One choice: what is sent and what is shown. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/** A select's state and wiring. */
export interface SelectConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly isDisabled: boolean;
  readonly onChange: (value: string) => Message;
}

/** A labelled, t3code-styled native select. */
export const selectView = <Message>(
  h: HtmlBuilder<Message>,
  config: SelectConfig<Message>
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      isDisabled: config.isDisabled,
      onChange: config.onChange,
      toView: (attributes) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.label([...attributes.label, h.Class("text-sm")], [config.label]),
            h.select(
              [
                ...attributes.select,
                h.DataAttribute("slot", "select-trigger"),
                h.Class(
                  classNames(
                    SELECT_TRIGGER_BASE_CLASS,
                    SELECT_TRIGGER_DEFAULT_CLASS,
                    "h-9 px-[calc(--spacing(3)-1px)] sm:h-8"
                  )
                ),
              ],
              config.options.map((option) =>
                h.option(
                  [
                    h.Key(option.value),
                    h.Value(option.value),
                    h.Selected(option.value === config.value),
                  ],
                  [option.label]
                )
              )
            ),
          ]
        ),
    },
    h
  );
