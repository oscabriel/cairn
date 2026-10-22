// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/button.tsx (buttonVariants)
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the base, variant and size class strings, so
// identical classes give identical pixels. Changed: cva becomes class tables and a Foldkit view over
// @foldkit/ui's button; the media and glass variants and the micro sizes are left out until a
// surface needs them.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
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
import * as Button from "@foldkit/ui/button";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

const BASE =
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

/** The button looks t3code's controls use. */
export type ButtonVariant =
  | "default"
  | "destructive"
  | "outline"
  | "ghost"
  | "ghost-muted"
  | "secondary"
  | "link";

/** The button sizes t3code's controls use. */
export type ButtonSize =
  | "default"
  | "compact"
  | "xs"
  | "sm"
  | "lg"
  | "icon"
  | "icon-sm"
  | "icon-xs"
  | "icon-lg";

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  default:
    "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-primary/90",
  destructive:
    "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-destructive/90",
  outline:
    "[--control-icon-color:var(--contrast-muted-foreground)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64",
  ghost:
    "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
  "ghost-muted":
    "[--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
  secondary:
    "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
  link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
};

const SIZE: Readonly<Record<ButtonSize, string>> = {
  default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
  compact:
    "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
  xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
  sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
  lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
  icon: "size-9 sm:size-8",
  "icon-sm": "size-8 sm:size-7",
  "icon-xs":
    "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
  "icon-lg": "size-10 sm:size-9",
};

/** The class string of a button with `variant` and `size`, plus the caller's classes. */
export const buttonClass = (
  variant: ButtonVariant,
  size: ButtonSize,
  extra = ""
): string => classNames(BASE, VARIANT[variant], SIZE[size], extra);

/** A button's look and behaviour. */
export interface ButtonConfig<Message> {
  readonly variant: ButtonVariant;
  readonly size: ButtonSize;
  readonly onClick: Option.Option<Message>;
  readonly isDisabled: boolean;
  readonly ariaLabel: Option.Option<string>;
  readonly className: string;
}

/** A plain button: default look, no click. Spread over it to configure one. */
export const buttonDefaults = <Message>(): ButtonConfig<Message> => ({
  variant: "default",
  size: "default",
  onClick: Option.none(),
  isDisabled: false,
  ariaLabel: Option.none(),
  className: "",
});

/** A t3code-styled button, always `type="button"`. */
export const button = <Message>(
  h: HtmlBuilder<Message>,
  config: ButtonConfig<Message>,
  children: ReadonlyArray<Child>
): Html =>
  Button.view(
    {
      isDisabled: config.isDisabled,
      ...Option.match(config.onClick, {
        onNone: () => ({}),
        onSome: (onClick) => ({ onClick }),
      }),
      toView: (attributes) =>
        h.button(
          [
            ...attributes.button,
            h.DataAttribute("slot", "button"),
            h.Class(buttonClass(config.variant, config.size, config.className)),
            ...Option.match(config.ariaLabel, {
              onNone: () => [],
              onSome: (label) => [h.AriaLabel(label)],
            }),
          ],
          children
        ),
    },
    h
  );
