// Keeps the reader's place in the measured list, from the observers' own callbacks (after layout,
// before paint), and reports what the list Model needs: the scroll position, the scroller's size,
// and the height of every row drawn on screen or off it.
//
// - While following, the end stays in view within the frame the content grows (this was
//   FollowEnd.ts). A scroll from the reader that leaves the end more than 1 px away stops it;
//   `data-following` turning "true" on the scroller starts it again.
// - Otherwise the first visible row keeps its offset through every change above it: rows joining
//   the range, rows re-measured, rows inserted, a settled row that grows.
// - Through a width change, the character being read keeps its place: a glyph near the top of the
//   viewport, bookmarked through `caretRangeFromPoint` as a row and a character offset after each
//   scroll, is put back where it was. The row anchor alone keeps the row's top, which loses the
//   line being read once the row rewraps.
// - Off-screen measurements taken during a gesture wait for it to settle (Update.ts).
// - Wheel or key input up stops following before its first scroll, but only when it can move the
//   scroller away from its end: the scroller overflows and is not at its top, no element between
//   the input's target and the scroller can take the scroll itself, and the wheel is not a pinch.
//   Input that cannot move it produces no scroll event to start following again. The target check
//   is a port of github.com/pingdotgg/t3code, apps/web/src/components/chat/timelineScrollTarget.ts
//   (`isTimelineScrollTarget`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (#5566), MIT.
//
// The glyph bookmark is a port of github.com/hardbeat920/monocode,
// src/features/sessions/ui/useReplyReflowAnchor.ts at 26465c620977f3951d0a532a0f7db32c3c179007.
// Changed: it bookmarks any list row rather than an assistant reply, the list's own corrections are
// told apart by the offset they set, and the pane-slide pause is left out (no panel slides yet).
//
// MIT License. Copyright (c) 2026 Nick
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

import { Effect, Option, Queue, Schema, Stream } from "effect";
import * as Mount from "foldkit/mount";

import { Message } from "./Message.ts";
import { BrokenControl, Place } from "./Model.ts";

/** A drawn row's key attribute; the judges read it too. */
export const ROW_KEY = "virtual-list-item-key";

/** An off-screen row's key attribute. */
export const PROBE_KEY = "probe-key";

/** The off-screen container's marker attribute. */
export const PROBE = "list-probe";

/** A gap's marker attribute: the stretch of parked rows it stands for. */
export const GAP = "list-gap";

/** How close to the end still counts as at the end, in px. */
const END_THRESHOLD_PX = 1;

/** How long after the reader's last scroll the gesture counts as settled. */
const SETTLE_MS = 150;

/** Keys that scroll the scroller, and those of them that scroll up. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

const UP_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "PageUp", "Home"]);

/** MonoCode's probe points for the bookmark: px below the viewport's top, then fractions across. */
const BOOKMARK_OFFSETS = [32, 48, 64];

const BOOKMARK_FRACTIONS = [0.25, 0.5, 0.75];

interface Anchor {
  readonly key: string;
  readonly offset: number;
}

interface Bookmark {
  readonly key: string;
  readonly character: number;
  readonly top: number;
}

const decodeOffset = Schema.decodeUnknownOption(Schema.FiniteFromString);

const decodeBroken = Schema.decodeUnknownOption(BrokenControl);

/** The place the Model last knew, from the scroller's attributes: a thread shown again. */
const initialAnchor = (scroller: HTMLElement): Option.Option<Anchor> =>
  Option.flatMap(Option.fromUndefinedOr(scroller.dataset.placeKey), (key) =>
    Option.map(decodeOffset(scroller.dataset.placeOffset), (offset) => ({
      key,
      offset,
    }))
  );

const isGap = (element: Element): boolean =>
  element instanceof HTMLElement && element.dataset.listGap !== undefined;

const keyOf = (element: Element): string =>
  element instanceof HTMLElement
    ? (element.dataset.virtualListItemKey ?? "")
    : "";

