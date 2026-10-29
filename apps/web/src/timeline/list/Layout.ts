// Which rows the measured list draws, which it parks behind a gap of their measured height, and
// which it draws off-screen to measure next. Pure, so the rules are tested without a browser.
//
// The scroll range starts at the oldest measured row: older rows were never drawn, so they are not
// laid out at all until measured off-screen, then join the range above the reader (Place.ts
// keeps what the reader sees still). Inside the range, rows within `max(800 px, viewport)` of the
// viewport are drawn and the rest are parked at their frozen height, after MonoCode's measured
// history (github.com/hardbeat920/monocode, src/features/sessions/ui/useMeasuredHistory.ts at
// 26465c620977f3951d0a532a0f7db32c3c179007). Changed: rows are windowed by height arithmetic
// rather than detached one by one, around the reader's row rather than the scroll position, and
// history the reader has not reached is measured off-screen ahead of time rather than all mounted
// at once.
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

import { Option, Predicate } from "effect";

import type { Model } from "./Model.ts";

/** How far beyond the viewport rows stay drawn, at least (MonoCode's 800). */
export const MIN_BUFFER_PX = 800;

/** The viewport height assumed before the scroller reports one. */
export const DEFAULT_VIEWPORT_PX = 900;

/** At most this many rows are drawn off-screen in one frame. */
export const PROBE_ROWS = 12;

/** At most this many rows the list never measured are drawn on screen in one frame. */
export const MAX_UNMEASURED_DRAWN = 32;

/** One stretch of the list: drawn rows, and the gaps that stand for parked ones. */
export type Slot =
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "gap"; readonly key: string; readonly height: number };

/** The list, as the view draws it. */
export interface Layout {
  /** The index of the oldest row in the scroll range. */
  readonly start: number;
  readonly slots: ReadonlyArray<Slot>;
  /** Rows to draw off-screen and measure, nearest the reader first. */
  readonly probe: ReadonlyArray<number>;
  /** The range's height as laid out (drawn rows at their last measurement or estimate). */
  readonly totalHeight: number;
}

/** What the layout reads about the rows. */
export interface Rows {
  readonly keys: ReadonlyArray<string>;
  /** A row's height before it is measured; only chooses how many rows a fresh list draws. */
  readonly estimate: (index: number) => number;
  /** False when the row changed since it was last drawn, so its frozen height is out of date. */
  readonly current: (index: number) => boolean;
}

/**
 * How much history the list measures above the reader ahead of time, in buffers: a fresh list at
 * its end measures this much before the reader scrolls, so a gesture up starts inside measured
 * history, and the range then holds until the reader pauses near its top.
 */
const AHEAD_BUFFERS = 20;

/** How near the range's top a pause starts measuring more history, in buffers. */
const NEAR_TOP_BUFFERS = 2;

const bufferOf = (viewport: number): number =>
  Math.max(MIN_BUFFER_PX, viewport);

const viewportOf = (model: Model): number =>
  model.viewportHeight > 0 ? model.viewportHeight : DEFAULT_VIEWPORT_PX;

/** How far above the viewport the list measures history ahead of the reader, in px. */
export const aheadPx = (model: Model): number =>
  AHEAD_BUFFERS * bufferOf(viewportOf(model));

/** True when the reader pausing at `scrollTop` is near enough the range's top to measure more. */
export const nearTop = (model: Model, scrollTop: number): boolean =>
  scrollTop < NEAR_TOP_BUFFERS * bufferOf(viewportOf(model));

/** The height a row is laid out at, when the list has one. */
export const frozenHeight = (
  model: Model,
  key: string
): Option.Option<number> =>
  Option.fromUndefinedOr(model.heights[key] ?? model.stale[key]);

/** The rows a list with nothing measured draws: enough of the end to fill the window. */
const tailStart = (rows: Rows, viewport: number): number => {
  const wanted = viewport + 2 * bufferOf(viewport);
  let filled = 0;
  let index = rows.keys.length;

  while (index > 0 && filled < wanted) {
    index -= 1;
    filled += rows.estimate(index);
  }

  return index;
};

const rangeStart = (model: Model, rows: Rows, viewport: number): number => {
  if (model.broken === "estimate") {
    return 0;
  }

  const measured = rows.keys.findIndex((key) =>
    Option.isSome(frozenHeight(model, key))
  );

  return measured === -1 ? tailStart(rows, viewport) : measured;
};

/** Where the drawn window falls: the range's rows as laid out, and which of them are drawn. */
interface Windowed {
  readonly start: number;
  /** Per row from `start`: its frozen height, if it has one, and its height for the arithmetic. */
  readonly known: ReadonlyArray<boolean>;
  readonly heights: ReadonlyArray<number>;
  readonly drawn: ReadonlyArray<boolean>;
  /** The first and last row overlapping the range. */
  readonly first: number;
  readonly last: number;
  readonly top: number;
  readonly totalHeight: number;
}

const rowIndexOf = (rows: Rows, start: number, key: string): number =>
  key === "" ? -1 : rows.keys.indexOf(key, start);

/**
 * Where the viewport's top falls in the range as laid out now: the end's, or the reader's row at
 * its offset. The reported `scrollTop` lags a render behind rows joining above the reader (Place.ts
 * corrects it after the render), so a window drawn around it can leave the reader's own row parked
 * once a batch taller than the buffer joins; the row's laid-out offset already counts the batch.
 */
