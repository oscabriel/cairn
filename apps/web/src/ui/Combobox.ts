// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/combobox.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the popup, list, item and search-input class
// strings (the picker t3code's project filter and model picker use). Changed: @foldkit/ui's
// combobox Submodel owns the state, filtering input and keyboard; this module supplies t3code's
// classes for its view inputs and an item renderer. Their colours are the tokens (U-13), as
// the composer's popovers' are (`composer/PopoverClasses.ts`): an opaque overlay ground where t3code's was
// a translucent glass, and the ink, select ladder and strokes for its classic colour names.
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

import type { ItemConfig } from "@foldkit/ui/combobox";
import type { HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";

/** The class string of the popup: the overlay ground with its hairline and the top elevation. */
export const COMBOBOX_POPUP_CLASS =
  "relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-(--radius-medium) border border-stroke-2 bg-surface-overlay text-ink-1 shadow-(--elevation-3) transition-[scale,opacity]";

/** The class string of the scrolling list inside the popup. */
export const COMBOBOX_LIST_CLASS =
  "flex min-w-0 max-h-[min(var(--available-height),23rem)] flex-1 flex-col overflow-hidden text-ink-1";

/** The class string of one option. @foldkit/ui sets `data-active` where Base UI sets `data-highlighted`. */
export const COMBOBOX_ITEM_CLASS =
  "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-select-2 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-select-3 data-selected:text-ink-1 data-highlighted:bg-select-2 data-active:bg-select-2 data-highlighted:text-ink-1 data-active:text-ink-1 [&[data-highlighted][data-selected]]:bg-select-2 [&[data-highlighted][data-selected]]:text-ink-1 data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

/** The class string of the search field's frame inside the popup. */
export const COMBOBOX_SEARCH_WRAPPER_CLASS =
  "relative -translate-y-px border-b border-stroke-1 pb-1.5 transition-colors focus-within:border-stroke-focus [&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5";

/** The classes @foldkit/ui's combobox view takes, as t3code draws them. */
export const comboboxClassNames = {
  itemsClassName: COMBOBOX_POPUP_CLASS,
  itemsScrollClassName: COMBOBOX_LIST_CLASS,
  inputWrapperClassName: COMBOBOX_SEARCH_WRAPPER_CLASS,
  inputClassName:
    "w-full bg-transparent text-sm outline-none placeholder:text-ink-3",
} as const;

/** One option for @foldkit/ui's `itemToConfig`, with t3code's classes. */
export const comboboxItem = <Message>(
  h: HtmlBuilder<Message>,
  label: ReadonlyArray<Child>
): ItemConfig => ({
  className: COMBOBOX_ITEM_CLASS,
  content: h.span(
    [
      h.Class(
        "flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-ink-2"
      ),
    ],
    label
  ),
});