/** The text node and offset `character` characters into `row`, when it has that many. */
const characterAt = (
  row: Element,
  character: number
): Option.Option<{ node: Text; offset: number }> => {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let remaining = character;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      if (remaining < node.length) {
        return Option.some({ node, offset: remaining });
      }

      remaining -= node.length;
    }
  }

  return Option.none();
};

/**
 * True when input at `target` moving `direction` (-1 up, 1 down) scrolls `scroller` rather than an
 * element inside it: no element between them overflows and can still scroll that way, or stops
 * the scroll chaining out of it (`overscroll-behavior`).
 */
const scrollsList = (
  target: EventTarget | null,
  scroller: HTMLElement,
  direction: number
): boolean => {
  if (
    !(target instanceof Element) ||
    !scroller.contains(target) ||
    direction === 0
  ) {
    return false;
  }

  for (
    let element: Element | null = target;
    element !== null && element !== scroller;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);

    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      const canScroll =
        direction < 0
          ? element.scrollTop > 0
          : element.scrollTop < element.scrollHeight - element.clientHeight;

      if (
        canScroll ||
        style.overscrollBehaviorY === "contain" ||
        style.overscrollBehaviorY === "none"
      ) {
        return false;
      }
    }
  }

  return true;
};

/**
 * The caret at a point, where the engine has `caretRangeFromPoint` (Chromium and WebKit; Firefox,
 * not a target, has only `caretPositionFromPoint` and keeps no bookmark). The judge's bookmark and
 * MonoCode read the caret this way.
 */
const caretAt = (x: number, y: number): Option.Option<Range> => {
  if (!("caretRangeFromPoint" in document)) {
    return Option.none();
  }

  // oxlint-disable-next-line typescript/no-deprecated -- the caret API every target engine has
  return Option.fromNullishOr(document.caretRangeFromPoint(x, y));
};

const glyphRect = (node: Text, offset: number): Option.Option<DOMRect> => {
  const range = document.createRange();

  range.setStart(node, offset);
  range.setEnd(node, offset + 1);

  const rect = range.getBoundingClientRect();

  return rect.width === 0 || rect.height === 0
    ? Option.none()
    : Option.some(rect);
};

