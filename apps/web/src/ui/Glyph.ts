// Glyphs: the status marks (the surfaces note's StatusMark: a busy spinner, a needs-you dot, a check,
// a failure, a dashed todo) and any lucide icon, drawn in the current ink so the caller's tone
// colours them. A glyph is decoration: it is hidden from assistive technology, so its meaning must
// also be in words beside it (a status chip's word, a button's label or `aria-label`).

import type { Html, HtmlBuilder } from "foldkit/html";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide";

import { icon } from "../composer/Icon.ts";
import type { IconNode } from "../composer/Icon.ts";
import { classNames } from "./ClassNames.ts";
import type { Tone } from "./Tone.ts";

/** A status mark. */
export type StatusMark =
  | "busy"
  | "needs"
  | "done"
  | "failed"
  | "todo"
  | "idle"
  | "info"
  | "warning";

/** Every status mark, in the order the catalogue shows them. */
export const STATUS_MARKS: ReadonlyArray<StatusMark> = [
  "busy",
  "needs",
  "done",
  "failed",
  "todo",
  "idle",
  "info",
  "warning",
];

/** A glyph's size: `small` sits in 12 px text, `regular` in 13 to 14 px text, `large` alone. */
export type GlyphSize = "small" | "regular" | "large";

const SIZE: Readonly<Record<GlyphSize, string>> = {
  small: "size-3.5",
  regular: "size-4",
  large: "size-6",
};

const MARK: Readonly<
  Record<StatusMark, { readonly node: IconNode; readonly name: string }>
> = {
  busy: { node: LoaderCircle, name: "loader-circle" },
  needs: { node: CircleDot, name: "circle-dot" },
  done: { node: CircleCheck, name: "circle-check" },
  failed: { node: CircleX, name: "circle-x" },
  todo: { node: CircleDashed, name: "circle-dashed" },
  idle: { node: Circle, name: "circle" },
  info: { node: Info, name: "info" },
  warning: { node: TriangleAlert, name: "triangle-alert" },
};

const MARK_OF_TONE: Readonly<Record<Tone, StatusMark>> = {
  neutral: "idle",
  accent: "info",
  working: "busy",
  waiting: "needs",
  failed: "failed",
  done: "done",
};

/** The mark a tone shows when its caller names none. */
export const markOfTone = (tone: Tone): StatusMark => MARK_OF_TONE[tone];

/**
 * A lucide icon as a glyph: `name` is its lucide name (`circle-check`), kept as t3code's
 * `lucide-<name>` class. Hidden from assistive technology.
 */
export const glyph = <Message>(
  h: HtmlBuilder<Message>,
  node: IconNode,
  name: string,
  size: GlyphSize
): Html => icon(h, node, name, classNames("shrink-0", SIZE[size]));

const STOP_PATH =
  "M3.5 2h5A1.5 1.5 0 0 1 10 3.5v5A1.5 1.5 0 0 1 8.5 10h-5A1.5 1.5 0 0 1 2 8.5v-5A1.5 1.5 0 0 1 3.5 2Z";

/**
 * The one Stop glyph (U-3): a filled rounded square, 12 px, in the current ink. The composer's Stop
 * and the work panel's row Stops draw it, so Stop looks alike wherever it is offered. Hidden from
 * assistive technology: its button says Stop in words.
 */
export const stopGlyph = <Message>(h: HtmlBuilder<Message>): Html =>
  h.svg(
    [
      h.DataAttribute("glyph", "stop"),
      h.Attribute("width", "12"),
      h.Attribute("height", "12"),
      h.Attribute("viewBox", "0 0 12 12"),
      h.Attribute("fill", "currentColor"),
      h.Attribute("aria-hidden", "true"),
      h.Class("shrink-0"),
    ],
    [h.path([h.Attribute("d", STOP_PATH)])]
  );

/**
 * A status mark. The busy spinner turns only when motion is allowed; under reduced motion it is a
 * still ring with its gap, which reads as busy beside its word.
 */
export const statusGlyph = <Message>(
  h: HtmlBuilder<Message>,
  mark: StatusMark,
  size: GlyphSize
): Html =>
  h.span(
    [
      h.DataAttribute("glyph", mark),
      h.Class(
        classNames(
          "inline-flex shrink-0 items-center justify-center",
          mark === "busy" && "motion-safe:animate-spin"
        )
      ),
    ],
    [glyph(h, MARK[mark].node, MARK[mark].name, size)]
  );
