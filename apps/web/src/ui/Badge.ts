// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/badge.tsx (badgeVariants)
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the base, variant and size class strings.
// Changed: cva becomes class tables and a Foldkit view; the themed `label` variant is left out.
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

import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "./Child.ts";
import { classNames } from "./ClassNames.ts";

const BASE =
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11";

/** The badge looks t3code uses. */
export type BadgeVariant =
  | "default"
  | "destructive"
  | "error"
  | "info"
  | "outline"
  | "secondary"
  | "success"
  | "warning";

/** The badge sizes t3code uses. */
export type BadgeSize = "default" | "control" | "lg" | "sm";

const VARIANT: Readonly<Record<BadgeVariant, string>> = {
  default:
    "bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/90",
  destructive: "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
  error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
  info: "bg-info/8 text-info-foreground dark:bg-info/16",
  outline:
    "border-input bg-background text-foreground dark:bg-input/32 [button&,a&]:hover:bg-accent/50 dark:[button&,a&]:hover:bg-input/48",
  secondary:
    "bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/90",
  success: "bg-success/8 text-success-foreground dark:bg-success/16",
  warning: "bg-warning/8 text-warning-foreground dark:bg-warning/16",
};

const SIZE: Readonly<Record<BadgeSize, string>> = {
  control:
    "h-7 min-w-7 rounded-[var(--control-radius)] px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:min-w-6 sm:text-xs",
  default:
    "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
  lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm",
  sm: "h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs leading-none sm:h-4 sm:min-w-4 sm:text-[.625rem]",
};

/** The class string of a badge. */
export const badgeClass = (
  variant: BadgeVariant,
  size: BadgeSize,
  extra = ""
): string => classNames(BASE, VARIANT[variant], SIZE[size], extra);

/** A t3code-styled badge. */
export const badge = <Message>(
  h: HtmlBuilder<Message>,
  variant: BadgeVariant,
  size: BadgeSize,
  attributes: ReadonlyArray<Attribute<Message>>,
  children: ReadonlyArray<Child>
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "badge"),
      h.Class(badgeClass(variant, size)),
      ...attributes,
    ],
    children
  );
