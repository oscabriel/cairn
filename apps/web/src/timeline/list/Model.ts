// The transcript's measured list (ADR 0041), its state: the scroll position the view windows
// around, where the reader is (at the end, or a row and its offset), and every row height the list
// has measured, all at one width. Rows are measured before they count: a row the list has never
// drawn is not in the scroll range at all, so nothing is ever laid out at an estimate.
//
// Nothing is measured off-screen while the reader scrolls, and a measurement in flight when a
// gesture starts is dropped, so the scroll range never changes under a gesture. A width change
// keeps every height as `stale`: a stale row stays laid out at its old height until it is measured
// again, nearest the reader first, while Place.ts keeps the character being read where it was.
//
// Replaces @foldkit/ui's virtual list (github.com/foldkit/foldkit, packages/ui/src/virtualList at
// 0.169.0), whose Model, Message and Mount split this keeps in outline. MIT License, Copyright (c)
// 2025 Devin Jameson; the notice is in View.ts.

import { Predicate, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/**
 * The judges' broken controls (judges/transcript-scroll.ts), off in the app: `estimate` lays out
 * rows the list never drew at an estimated height, `reflow` keeps the raw `scrollTop` through a
 * width change, and `anchor` lets a change above the reader move what they see.
 */
export const BrokenControl = Schema.Literals([
  "none",
  "estimate",
  "reflow",
  "anchor",
]);

export type BrokenControl = typeof BrokenControl.Type;

/** Where the reader is: following the end, or a row's top `offset` px from the viewport's top. */
export const Place = defineTaggedUnion({
  End: {},
  Row: { key: Schema.String, offset: Schema.Finite },
});

export type Place = typeof Place.Type;

/** Row heights in px, by row key. */
export const Heights = Schema.Record(Schema.String, Schema.Finite);

export type Heights = typeof Heights.Type;

/** The list's state. */
export const Model = Schema.Struct({
  /** The scroller's element id. */
  id: Schema.String,
  /** The scroller's content width `heights` were measured at; 0 before the first measurement. */
  width: Schema.Finite,
  viewportHeight: Schema.Finite,
  /** The last `scrollTop` the scroller reported. */
  scrollTop: Schema.Finite,
  place: Place,
  /** Row heights at `width`. */
  heights: Heights,
  /** Row heights from an earlier width, kept for layout until each row is measured again. */
  stale: Heights,
  /** True from the reader's first scroll event until the gesture settles. */
  scrolling: Schema.Boolean,
  /** True from a pause near the range's top until the history above the reader is measured. */
  extending: Schema.Boolean,
  broken: BrokenControl,
});

export type Model = typeof Model.Type;

/** A list for element `id`, following its end, with nothing measured. */
export const init = (id: string): Model => ({
  id,
  width: 0,
  viewportHeight: 0,
  scrollTop: 0,
  place: Place.End(),
  heights: {},
  stale: {},
  scrolling: false,
  extending: false,
  broken: "none",
});

/** True while the list follows its end. */
export const isFollowingEnd = (model: Model): boolean =>
  Predicate.isTagged(model.place, "End");
