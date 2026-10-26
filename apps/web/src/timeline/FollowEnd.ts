// Keeps the transcript pinned to its end within the frame its content grows. @foldkit/ui's
// virtual list follows its end too, but through a Message, a render and a Command after the row's
// new height is measured, which paints one or more frames with the end below the fold while a reply
// streams (judges/transcript-scroll.ts measured up to 200 px). This Mount sets `scrollTop` from the
// observers' own callbacks, which run after layout and before paint: a MutationObserver for rows
// patched in, a ResizeObserver for rows that grow.
//
// It follows while the user has not scrolled away: a scroll event that leaves the end more than
// 1 px away stops it at once (before the Model hears of it), and the wrapper's `data-following`
// turning "true" (the pill, or the list's own anchor coming back to its end) starts it again.

import { Effect, Function } from "effect";
import * as Mount from "foldkit/mount";

import { Message } from "./Message.ts";

const SCROLLER = "[data-virtual-list-item-key]";

const THRESHOLD_PX = 1;

const distanceFromEnd = (element: HTMLElement): number =>
  element.scrollHeight - element.clientHeight - element.scrollTop;

const bind = (wrapper: HTMLElement): (() => void) => {
  let following = wrapper.dataset.following === "true";

  let bound: HTMLElement | null = null;

  // A thread switch mounts a new list: it starts from what the Model says about that thread.
  const scroller = (): HTMLElement | null => {
    const element = wrapper.querySelector<HTMLElement>('[role="list"]');

    if (element !== bound) {
      bound = element;
      following = wrapper.dataset.following === "true";
    }

    return element;
  };

  const pin = () => {
    const element = scroller();

    if (following && element !== null && distanceFromEnd(element) > 0.5) {
      element.scrollTop = element.scrollHeight;
    }
  };

  const rows = new ResizeObserver(pin);
  const observed = new Set<Element>();

  const observeRows = () => {
    const current = new Set(wrapper.querySelectorAll(SCROLLER));

    for (const row of observed) {
      if (!current.has(row)) {
        rows.unobserve(row);
        observed.delete(row);
      }
    }

    for (const row of current) {
      if (!observed.has(row)) {
        rows.observe(row);
        observed.add(row);
      }
    }
  };

  const mutations = new MutationObserver((records) => {
    const refollow = records.some(
      (record) =>
        record.type === "attributes" &&
        record.target === wrapper &&
        wrapper.dataset.following === "true"
    );

    if (refollow) {
      following = true;
    }

    observeRows();
    pin();
  });

  const onScroll = (event: Event) => {
    const element = scroller();

    if (element !== null && event.target === element) {
      following = distanceFromEnd(element) <= THRESHOLD_PX;
    }
  };

  mutations.observe(wrapper, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-following"],
  });
  wrapper.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
  });
  observeRows();
  pin();

  return () => {
    mutations.disconnect();
    rows.disconnect();
    wrapper.removeEventListener("scroll", onScroll, { capture: true });
  };
};

/** Pins the transcript's scroll list to its end while it follows. Goes on the list's wrapper. */
export const FollowEnd = Mount.define("FollowEnd", {
  messages: [Message.MountedFollowEnd],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        element instanceof HTMLElement ? bind(element) : Function.constVoid
      ),
      (release) => Effect.sync(release)
    ).pipe(Effect.as(Message.MountedFollowEnd())),
});
