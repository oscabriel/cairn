// The measured list's rules (ADR 0041): what counts in the scroll range, what is drawn, parked or
// measured off-screen, and how measurements land. The scrolling itself is judged in a browser by
// judges/transcript-scroll.ts.

import { assert, describe, it } from "@effect/vitest";

import type { Rows } from "./Layout.ts";
import { layoutOf, MAX_UNMEASURED_DRAWN, PROBE_ROWS } from "./Layout.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { init, Place } from "./Model.ts";
import { keepRows, update } from "./Update.ts";

const ROW_PX = 100;

/** `count` rows keyed `r0`, `r1`..., each estimated at `ROW_PX`, all unchanged since drawn. */
const rowsOf = (
  count: number,
  changed: ReadonlySet<number> = new Set()
): Rows => ({
  keys: Array.from({ length: count }, (_, index) => `r${String(index)}`),
  estimate: () => ROW_PX,
  current: (index) => !changed.has(index),
});

/** Heights of `ROW_PX` for rows `from` to `to - 1`. */
const heightsFor = (from: number, to: number): Record<string, number> =>
  Object.fromEntries(
    Array.from({ length: to - from }, (_, offset) => [
      `r${String(from + offset)}`,
      ROW_PX,
    ])
  );

const listOf = (fields: Partial<Model>): Model => ({
  ...init("list"),
  width: 800,
  viewportHeight: 1000,
  ...fields,
});

const drawnIndices = (model: Model, rows: Rows): ReadonlyArray<number> =>
  layoutOf(model, rows).slots.flatMap((slot) =>
    slot.kind === "row" ? [slot.index] : []
  );

const gapHeights = (model: Model, rows: Rows): ReadonlyArray<number> =>
  layoutOf(model, rows).slots.flatMap((slot) =>
    slot.kind === "gap" ? [slot.height] : []
  );

describe("the scroll range", () => {
  it("holds only the end of a list with nothing measured, drawn, and measures nothing yet", () => {
    const layout = layoutOf(init("list"), rowsOf(100));

    // The 900 px viewport assumed before one is reported, and as much again each side.
    assert.strictEqual(layout.start, 73);
    assert.isTrue(layout.slots.every((slot) => slot.kind === "row"));
    assert.deepStrictEqual(layout.probe, []);
  });

  it("starts at the oldest measured row: older rows are not laid out at all", () => {
    const model = listOf({ heights: heightsFor(60, 100) });
    const layout = layoutOf(model, rowsOf(100));

    assert.strictEqual(layout.start, 60);
    assert.strictEqual(layout.totalHeight, 40 * ROW_PX);
  });

  it("parks rows beyond the buffer behind one gap of their exact heights", () => {
    const heights = { ...heightsFor(0, 100), r10: 250 };
    const model = listOf({ heights, place: Place.End() });
    const rows = rowsOf(100);

    // The end at 10,150 px: rows from 9,150 - 1,000 = 8,150 px down are drawn.
    assert.deepStrictEqual(drawnIndices(model, rows).slice(0, 2), [80, 81]);
    assert.deepStrictEqual(gapHeights(model, rows), [80 * ROW_PX + 150]);
  });

  it("draws a row the list never measured where the reader is, and measures one elsewhere first", () => {
    const heights = { ...heightsFor(0, 100) };

    delete heights.r5;
    delete heights.r95;

    const model = listOf({ heights, place: Place.End() });
    const layout = layoutOf(model, rowsOf(100));

    assert.include(drawnIndices(model, rowsOf(100)), 95);
    assert.notInclude(drawnIndices(model, rowsOf(100)), 5);
    // The far one takes no room until measured: the gap holds the 79 measured rows above row 80.
    assert.deepStrictEqual(gapHeights(model, rowsOf(100)), [79 * ROW_PX]);
    assert.include(layout.probe, 5);
  });

  it("draws at most a frame's worth of rows it never measured at once, as a page of history lands", () => {
    const model = listOf({
      heights: { ...heightsFor(0, 1), ...heightsFor(61, 100) },
      place: Place.Row({ key: "r0", offset: 0 }),
      scrollTop: 0,
      viewportHeight: 4000,
    });

    const drawn = drawnIndices(model, rowsOf(100));

    assert.strictEqual(
      drawn.filter((index) => index >= 1 && index <= 60).length,
      MAX_UNMEASURED_DRAWN
    );
    assert.strictEqual(layoutOf(model, rowsOf(100)).probe[0], 33);
  });

  it("lays every row out at an estimate under the broken `estimate` control", () => {
    const model = listOf({ heights: heightsFor(90, 100), broken: "estimate" });
    const layout = layoutOf(model, rowsOf(100));

    assert.strictEqual(layout.start, 0);
    assert.notInclude(drawnIndices(model, rowsOf(100)), 5);
    assert.deepStrictEqual(layout.probe, []);
  });
});

