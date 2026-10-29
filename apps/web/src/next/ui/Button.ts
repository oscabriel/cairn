// The `next` button: four variants on the design tokens, two sizes, and the states a control has
// (rest, hover, pressed for a toggle, keyboard focus, busy, disabled). Behaviour comes from
// @foldkit/ui's button: always `type="button"`, focusable when disabled (`aria-disabled`), and no
// click while disabled or busy. On a coarse pointer every size is at least `--hit-target` each way.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import * as FoldkitButton from "@foldkit/ui/button";
import { Option } from "effect";
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
} from "foldkit/html";

import type { Child } from "../../ui/Child.ts";
import { classNames } from "../../ui/ClassNames.ts";
import {
  DISABLED,
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
} from "./Classes.ts";
import { statusGlyph } from "./Glyph.ts";

/**
 * A button's look: `primary` is the one action of a surface (the accent fill), `secondary` an
 * action beside it, `ghost` a quiet action in chrome, `danger` an action that ends or removes.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Every variant, in the order the catalogue shows them. */
export const BUTTON_VARIANTS: ReadonlyArray<ButtonVariant> = [
  "primary",
  "secondary",
  "ghost",
  "danger",
];

/** A button's size: `regular` for a surface's actions, `small` inside rows, cards and chips. */
export type ButtonSize = "regular" | "small";

// A busy button takes no click (it is `aria-disabled`) but is not faded: its mark says why.
const BASE =
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-(--radius-small) border aria-busy:cursor-progress aria-busy:opacity-100!";

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "border-transparent bg-accent-fill text-accent-ink not-aria-disabled:hover:bg-accent-fill/90 data-hover:bg-accent-fill/90",
  secondary:
    "border-stroke-2 bg-select-1 text-ink-1 not-aria-disabled:hover:bg-select-2 data-hover:bg-select-2 aria-pressed:bg-select-3 aria-pressed:border-stroke-focus",
  ghost:
    "border-transparent text-ink-2 not-aria-disabled:hover:bg-select-1 not-aria-disabled:hover:text-ink-1 data-hover:bg-select-1 data-hover:text-ink-1 aria-pressed:bg-select-3 aria-pressed:text-ink-1",
  danger:
    "border-stroke-2 bg-tone-failed-wash text-tone-failed not-aria-disabled:hover:border-tone-failed data-hover:border-tone-failed",
};

const SIZE: Readonly<Record<ButtonSize, string>> = {
  regular: classNames(
    "h-9 gap-(--space-2) px-(--space-3)",
    TYPE.ui,
    WEIGHT_MEDIUM
  ),
  small: classNames(
    "h-7 gap-(--space-1-5) px-(--space-2)",
    TYPE.small,
    WEIGHT_MEDIUM
  ),
};

/** The class string of a button with `variant` and `size`. */
export const buttonClass = (variant: ButtonVariant, size: ButtonSize): string =>
  classNames(
    BASE,
    VARIANT[variant],
    SIZE[size],
    HIT_TARGET,
    FOCUS_RING,
    FEEDBACK_MOTION,
    DISABLED
  );

/** A button's look and behaviour. */
export interface ButtonConfig<Message> {
  readonly variant: ButtonVariant;
  readonly size: ButtonSize;
  /** What a click sends; none for a button that only shows. */
  readonly onClick: Option.Option<Message>;
  readonly isDisabled: boolean;
  /** Working on its action: shows the busy mark before the label and takes no click. */
  readonly isBusy: boolean;
  /** A toggle's state (`aria-pressed`); none for a plain button. */
  readonly isPressed: Option.Option<boolean>;
  /** The accessible name when the label alone does not say what the button does. */
  readonly ariaLabel: Option.Option<string>;
  /**
   * More attributes: test ids, hooks, `data-hover` and `data-focus` in the catalogue, or a
   * Submodel's bundle (a dialog's `closeButton`).
   */
  readonly attributes: ReadonlyArray<Attribute<Message> | ChildAttribute>;
}

/** A regular secondary button with no click. Spread over it to configure one. */
export const buttonDefaults = <Message>(): ButtonConfig<Message> => ({
  variant: "secondary",
  size: "regular",
  onClick: Option.none(),
  isDisabled: false,
  isBusy: false,
  isPressed: Option.none(),
  ariaLabel: Option.none(),
  attributes: [],
});

/** The attributes every `next` button carries: its state, its name and the caller's. */
export const buttonAttributes = <Message>(
  h: HtmlBuilder<Message>,
  config: ButtonConfig<Message>
): ReadonlyArray<Attribute<Message> | ChildAttribute> => [
  h.DataAttribute("slot", "button"),
  ...Option.match(config.isPressed, {
    onNone: () => [],
    onSome: (pressed) => [h.AriaPressed(pressed ? "true" : "false")],
  }),
  ...onlyIf(config.isBusy, h.AriaBusy(true)),
  ...Option.match(config.ariaLabel, {
    onNone: () => [],
    onSome: (label) => [h.AriaLabel(label)],
  }),
  ...config.attributes,
];

/** A `next` button, always `type="button"`. */
export const button = <Message>(
  h: HtmlBuilder<Message>,
  config: ButtonConfig<Message>,
  children: ReadonlyArray<Child>
): Html =>
  FoldkitButton.view(
    {
      isDisabled: config.isDisabled || config.isBusy,
      ...Option.match(config.onClick, {
        onNone: () => ({}),
        onSome: (onClick) => ({ onClick }),
      }),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            ...buttonAttributes(h, config),
            h.Class(buttonClass(config.variant, config.size)),
          ],
          [
            config.isBusy
              ? statusGlyph(
                  h,
                  "busy",
                  config.size === "small" ? "small" : "regular"
                )
              : h.empty,
            ...children,
          ]
        ),
    },
    h
  );