const topOf = (
  model: Model,
  rows: Rows,
  start: number,
  heights: ReadonlyArray<number>,
  endTop: number
): number => {
  const { place } = model;

  if (!Predicate.isTagged(place, "Row")) {
    return Math.max(0, endTop);
  }

  const row = rowIndexOf(rows, start, place.key);

  if (row === -1 || model.broken === "extend") {
    return model.scrollTop;
  }

  const above = heights
    .slice(0, row - start)
    .reduce((sum, height) => sum + height, 0);

  return Math.max(0, above - place.offset);
};

const windowOf = (model: Model, rows: Rows): Windowed => {
  const viewport = viewportOf(model);
  const buffer = bufferOf(viewport);
  const start = rangeStart(model, rows, viewport);
  const known: Array<boolean> = [];
  const heights: Array<number> = [];

  for (let index = start; index < rows.keys.length; index += 1) {
    const frozen = frozenHeight(model, rows.keys[index] ?? "");

    known.push(Option.isSome(frozen));
    heights.push(Option.getOrElse(frozen, () => rows.estimate(index)));
  }

  const totalHeight = heights.reduce((sum, height) => sum + height, 0);

  const top = topOf(model, rows, start, heights, totalHeight - viewport);

  const windowTop = top - buffer;
  const windowBottom = top + viewport + buffer;
  const drawn: Array<boolean> = [];
  let first = rows.keys.length;
  let last = start - 1;
  let offsetTop = 0;
  let unmeasuredDrawn = 0;

  for (const [offset, height] of heights.entries()) {
    const near = offsetTop + height > windowTop && offsetTop < windowBottom;
    const unmeasured = known[offset] !== true && model.broken !== "estimate";

    // A row the list never measured is drawn where the reader is (a new row at the end, a card
    // landing just above); elsewhere, or past the cap (a page of history), it is a hole that takes
    // no room until it is measured off-screen.
    const draws =
      near && (!unmeasured || unmeasuredDrawn < MAX_UNMEASURED_DRAWN);

    drawn.push(draws);
    unmeasuredDrawn += draws && unmeasured ? 1 : 0;

    if (near) {
      first = Math.min(first, start + offset);
      last = Math.max(last, start + offset);
    }

    offsetTop += height;
  }

  return { start, known, heights, drawn, first, last, top, totalHeight };
};

/** The drawn rows in order, with the parked rows between them merged into gaps. */
const slotsOf = (
  model: Model,
  rows: Rows,
  range: Windowed
): ReadonlyArray<Slot> => {
  const slots: Array<Slot> = [];
  let gap: Option.Option<{ key: string; height: number }> = Option.none();

  const closeGap = () => {
    Option.map(gap, (open) => {
      slots.push({ kind: "gap", key: open.key, height: open.height });
    });
    gap = Option.none();
  };

  for (const [offset, height] of range.heights.entries()) {
    const index = range.start + offset;

    if (range.drawn[offset] === true) {
      closeGap();
      slots.push({ kind: "row", index });
    } else if (range.known[offset] === true || model.broken === "estimate") {
      gap = Option.some(
        Option.match(gap, {
          onNone: () => ({ key: rows.keys[index] ?? "", height }),
          onSome: (open) => ({ key: open.key, height: open.height + height }),
        })
      );
    }
  }

  closeGap();

  return slots;
};

/** Rows in the range to measure again (holes, stale or changed), nearest the window first. */
const refreshOf = (
  model: Model,
  rows: Rows,
  range: Windowed
): ReadonlyArray<number> => {
  const wanted = (index: number): boolean =>
    range.drawn[index - range.start] !== true &&
    (model.heights[rows.keys[index] ?? ""] === undefined ||
      !rows.current(index));

  const probe: Array<number> = [];

  // Holes where the reader is first (rows past the cap of a page that landed), then outward.
  for (
    let index = Math.max(range.start, range.first);
    index <= range.last && probe.length < PROBE_ROWS;
    index += 1
  ) {
    if (wanted(index)) {
      probe.push(index);
    }
  }

  let up = Math.min(range.first, rows.keys.length) - 1;
  let down = range.last + 1;

  while (
    probe.length < PROBE_ROWS &&
    (up >= range.start || down < rows.keys.length)
  ) {
    if (up >= range.start && wanted(up)) {
      probe.push(up);
    }

    if (down < rows.keys.length && probe.length < PROBE_ROWS && wanted(down)) {
      probe.push(down);
    }

    up -= 1;
    down += 1;
  }

  return probe;
};

/**
 * The next rows to measure off-screen: rows in the range whose height is missing, stale or out of
 * date, then (at the end, or after a pause near the range's top) the rows above the range. Nothing
 * while the reader scrolls.
 */
const probeOf = (
  model: Model,
  rows: Rows,
  range: Windowed
): ReadonlyArray<number> => {
  if (model.broken === "estimate" || model.scrolling || model.width === 0) {
    return [];
  }

  // At the end, history is measured until `aheadPx` of it is above; in history, only after a pause
  // near the top, and then as far again (`extending`, Update.ts).
  const extend =
    range.top < aheadPx(model) &&
    (Predicate.isTagged(model.place, "End") || model.extending);

  const refresh = refreshOf(model, rows, range);
  const room = extend ? PROBE_ROWS - refresh.length : 0;

  const above = Array.from(
    { length: Math.max(0, Math.min(room, range.start)) },
    (_, offset) => range.start - 1 - offset
  );

  return [...refresh, ...above];
};

/** The list's layout for `rows` in `model`'s state. */
export const layoutOf = (model: Model, rows: Rows): Layout => {
  const range = windowOf(model, rows);

  return {
    start: range.start,
    slots: slotsOf(model, rows, range),
    probe: probeOf(model, rows, range),
    totalHeight: range.totalHeight,
  };
};
