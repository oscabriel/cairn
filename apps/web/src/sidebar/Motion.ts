// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.motion.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: FLIP motion for the row list with the Web
// Animations API (150 ms, ease-out): rows that move slide from their old place, new rows fade and
// slide in, removed rows leave a fading copy; animations already running carry their remaining
// offset; nothing animates under `prefers-reduced-motion` or when more than 40 rows would fade.
// Changed: a Foldkit Mount on the list that measures after every change a MutationObserver reports,
// instead of React layout effects; the drag release path is not ported (no drag).
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

const TIMING: KeyframeAnimationOptions = { duration: 150, easing: "ease-out" };

const MAX_FADED_ROWS_PER_UPDATE = 40;

const rowTravel = (height: number) => Math.min(height, 40);

interface RowPosition {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

const progress = (animation: Animation): number =>
  animation.playState === "finished"
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);

const STRIPPED_ATTRIBUTES = new Set(["id", "data-thread-item", "data-testid"]);

/** The motion controller of one list: call `update` after its children change. */
interface ListMotion {
  readonly update: () => void;
  readonly dispose: () => void;
}

const createListMotion = (parent: HTMLElement): ListMotion => {
  let positions: Map<HTMLElement, RowPosition> | undefined;
  let disposed = false;

  const reducedMotion = parent.ownerDocument.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)"
  );

  const running = new Map<
    HTMLElement,
    { animation: Animation; offset: number }
  >();

  const entering = new Map<
    HTMLElement,
    { animation: Animation; travel: number }
  >();

  const exiting = new Map<HTMLElement, Animation>();

  const remainingOffset = (node: HTMLElement): number => {
    const current = running.get(node);
    const entry = entering.get(node);

    return (
      (current === undefined
        ? 0
        : current.offset * (1 - progress(current.animation))) +
      (entry === undefined ? 0 : entry.travel * (1 - progress(entry.animation)))
    );
  };

  const clearFades = () => {
    for (const entry of entering.values()) {
      entry.animation.cancel();
    }

    for (const [node, animation] of exiting) {
      animation.cancel();
      node.remove();
    }

    entering.clear();
    exiting.clear();
  };

  const fadeOut = (
    node: HTMLElement,
    position: RowPosition,
    travel: number
  ) => {
    if (position.height === 0) {
      return;
    }

    const clone = node.cloneNode(true);

    if (!(clone instanceof HTMLElement)) {
      return;
    }

    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const name of element.getAttributeNames()) {
        if (
          STRIPPED_ATTRIBUTES.has(name) &&
          !(
            name === "id" &&
            element.namespaceURI === "http://www.w3.org/2000/svg"
          )
        ) {
          element.removeAttribute(name);
        }
      }
    }

    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    Object.assign(clone.style, {
      position: "absolute",
      top: `${position.top + remainingOffset(node)}px`,
      left: `${position.left}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: "0",
      boxSizing: "border-box",
      contentVisibility: "visible",
      transform: "none",
      transition: "none",
      pointerEvents: "none",
    });
    parent.append(clone);

    const entry = entering.get(node);

    const animation = clone.animate(
      [
        {
          opacity: entry === undefined ? 1 : progress(entry.animation),
          transform: "translateY(0px)",
        },
        { opacity: 0, transform: `translateY(${travel}px)` },
      ],
      TIMING
    );

    exiting.set(clone, animation);
    animation.addEventListener(
      "finish",
      () => {
        clone.remove();
        exiting.delete(clone);
      },
      { once: true }
    );
  };

  const cancel = (node: HTMLElement) => {
    running.get(node)?.animation.cancel();
    running.delete(node);
  };

  const move = (node: HTMLElement, offset: number) => {
    cancel(node);

    const entry = entering.get(node);

    if (entry !== undefined) {
      entry.travel = 0;
    }

    if (offset === 0 && entry === undefined) {
      return;
    }

    const animation = node.animate(
      [
        { transform: `translateY(${offset}px)` },
        { transform: "translateY(0px)" },
      ],
      TIMING
    );

    running.set(node, { animation, offset });
    animation.addEventListener(
      "finish",
      () => {
        if (running.get(node)?.animation === animation) {
          running.delete(node);
        }
      },
      { once: true }
    );
  };

  const measure = (): Map<HTMLElement, RowPosition> =>
    new Map(
      [...parent.children].flatMap((node) =>
        node instanceof HTMLElement && !exiting.has(node)
          ? [
              [
                node,
                {
                  top: node.offsetTop,
                  left: node.offsetLeft,
                  width: node.offsetWidth,
                  height: node.offsetHeight,
                },
              ] as const,
            ]
          : []
      )
    );

  /** How many rows would fade in or out between two measurements. */
  const countFades = (
    previous: ReadonlyMap<HTMLElement, RowPosition>,
    next: ReadonlyMap<HTMLElement, RowPosition>
  ): number => {
    let count = 0;

    for (const [node, position] of previous) {
      if (!next.has(node) && position.height > 0) {
        count += 1;
      }
    }

    for (const [node, position] of next) {
      if (!previous.has(node) && position.height > 0) {
        count += 1;
      }
    }

    return count;
  };

  /** The offset a row rides on: the motion of the nearest row above it that stays. */
  const ridingDelta = (
    movedDelta: ReadonlyMap<HTMLElement, number>,
    order: ReadonlyArray<HTMLElement>,
    index: number,
    retained: (node: HTMLElement) => boolean
  ): number | undefined => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const node = order[cursor];
      const delta = node === undefined ? undefined : movedDelta.get(node);

      if (delta !== undefined) {
        return delta;
      }

      if (node !== undefined && retained(node)) {
        return remainingOffset(node);
      }
    }

    return undefined;
  };

  const enter = (node: HTMLElement, travel: number) => {
    const animation = node.animate(
      [
        { opacity: 0, transform: `translateY(${travel}px)` },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      TIMING
    );

    entering.set(node, { animation, travel });
    animation.addEventListener(
      "finish",
      () => {
        if (entering.get(node)?.animation === animation) {
          entering.delete(node);
        }
      },
      { once: true }
    );
  };

  /** Starts the animations from `previous` to `next`. */
  const animate = (
    previous: ReadonlyMap<HTMLElement, RowPosition>,
    next: ReadonlyMap<HTMLElement, RowPosition>
  ) => {
    const movedDelta = new Map<HTMLElement, number>();
    const nextOrder = [...next.keys()];
    const oldOrder = [...previous.keys()];

    for (const [node, position] of next) {
      const previousTop = previous.get(node)?.top;

      if (previousTop !== undefined && previousTop !== position.top) {
        movedDelta.set(
          node,
          previousTop + remainingOffset(node) - position.top
        );
      }
    }

    for (const [node, position] of previous) {
      if (!next.has(node)) {
        const delta = ridingDelta(
          movedDelta,
          oldOrder,
          oldOrder.indexOf(node),
          (row) => next.has(row)
        );

        fadeOut(
          node,
          position,
          delta === undefined ? rowTravel(position.height) : -delta
        );
      }
    }

    for (const [index, node] of nextOrder.entries()) {
      const position = next.get(node);
      const isNew = !previous.has(node);
      const delta = movedDelta.get(node);

      if (isNew && position !== undefined && position.height > 0) {
        enter(
          node,
          ridingDelta(movedDelta, nextOrder, index, (row) =>
            previous.has(row)
          ) ?? -rowTravel(position.height)
        );
      } else if (delta !== undefined) {
        move(node, delta);
      }
    }
  };

  const update = () => {
    if (disposed) {
      return;
    }

    const next = measure();
    const previous = positions;

    positions = next;

    if (previous === undefined) {
      return;
    }

    const shouldAnimate =
      reducedMotion?.matches !== true &&
      countFades(previous, next) <= MAX_FADED_ROWS_PER_UPDATE;

    if (shouldAnimate) {
      animate(previous, next);
    } else {
      clearFades();
    }

    for (const [node, entry] of entering) {
      if (!next.has(node)) {
        entry.animation.cancel();
        entering.delete(node);
      }
    }

    for (const node of running.keys()) {
      if (!shouldAnimate || !next.has(node)) {
        cancel(node);
      }
    }
  };

  return {
    update,
    dispose: () => {
      for (const node of running.keys()) {
        cancel(node);
      }

      clearFades();
      disposed = true;
    },
  };
};

/**
 * Animates the row list's changes. The list is measured once when it mounts, then again after every
 * change to its children, so each change animates from the positions before it.
 */
export const ListMotion = Mount.define("ListMotion", {
  messages: [Message.CompletedMotion],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (!(element instanceof HTMLElement)) {
          return Option.none();
        }

        const motion = createListMotion(element);

        const observer = new MutationObserver((records) => {
          // The fading copies this controller adds and removes are its own changes.
          if (records.some((record) => record.type === "childList")) {
            motion.update();
          }
        });

        motion.update();
        observer.observe(element, { childList: true, subtree: false });

        return Option.some({ motion, observer });
      }),
      (handle) =>
        Effect.sync(() => {
          Option.map(handle, ({ motion, observer }) => {
            observer.disconnect();
            motion.dispose();
          });
        })
    ).pipe(Effect.as(Message.CompletedMotion())),
});
