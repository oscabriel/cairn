// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/kbd.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the class strings. Changed: Foldkit views.
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

/** The class string of one key. */
export const KBD_CLASS =
  "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3";

/** The class string of a group of keys. */
export const KBD_GROUP_CLASS = "inline-flex items-center gap-1";

/** One key, as in a shortcut hint. */
export const kbd = <Message>(h: HtmlBuilder<Message>, key: string): Html =>
  h.kbd([h.DataAttribute("slot", "kbd"), h.Class(KBD_CLASS)], [key]);

/** A shortcut: one key per element, grouped. */
export const kbdGroup = <Message>(
  h: HtmlBuilder<Message>,
  keys: ReadonlyArray<string>
): Html =>
  h.kbd(
    [h.DataAttribute("slot", "kbd-group"), h.Class(KBD_GROUP_CLASS)],
    keys.map((key) => kbd(h, key))
  );
