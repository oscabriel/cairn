// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/skeleton.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the class strings. Changed: a Foldkit view.
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

import { classNames } from "./ClassNames.ts";

/** How round the placeholder's corners are. */
export type SkeletonRounding = "block" | "card" | "pill";

const ROUNDING: Readonly<Record<SkeletonRounding, string>> = {
  block: "rounded-sm",
  card: "rounded-lg",
  pill: "rounded-full",
};

/** A loading placeholder; `className` sizes it. */
export const skeleton = <Message>(
  h: HtmlBuilder<Message>,
  rounding: SkeletonRounding,
  className: string
): Html =>
  h.div([
    h.DataAttribute("slot", "skeleton"),
    h.Class(
      classNames(
        "bg-muted-foreground/15 motion-safe:animate-skeleton",
        ROUNDING[rounding],
        className
      )
    ),
  ]);
