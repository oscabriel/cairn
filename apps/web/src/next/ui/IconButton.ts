// The `next` icon button: a square button holding one glyph, in the button's variants and states.
// It has no visible words, so its accessible name is required; the catalogue pairs one with a
// tooltip, which repeats the name for the pointer and is never the only place it is said.

import * as FoldkitButton from "@foldkit/ui/button";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import type { ButtonConfig, ButtonSize } from "./Button.ts";
import { buttonAttributes, buttonClass } from "./Button.ts";
import { statusGlyph } from "./Glyph.ts";

const SQUARE: Readonly<Record<ButtonSize, string>> = {
  regular: "w-9 px-0",
  small: "w-7 px-0",
};

/** An icon button's look and behaviour: a button's, with the name it must have. */
export interface IconButtonConfig<Message> extends Omit<
  ButtonConfig<Message>,
  "ariaLabel"
> {
  /** The accessible name: what the button does, in words. */
  readonly label: string;
}

/** The class string of an icon button with `config`'s variant and size. */
export const iconButtonClass = <Message>(
  config: IconButtonConfig<Message>
): string =>
  classNames(buttonClass(config.variant, config.size), SQUARE[config.size]);

/** A square `next` button with one glyph and an accessible name, always `type="button"`. */
export const iconButton = <Message>(
  h: HtmlBuilder<Message>,
  config: IconButtonConfig<Message>,
  glyph: Html
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
            ...buttonAttributes(h, {
              ...config,
              ariaLabel: Option.some(config.label),
            }),
            h.Class(iconButtonClass(config)),
          ],
          [
            config.isBusy
              ? statusGlyph(
                  h,
                  "busy",
                  config.size === "small" ? "small" : "regular"
                )
              : glyph,
          ]
        ),
    },
    h
  );
