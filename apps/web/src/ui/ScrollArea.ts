// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/scroll-area.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the root and viewport class strings. Changed:
// the native scrollbar replaces Base UI's drawn one (the viewport is a plain overflow container),
// and the scroll-fade options are left out until a surface needs them.
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
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

/** The class string of the scroll area's root. */
export const SCROLL_AREA_CLASS =
  "relative size-full min-h-0 overflow-hidden rounded-[inherit]";

/** The class string of the scrolling viewport inside it. */
export const SCROLL_VIEWPORT_CLASS =
  "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain";

/** A scrolling region: `className` sizes the root, `children` scroll inside it. */
export const scrollArea = <Message>(
  h: HtmlBuilder<Message>,
  className: string,
  children: ReadonlyArray<Child>
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "scroll-area"),
      h.Class(classNames(SCROLL_AREA_CLASS, className)),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "scroll-area-viewport"),
          h.Class(SCROLL_VIEWPORT_CLASS),
        ],
        children
      ),
    ]
  );
