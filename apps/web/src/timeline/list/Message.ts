// What the measured list's scroller reports (Place.ts).

import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Place } from "./Model.ts";

/** One row's measured height. */
export const Measurement = Schema.Struct({
  key: Schema.String,
  height: Schema.Finite,
});

export type Measurement = typeof Measurement.Type;

/** Everything the list reacts to. */
export const Message = defineMessageUnion({
  /** The scroller's content box changed size. */
  Resized: { width: Schema.Finite, height: Schema.Finite },
  /** The scroller scrolled; `byUser` is false for the list's own corrections. */
  Scrolled: {
    scrollTop: Schema.Finite,
    viewportHeight: Schema.Finite,
    place: Place,
    byUser: Schema.Boolean,
  },
  /** No scroll from the reader for a moment. */
  SettledScroll: {},
  /**
   * Row heights at `width`: drawn rows as they resize, or (`offScreen`) rows the list drew
   * off-screen to measure before they count.
   */
  MeasuredRows: {
    width: Schema.Finite,
    rows: Schema.Array(Measurement),
    offScreen: Schema.Boolean,
  },
  /** Fonts loaded: every height may be wrong, as after a width change. */
  InvalidatedHeights: {},
});

export type Message = typeof Message.Type;