describe("measuring off-screen", () => {
  it("measures the rows above the range while the reader follows the end, nearest first", () => {
    const model = listOf({ heights: heightsFor(60, 100), place: Place.End() });

    assert.deepStrictEqual(
      layoutOf(model, rowsOf(100)).probe,
      Array.from({ length: PROBE_ROWS }, (_, offset) => 59 - offset)
    );
  });

  it("does not grow the range while the reader is in history far from its top", () => {
    const model = listOf({
      heights: heightsFor(40, 100),
      place: Place.Row({ key: "r80", offset: 0 }),
      scrollTop: 4000,
    });

    assert.deepStrictEqual(layoutOf(model, rowsOf(100)).probe, []);
  });

  it("grows the range after a pause near its top, until history is measured well ahead", () => {
    const reading = listOf({
      heights: heightsFor(40, 100),
      place: Place.Row({ key: "r45", offset: 0 }),
      scrollTop: 500,
      scrolling: true,
    });

    assert.deepStrictEqual(layoutOf(reading, rowsOf(100)).probe, []);

    const paused = update(reading, Message.SettledScroll());

    assert.strictEqual(layoutOf(paused, rowsOf(100)).probe[0], 39);

    const pushedDown = update(
      paused,
      Message.Scrolled({
        scrollTop: 1700,
        viewportHeight: 1000,
        place: Place.Row({ key: "r45", offset: 0 }),
        byUser: false,
      })
    );

    assert.isTrue(pushedDown.extending);

    const scrolledAgain = update(
      pushedDown,
      Message.Scrolled({
        scrollTop: 1600,
        viewportHeight: 1000,
        place: Place.Row({ key: "r44", offset: 0 }),
        byUser: true,
      })
    );

    assert.isFalse(scrolledAgain.extending);
  });

  it("measures nothing while the reader scrolls", () => {
    const model = listOf({ heights: heightsFor(60, 100), scrolling: true });

    assert.deepStrictEqual(layoutOf(model, rowsOf(100)).probe, []);
  });

  it("measures stale and changed rows again, nearest the window first, laid out as before", () => {
    const model = listOf({
      heights: heightsFor(0, 30),
      stale: { ...heightsFor(30, 100), r40: 180 },
      place: Place.End(),
    });

    const rows = rowsOf(100, new Set([5]));
    const layout = layoutOf(model, rows);

    assert.strictEqual(layout.totalHeight, 100 * ROW_PX + 80);
    assert.deepStrictEqual(layout.probe.slice(0, 3), [79, 78, 77]);
    assert.notInclude(layout.probe, 5);

    const near = listOf({
      heights: heightsFor(0, 100),
      place: Place.Row({ key: "r10", offset: 0 }),
      scrollTop: 0,
    });

    assert.deepStrictEqual(layoutOf(near, rows).probe, []);

    const changedFar = listOf({
      heights: heightsFor(0, 100),
      place: Place.End(),
    });

    assert.deepStrictEqual(layoutOf(changedFar, rows).probe, [5]);
  });
});

const measured = (offScreen: boolean, width = 800) =>
  Message.MeasuredRows({
    width,
    rows: [{ key: "r1", height: 120 }],
    offScreen,
  });

describe("measurements", () => {
  it("are dropped when taken off-screen as a gesture starts, so the range holds under it", () => {
    const scrolling = update(
      listOf({}),
      Message.Scrolled({
        scrollTop: 10,
        viewportHeight: 1000,
        place: Place.Row({ key: "r0", offset: -10 }),
        byUser: true,
      })
    );

    assert.isTrue(scrolling.scrolling);
    assert.strictEqual(update(scrolling, measured(true)), scrolling);

    const settled = update(scrolling, Message.SettledScroll());

    assert.isFalse(settled.scrolling);
    assert.deepStrictEqual(update(settled, measured(true)).heights, {
      r1: 120,
    });
  });

  it("land at once from rows on screen, even during a gesture", () => {
    const model = update(listOf({ scrolling: true }), measured(false));

    assert.deepStrictEqual(model.heights, { r1: 120 });
  });

  it("leave the Model as it was when nothing changed", () => {
    const model = listOf({ heights: { r1: 120 } });

    assert.strictEqual(update(model, measured(false)), model);
  });

  it("keep every height as stale through a width change", () => {
    const model = listOf({ heights: { r1: 120, r2: 40 } });
    const resized = update(model, Message.Resized({ width: 390, height: 900 }));

    assert.deepStrictEqual(resized.heights, {});
    assert.deepStrictEqual(resized.stale, { r1: 120, r2: 40 });
    assert.strictEqual(resized.width, 390);

    const remeasured = update(model, measured(false, 390));

    assert.deepStrictEqual(remeasured.heights, { r1: 120 });
    assert.deepStrictEqual(remeasured.stale, { r1: 120, r2: 40 });
  });

  it("forget rows that are gone", () => {
    const model = keepRows(
      listOf({ heights: { r1: 120, r2: 40 }, stale: { r3: 9 } }),
      new Set(["r1"])
    );

    assert.deepStrictEqual(model.heights, { r1: 120 });
    assert.deepStrictEqual(model.stale, {});
  });
});
