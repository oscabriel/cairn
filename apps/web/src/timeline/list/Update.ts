// The measured list's update, and the calls its owner makes into it: back to the end (the pill),
// and forgetting rows that are gone.

import { Record } from "effect";
import { modifyFields } from "foldkit/struct";

import { aheadPx, nearTop } from "./Layout.ts";
import type { Measurement } from "./Message.ts";
import { Message } from "./Message.ts";
import type { Heights, Model } from "./Model.ts";
import { Place } from "./Model.ts";

/** Follows the end again (the scroll-to-end pill). */
export const scrollToEnd = (model: Model): Model =>
  modifyFields(model, { place: () => Place.End() });

const overlay = (base: Heights, top: Heights): Heights =>
  Record.isEmptyRecord(top) ? base : Record.union(base, top, (_, next) => next);

/** Every height becomes stale: laid out as before, measured again. */
const invalidate = (model: Model): Model =>
  modifyFields(model, {
    stale: (stale) => overlay(stale, model.heights),
    heights: () => ({}),
  });

const atWidth = (model: Model, width: number): Model => {
  if (width === model.width) {
    return model;
  }

  const moved = model.width === 0 ? model : invalidate(model);

  return modifyFields(moved, { width: () => width });
};

const measured = (
  model: Model,
  width: number,
  rows: ReadonlyArray<Measurement>,
  offScreen: boolean
): Model => {
  const sized = atWidth(model, width);
  const changed = rows.filter((row) => sized.heights[row.key] !== row.height);

  // Rows measured off-screen join the range; not under a gesture, which they would move.
  if (changed.length === 0 || (offScreen && sized.scrolling)) {
    return sized;
  }

  return modifyFields(sized, {
    heights: (heights) =>
      overlay(
        heights,
        Record.fromEntries(changed.map((row) => [row.key, row.height]))
      ),
  });
};

/** The list's update. */
export const update = (model: Model, message: Message): Model =>
  Message.match<Model>(message, {
    Resized: ({ height, width }) =>
      modifyFields(atWidth(model, width), { viewportHeight: () => height }),
    Scrolled: ({ byUser, place, scrollTop, viewportHeight }) =>
      modifyFields(model, {
        scrollTop: () => scrollTop,
        viewportHeight: () => viewportHeight,
        place: () => place,
        scrolling: (scrolling) => scrolling || byUser,
        // The list's own corrections push the reader down as history joins above.
        extending: (extending) =>
          !byUser && extending && scrollTop < aheadPx(model),
      }),
    SettledScroll: () =>
      modifyFields(model, {
        scrolling: () => false,
        extending: () => nearTop(model, model.scrollTop),
      }),
    MeasuredRows: ({ offScreen, rows, width }) =>
      measured(model, width, rows, offScreen),
    InvalidatedHeights: () => invalidate(model),
  });

/** Forgets the heights of rows that are gone, keeping the rest. */
export const keepRows = (model: Model, keys: ReadonlySet<string>): Model => {
  const keep = (heights: Heights): Heights =>
    Object.keys(heights).every((key) => keys.has(key))
      ? heights
      : Record.filter(heights, (_, key) => keys.has(key));

  return modifyFields(model, {
    heights: keep,
    stale: keep,
  });
};
