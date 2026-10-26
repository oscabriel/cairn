// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ProjectMonogram.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the monogram tile's SVG and classes. Changed: a
// Foldkit view over any message type, so the sidebar and the page header draw the same tile; no
// favicon lookup.
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

import {
  deriveProjectIdentity,
  monogramGlyphCount,
} from "@cairn/client-logic/Sidebar";
import type { Html, HtmlBuilder } from "foldkit/html";

/**
 * A project's monogram tile, as t3code draws a project with no favicon: two letters in the
 * project's colour on a tint of it.
 */
export const projectMark = <Message>(
  h: HtmlBuilder<Message>,
  projectTitle: string,
  className: string
): Html => {
  const identity = deriveProjectIdentity(projectTitle);

  return h.span(
    [h.AriaHidden(true), h.Class(className)],
    [
      h.svg(
        [
          h.Attribute("viewBox", "0 0 16 16"),
          h.Attribute(
            "class",
            `size-full overflow-hidden rounded-[25%] font-mono select-none ${identity.colorClassName}`
          ),
          h.Style({
            "background-color":
              "color-mix(in srgb, currentColor 14%, transparent)",
          }),
        ],
        [
          h.text(
            [
              h.Attribute("x", "8"),
              h.Attribute("y", "10.8"),
              h.Attribute("text-anchor", "middle"),
              h.Attribute("fill", "currentColor"),
              h.Attribute("class", "font-mono"),
              h.Attribute("font-size", "8.25"),
              h.Attribute("font-weight", "700"),
              h.Attribute(
                "textLength",
                monogramGlyphCount(identity.monogram) === 1 ? "6" : "12"
              ),
              h.Attribute("lengthAdjust", "spacingAndGlyphs"),
              h.Attribute("text-rendering", "geometricPrecision"),
            ],
            [identity.monogram]
          ),
        ]
      ),
    ]
  );
};
