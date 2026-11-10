// Class strings copied from t3code's rendered composer at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92
// (apps/web/src/components/chat/{ChatComposer,ComposerSurface,ComposerPrimaryActions}.tsx and
// BranchToolbar.tsx, read from the live nightly's DOM and the S2 spike's capture). The theme-id
// variants are dropped with t3code's themes. Only the footer menus' classes are left: the classic
// composer's view and its footer went with the classic views (W-6). Their colours are the `next`
// tokens (U-13), so the popovers drawn inside the frame take the look and its contrast judge.
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

/**
 * A popover's panel, on the `next` tokens (U-13): the opaque overlay ground with its hairline and
 * the top elevation, where t3code's was a translucent glass the page showed through.
 */
export const POPUP_CLASS =
  "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) overflow-hidden rounded-(--radius-medium) border border-stroke-2 bg-surface-overlay text-ink-1 shadow-(--elevation-3) outline-none transition-[width,height,scale,opacity]";

/** One row of a footer menu. */
export const MENU_ITEM_CLASS =
  "[&>svg]:-mx-0.5 flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-ink-1 outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed hover:bg-select-2 data-active:bg-select-2 data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-ink-2 [&>svg]:pointer-events-none [&>svg]:shrink-0";
