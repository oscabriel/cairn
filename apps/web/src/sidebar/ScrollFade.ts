// Ported in behaviour from github.com/pingdotgg/t3code, apps/web/src/components/ui/scroll-area.tsx
// (Base UI's ScrollArea viewport) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the viewport
// publishes how far its content overflows above and below (`--scroll-area-overflow-y-start` and
// `-end`, with `data-has-overflow-y`, `data-overflow-y-start` and `data-overflow-y-end`), which the
// viewport's mask classes turn into the fade at a scrolled edge. Changed: a Foldkit Mount that
// measures on scroll, on resize and when the rows change.
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

import { Effect, Option } from "effect";
import * as Mount from "foldkit/mount";

import { Message } from "./Message.ts";

const toggle = (element: HTMLElement, name: string, on: boolean) => {
  element.toggleAttribute(name, on);
};

/** Publishes how far the viewport's content overflows, for its fade mask. */
const measure = (viewport: HTMLElement) => {
  const start = Math.max(0, viewport.scrollTop);

  const end = Math.max(
    0,
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
  );

  viewport.style.setProperty("--scroll-area-overflow-x-start", "0px");
  viewport.style.setProperty("--scroll-area-overflow-x-end", "0px");
  viewport.style.setProperty("--scroll-area-overflow-y-start", `${start}px`);
  viewport.style.setProperty("--scroll-area-overflow-y-end", `${end}px`);
  toggle(viewport, "data-has-overflow-y", start + end > 0);
  toggle(viewport, "data-overflow-y-start", start > 0);
  toggle(viewport, "data-overflow-y-end", end > 0);
};

/** Keeps a scroll viewport's overflow variables current while it is mounted. */
export const ScrollFade = Mount.define("ScrollFade", {
  messages: [Message.CompletedScrollFade],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) {
          return Option.none();
        }

        const update = () => {
          measure(element);
        };

        const resize = new ResizeObserver(update);
        const rows = new MutationObserver(update);

        resize.observe(element);
        rows.observe(element, { childList: true, subtree: true });
        element.addEventListener("scroll", update, { passive: true });
        update();

        return Option.some({ update, resize, rows });
      }),
      (handle) =>
        Effect.sync(() => {
          Option.map(handle, ({ resize, rows, update }) => {
            resize.disconnect();
            rows.disconnect();
            element.removeEventListener("scroll", update);
          });
        })
    ).pipe(Effect.as(Message.CompletedScrollFade())),
});