const bind = (
  scroller: HTMLElement,
  emit: (message: Message) => void
): (() => void) => {
  let following = scroller.dataset.following === "true";
  let anchor = initialAnchor(scroller);
  let bookmark: Option.Option<Bookmark> = Option.none();
  let width = scroller.clientWidth;
  let height = scroller.clientHeight;
  // The `scrollTop` the list itself set last, so its scroll event is not taken for the reader's.
  let adjusted: Option.Option<number> = Option.none();
  let settle: ReturnType<typeof setTimeout> | undefined;
  let captureFrame = 0;

  const viewportTop = () =>
    scroller.getBoundingClientRect().top + scroller.clientTop;

  const distanceFromEnd = () =>
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

  const drawnRows = () =>
    scroller.querySelectorAll<HTMLElement>(`:scope > [data-${ROW_KEY}]`);

  const gaps = () =>
    scroller.querySelectorAll<HTMLElement>(`:scope > [data-${GAP}]`);

  const rowByKey = (key: string): Option.Option<HTMLElement> =>
    Option.fromNullishOr(
      scroller.querySelector<HTMLElement>(
        `:scope > [data-${ROW_KEY}="${CSS.escape(key)}"]`
      )
    );

  const readAnchor = (): Option.Option<Anchor> => {
    const top = viewportTop();

    for (const row of drawnRows()) {
      const rect = row.getBoundingClientRect();

      if (rect.bottom > top + 1) {
        return Option.some({ key: keyOf(row), offset: rect.top - top });
      }
    }

    return Option.none();
  };

  const setTop = (value: number) => {
    scroller.scrollTop = value;
    adjusted = Option.some(scroller.scrollTop);
  };

  const shiftBy = (delta: number) => {
    if (Math.abs(delta) >= 0.5) {
      setTop(Math.round(scroller.scrollTop + delta));
    }
  };

  const pinToEnd = () => {
    if (distanceFromEnd() > 0.5) {
      setTop(scroller.scrollHeight);
    }
  };

  const restoreRow = () => {
    const found = Option.flatMap(anchor, (held) =>
      Option.map(rowByKey(held.key), (row) => ({ held, row }))
    );

    Option.match(found, {
      // The row left the list (its key changed): the reader's place is what is there now.
      onNone: () => {
        anchor = readAnchor();
      },
      onSome: ({ held, row }) => {
        shiftBy(row.getBoundingClientRect().top - viewportTop() - held.offset);
      },
    });
  };

  // MonoCode's reader anchor: a painted character near the viewport's top, not a node boundary.
  const capture = (): Option.Option<Bookmark> => {
    const box = scroller.getBoundingClientRect();

    for (const offsetY of BOOKMARK_OFFSETS) {
      for (const fraction of BOOKMARK_FRACTIONS) {
        const caret = caretAt(
          box.left + box.width * fraction,
          box.top + offsetY
        );

        if (Option.isNone(caret)) {
          continue;
        }

        const range = caret.value;
        const node = range.startContainer;

        if (!(node instanceof Text) || node.length === 0) {
          continue;
        }

        const row = node.parentElement?.closest(`[data-${ROW_KEY}]`) ?? null;

        if (row === null || row.parentElement !== scroller) {
          continue;
        }

        const offset = Math.min(range.startOffset, node.length - 1);

        // A space can collapse after rewrapping; bookmark a painted character.
        if (/\s/u.test(node.data[offset] ?? " ")) {
          continue;
        }

        const rect = glyphRect(node, offset);

        if (Option.isNone(rect)) {
          continue;
        }

        const prefix = document.createRange();

        prefix.selectNodeContents(row);
        prefix.setEnd(node, offset);

        return Option.some({
          key: keyOf(row),
          character: prefix.toString().length,
          top: rect.value.top - box.top,
        });
      }
    }

    return Option.none();
  };

  const restoreGlyph = (): boolean => {
    const top = Option.flatMap(bookmark, (held) =>
      Option.flatMap(rowByKey(held.key), (row) =>
        Option.flatMap(characterAt(row, held.character), ({ node, offset }) =>
          Option.map(glyphRect(node, offset), (rect) => ({
            held,
            top: rect.top - scroller.getBoundingClientRect().top,
          }))
        )
      )
    );

    return Option.match(top, {
      onNone: () => false,
      onSome: ({ held, top: now }) => {
        shiftBy(now - held.top);

        return true;
      },
    });
  };

  const scheduleCapture = () => {
    if (captureFrame === 0) {
      captureFrame = requestAnimationFrame(() => {
        captureFrame = 0;

        // A width change pending in this frame must restore the bookmark from before it.
        if (!following && scroller.clientWidth === width) {
          bookmark = capture();
        }
      });
    }
  };

  // The judges' broken control, read when used: the harness sets it after the list mounts.
  const broken = (): BrokenControl =>
    Option.getOrElse(
      decodeBroken(scroller.dataset.broken),
      () => "none" as const
    );

  /** Puts the reader back after a change of layout; `reflowed` when the text rewrapped. */
  const keep = (reflowed: boolean) => {
    if (following) {
      pinToEnd();

      return;
    }

    if (reflowed) {
      const control = broken();

      if (control !== "reflow" && (control === "bookmark" || !restoreGlyph())) {
        restoreRow();
      }

      anchor = readAnchor();

      return;
    }

    if (broken() === "anchor") {
      anchor = readAnchor();

      return;
    }

    restoreRow();
  };

  const placeNow = (): Place =>
    following
      ? Place.End()
      : Option.match(anchor, {
          // No row on screen: nothing to hold, and the next layout reads the place again.
          onNone: () => Place.Row({ key: "", offset: 0 }),
          onSome: ({ key, offset }) => Place.Row({ key, offset }),
        });

  const report = (byUser: boolean) => {
    emit(
      Message.Scrolled({
        scrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
        place: placeNow(),
        byUser,
      })
    );
  };

  /** The reader is scrolling: the Model stops measuring off-screen until it settles. */
  const holdGesture = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      emit(Message.SettledScroll());
    }, SETTLE_MS);
  };

  const onScroll = (event: Event) => {
    if (event.target !== scroller) {
      return;
    }

    const own = Option.exists(
      adjusted,
      (value) => Math.abs(scroller.scrollTop - value) < 1
    );

    adjusted = Option.none();

    if (!own) {
      following = distanceFromEnd() <= END_THRESHOLD_PX;
      anchor = following ? Option.none() : readAnchor();
      scheduleCapture();
      holdGesture();
    }

    report(!own);
  };

  /** True when the scroller overflows and is not at its top, so a scroll up moves it. */
  const canScrollUp = () =>
    scroller.scrollHeight > scroller.clientHeight + 1 && scroller.scrollTop > 0;

  // Input says a gesture started before its first scroll event does: a wheel or key that moves the
  // scroller up stops following at once, so pinning the end cannot cancel the scroll it starts, and
  // any input that scrolls stops off-screen measuring before the range can change under it
  // (MonoCode's `manualScroll`).
  const onInput = (up: boolean) => {
    if (up && following && (canScrollUp() || broken() === "wheel")) {
      following = false;
      anchor = readAnchor();
    }

    holdGesture();
    report(true);
  };

  /**
   * Input moving `direction` at `target` that the list should hear: input a nested scroller takes,
   * or a pinch, leaves the list where it is (t3code #5566). The `wheel` control hears all of it.
   */
  const hears = (target: EventTarget | null, direction: number): boolean =>
    broken() === "wheel" || scrollsList(target, scroller, direction);

  const onWheel = (event: WheelEvent) => {
    const direction = Math.sign(event.deltaY);

    if (!event.ctrlKey && hears(event.target, direction)) {
      onInput(direction < 0);
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) {
      const up = UP_KEYS.has(event.key);

      if (hears(event.target, up ? -1 : 1)) {
        onInput(up);
      }
    }
  };

  const onTouch = () => {
    onInput(false);
  };

  const onPointer = (event: PointerEvent) => {
    // The scrollbar: a press on the scroller itself rather than on a row.
    if (event.target === scroller) {
      onInput(false);
    }
  };

  const measureOffScreen = () => {
    const probe = scroller.querySelector(`:scope > [data-${PROBE}]`);

    if (probe === null || probe.childElementCount === 0) {
      return;
    }

    const rows = [...probe.children].flatMap((row) =>
      row instanceof HTMLElement && row.dataset.probeKey !== undefined
        ? [
            {
              key: row.dataset.probeKey,
              height: row.getBoundingClientRect().height,
            },
          ]
        : []
    );

    emit(
      Message.MeasuredRows({
        width: scroller.clientWidth,
        rows,
        offScreen: true,
      })
    );
  };

  const observed = new Set<Element>();

  /** Takes in a new size of the scroller; true when its width changed, so the text rewrapped. */
  const resized = (): boolean => {
    const nextWidth = scroller.clientWidth;
    const nextHeight = scroller.clientHeight;

    if (nextWidth === 0 || (nextWidth === width && nextHeight === height)) {
      return false;
    }

    const reflowed = nextWidth !== width;

    width = nextWidth;
    height = nextHeight;
    emit(Message.Resized({ width: nextWidth, height: nextHeight }));

    return reflowed;
  };

  const resize = new ResizeObserver((entries) => {
    let reflowed = false;
    const rows: Array<{ key: string; height: number }> = [];

    for (const entry of entries) {
      if (entry.target === scroller) {
        reflowed ||= resized();
      } else if (
        entry.target.isConnected &&
        observed.has(entry.target) &&
        !isGap(entry.target)
      ) {
        rows.push({
          key: keyOf(entry.target),
          height: entry.target.getBoundingClientRect().height,
        });
      }
    }

    keep(reflowed);

    if (rows.length > 0) {
      emit(Message.MeasuredRows({ width, rows, offScreen: false }));
    }
  });

  // Gaps are observed too: a gap shrinks when a parked row leaves the list, a change of its
  // `style` alone that no childList record reports, and the reader is kept through it.
  const observeRows = () => {
    const current = new Set<Element>([...drawnRows(), ...gaps()]);

    for (const row of observed) {
      if (!current.has(row)) {
        resize.unobserve(row);
        observed.delete(row);
      }
    }

    for (const row of current) {
      if (!observed.has(row)) {
        resize.observe(row);
        observed.add(row);
      }
    }
  };

  const mutations = new MutationObserver((records) => {
    let rowsChanged = false;
    let probeChanged = false;

    for (const record of records) {
      if (record.type === "attributes") {
        if (scroller.dataset.following === "true" && !following) {
          following = true;
          anchor = Option.none();
        }
      } else if (record.target === scroller) {
        rowsChanged = true;
        probeChanged ||= [...record.addedNodes].some(
          (node) =>
            node instanceof HTMLElement && node.dataset.listProbe !== undefined
        );
      } else if (
        record.target instanceof HTMLElement &&
        record.target.dataset.listProbe !== undefined
      ) {
        probeChanged = true;
      }
    }

    if (rowsChanged) {
      observeRows();
    }

    if (probeChanged) {
      measureOffScreen();
    }

    keep(false);
  });

  // A window resize is handled before the frame's animation callbacks, where the observer would
  // only see it after them: nothing that reads the layout in this frame sees the text moved.
  const onWindowResize = () => {
    if (resized()) {
      keep(true);
    }
  };

  const onFonts = () => {
    emit(Message.InvalidatedHeights());
    keep(true);
  };

  mutations.observe(scroller, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-following"],
  });
  resize.observe(scroller);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("wheel", onWheel, { passive: true });
  scroller.addEventListener("touchstart", onTouch, { passive: true });
  scroller.addEventListener("touchmove", onTouch, { passive: true });
  scroller.addEventListener("pointerdown", onPointer, { passive: true });
  scroller.addEventListener("keydown", onKey);
  document.fonts.addEventListener("loadingdone", onFonts);
  window.addEventListener("resize", onWindowResize);
  observeRows();
  measureOffScreen();

  // A thread shown again: back to the place the Model kept for it.
  if (following) {
    pinToEnd();
  } else {
    restoreRow();
  }

  emit(Message.Resized({ width, height }));
  // A gesture cut short by the last release (a thread switch within the settle delay) never
  // settled, and a list that thinks the reader scrolls measures nothing off-screen.
  emit(Message.SettledScroll());

  if (!following) {
    scheduleCapture();
  }

  return () => {
    mutations.disconnect();
    resize.disconnect();
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("wheel", onWheel);
    scroller.removeEventListener("touchstart", onTouch);
    scroller.removeEventListener("touchmove", onTouch);
    scroller.removeEventListener("pointerdown", onPointer);
    scroller.removeEventListener("keydown", onKey);
    document.fonts.removeEventListener("loadingdone", onFonts);
    window.removeEventListener("resize", onWindowResize);
    clearTimeout(settle);
    cancelAnimationFrame(captureFrame);
  };
};

/** Watches the list's scroller and keeps the reader's place in it. Goes on the scroller. */
export const ObserveList = Mount.defineStream("ObserveMeasuredList", {
  args: { id: Schema.String },
  messages: [
    Message.Resized,
    Message.Scrolled,
    Message.SettledScroll,
    Message.MeasuredRows,
    Message.InvalidatedHeights,
  ],
  execute: ({ element, viewStateChanges }) =>
    viewStateChanges.pipe(
      Stream.switchMap((state) =>
        state === "Live" && element instanceof HTMLElement
          ? Stream.callback<Message>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() =>
                  bind(element, (message) => {
                    Queue.offerUnsafe(queue, message);
                  })
                ),
                (release) => Effect.sync(release)
              ).pipe(Effect.flatMap(() => Effect.never))
            )
          : Stream.never
      )
    ),
});
