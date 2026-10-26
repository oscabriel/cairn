// Ported from github.com/pingdotgg/t3code, apps/web/src/lib/softwareKeyboard.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the Virtual Keyboard API when the browser gives
// its geometry, else the visual-viewport heuristic (adapted by t3code from Ionic's keyboard assist,
// MIT, Copyright (c) 2015-present Drifty Co.): the keyboard is open after the viewport shrinks by
// more than 150 px at the same width, and closed when the viewport is back to the window's height;
// desktops never have one. Changed: a Stream for a Foldkit Subscription instead of a React store.
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

import { Effect, Option, Predicate, Queue, Stream } from "effect";

const KEYBOARD_THRESHOLD_PX = 150;

/** The Virtual Keyboard API's part this module reads; Chromium ships it, others do not. */
interface VirtualKeyboard extends EventTarget {
  readonly boundingRect: { readonly height: number };
  readonly overlaysContent: boolean;
}

const virtualKeyboard = (): Option.Option<VirtualKeyboard> => {
  const candidate: unknown =
    "virtualKeyboard" in navigator ? navigator.virtualKeyboard : undefined;

  return Predicate.hasProperty(candidate, "boundingRect") &&
    Predicate.hasProperty(candidate, "overlaysContent") &&
    candidate instanceof EventTarget
    ? Option.some(
        // SAFETY: checked above: an EventTarget with the two properties the API defines.
        // Verified by: judges/typing.ts --mobile (Enter types a newline with the keyboard open).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        candidate as VirtualKeyboard
      )
    : Option.none();
};

const snapshot = (viewport: VisualViewport) => ({
  width: Math.round(viewport.width),
  height: Math.round(viewport.height),
  scale: viewport.scale,
});

/**
 * Whether a soft keyboard covers the page, now and on every change. Emits nothing on a pointer
 * device (a desktop never has one).
 */
export const softwareKeyboardChanges: Stream.Stream<boolean> =
  Stream.callback<boolean>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const desktop = matchMedia("(pointer: fine)").matches;
        const viewport = desktop ? null : globalThis.visualViewport;
        const keyboard = desktop ? Option.none() : virtualKeyboard();
        let viewportOpen = false;
        let previous = viewport === null ? null : snapshot(viewport);
        let lastReported: boolean | null = null;

        const current = (): boolean =>
          Option.match(
            Option.filter(
              keyboard,
              (api) => api.overlaysContent || api.boundingRect.height > 0
            ),
            {
              onNone: () => viewportOpen,
              onSome: (api) => api.boundingRect.height > 0,
            }
          );

        const report = () => {
          const open = current();

          if (open !== lastReported) {
            lastReported = open;
            Queue.offerUnsafe(queue, open);
          }
        };

        const onViewportResize = () => {
          if (viewport === null) {
            return;
          }

          const now = snapshot(viewport);

          const shrunk =
            previous === null ? 0 : (previous.height - now.height) * now.scale;

          if (Math.abs(now.height - innerHeight / now.scale) <= 1) {
            viewportOpen = false;
          } else if (
            !viewportOpen &&
            previous?.width === now.width &&
            shrunk > KEYBOARD_THRESHOLD_PX
          ) {
            viewportOpen = true;
          }

          previous = now;
          report();
        };

        if (viewport !== null) {
          // A composer can mount after the keyboard already opened.
          viewportOpen =
            innerHeight - viewport.height * viewport.scale >
            KEYBOARD_THRESHOLD_PX;
          viewport.addEventListener("resize", onViewportResize);
        }

        Option.map(keyboard, (api) => {
          api.addEventListener("geometrychange", report);
        });

        if (!desktop) {
          report();
        }

        return { viewport, keyboard, onViewportResize, report };
      }),
      (listeners) =>
        Effect.sync(() => {
          listeners.viewport?.removeEventListener(
            "resize",
            listeners.onViewportResize
          );
          Option.map(listeners.keyboard, (api) => {
            api.removeEventListener("geometrychange", listeners.report);
          });
        })
    ).pipe(Effect.flatMap(() => Effect.never))
  );
