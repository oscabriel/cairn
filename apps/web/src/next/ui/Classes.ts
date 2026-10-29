// Class strings every `next` primitive shares: the type steps, the focus ring, the touch target and
// the feedback motion. Each names design tokens only (`next/tokens.css`), so a primitive takes the
// look's values and never a candidate's: switching `data-look` changes every primitive at once.
//
// Forced states. The look catalogue (`catalogue/`) shows hover and focus without a pointer or a
// keyboard, so every primitive that has those states also keys them on `data-hover` and
// `data-focus`; nothing else sets those attributes.
//
// The utilities these classes name are built by `utilities.css`, which this module imports, so a
// chunk that uses a primitive carries them and the entry CSS does not.

import "./utilities.css";

/** A type step from the token scale: font size with its line height. */
export type TypeStep = "micro" | "small" | "ui" | "body" | "title" | "display";

/**
 * The class string of each type step. `micro` (11 px) is for tabular counts and key hints only;
 * text that is read is `small` (12 px) or larger.
 */
export const TYPE: Readonly<Record<TypeStep, string>> = {
  micro: "text-(length:--text-micro) leading-(--text-micro-leading)",
  small: "text-(length:--text-small) leading-(--text-small-leading)",
  ui: "text-(length:--text-ui) leading-(--text-ui-leading)",
  body: "text-(length:--text-body) leading-(--text-body-leading)",
  title: "text-(length:--text-title) leading-(--text-title-leading)",
  display: "text-(length:--text-display) leading-(--text-display-leading)",
};

/** The interface font, for a primitive that may sit inside text set in another. */
export const FONT_UI = "font-(family-name:--font-ui)";

/** The medium weight, for labels and titles. */
export const WEIGHT_MEDIUM = "font-(--weight-medium)";

/** The strong weight, for headings. */
export const WEIGHT_STRONG = "font-(--weight-strong)";

/**
 * The focus ring: the `--stroke-focus` outline, outside the box, on keyboard focus (and on
 * `data-focus`). It is an outline so a transition on the box never delays it.
 */
export const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-stroke-focus data-focus:outline-2 data-focus:outline-solid data-focus:outline-offset-2 data-focus:outline-stroke-focus";

/** The focus ring drawn inside the box, for a row or item whose list clips what lies outside it. */
export const FOCUS_RING_INSET =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-stroke-focus data-focus:outline-2 data-focus:outline-solid data-focus:-outline-offset-2 data-focus:outline-stroke-focus";

/**
 * The ring a field shell draws while the control inside it has focus, since the control itself
 * draws none (a text field matches `:focus-visible` on any focus).
 */
export const FOCUS_WITHIN_RING =
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-stroke-focus data-focus:outline-2 data-focus:outline-solid data-focus:outline-offset-1 data-focus:outline-stroke-focus";

/**
 * A touch target: at least `--hit-target` (44 px, never less whatever the font-size setting) each
 * way on a coarse pointer. The box itself grows, so what a finger can hit is what the eye sees.
 */
export const HIT_TARGET =
  "pointer-coarse:min-h-(--hit-target) pointer-coarse:min-w-(--hit-target)";

/** A touch target that grows only in height, for a row or an item already as wide as its list. */
export const HIT_HEIGHT = "pointer-coarse:min-h-(--hit-target)";

/** Feedback motion: grounds, inks and strokes ease over `--duration-feedback` (0 under reduced motion). */
export const FEEDBACK_MOTION =
  "transition-[background-color,color,border-color,opacity] duration-(--duration-feedback) ease-(--ease-motion)";

/** A control that cannot be used now: faded, and no pointer feedback. */
export const DISABLED =
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50";
