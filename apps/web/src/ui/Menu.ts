// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/menu.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the popup, item, group label, separator and
// shortcut class strings. Changed: @foldkit/ui's menu Submodel owns the state, keyboard and
// typeahead; this module supplies t3code's classes for its view inputs and an item renderer.
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

import type { GroupHeading, ItemConfig } from "@foldkit/ui/menu";
import type { HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

/** The class string of the menu's popup. */
export const MENU_POPUP_CLASS =
  "dropdown-glass relative flex origin-(--transform-origin) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none focus:outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)] [-webkit-app-region:no-drag] min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col p-1";

/** The class string of one item. @foldkit/ui sets `data-active` where Base UI sets `data-highlighted`. */
export const MENU_ITEM_CLASS =
  "[&>svg]:-mx-0.5 flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-active:bg-accent data-inset:ps-8 data-[variant=destructive]:text-destructive-foreground data-highlighted:text-accent-foreground data-active:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current [&>svg]:pointer-events-none [&>svg]:shrink-0";

/** The class string of a group's label. */
export const MENU_GROUP_LABEL_CLASS =
  "px-2 py-1.5 font-medium text-muted-foreground text-xs data-inset:ps-9 sm:data-inset:ps-8";

/** The class string of a separator. */
export const MENU_SEPARATOR_CLASS = "mx-2 my-1 h-px bg-border";

/** The class string of an item's shortcut hint. */
export const MENU_SHORTCUT_CLASS =
  "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest";

/** The classes @foldkit/ui's menu view takes, as t3code draws them. */
export const menuClassNames = {
  itemsClassName: MENU_POPUP_CLASS,
  groupClassName: "flex flex-col",
  separatorClassName: MENU_SEPARATOR_CLASS,
} as const;

/** An item's look: its label, and its shortcut when it has one. */
export interface MenuItemLook {
  readonly label: ReadonlyArray<Child>;
  readonly shortcut: ReadonlyArray<string>;
  readonly isDestructive: boolean;
}

/** One item for @foldkit/ui's `itemToConfig`, with t3code's classes. */
export const menuItem = <Message>(
  h: HtmlBuilder<Message>,
  look: MenuItemLook
): ItemConfig => ({
  className: classNames(MENU_ITEM_CLASS),
  content: h.span(
    [
      h.Class("flex min-w-0 flex-1 items-center gap-2"),
      ...(look.isDestructive
        ? [h.DataAttribute("variant", "destructive")]
        : []),
    ],
    [
      h.span([h.Class("min-w-0 truncate")], look.label),
      look.shortcut.length === 0
        ? h.empty
        : h.kbd([h.Class(MENU_SHORTCUT_CLASS)], [look.shortcut.join("")]),
    ]
  ),
});

/** A group heading for @foldkit/ui's `groupToHeading`. */
export const menuGroupHeading = <Message>(
  h: HtmlBuilder<Message>,
  label: string
): GroupHeading => ({
  content: h.span([], [label]),
  className: MENU_GROUP_LABEL_CLASS,
});
