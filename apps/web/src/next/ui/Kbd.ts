// The `next` key hint: one key or a shortcut, in the micro step and tabular figures, on the
// selection ladder. It is a hint for a keyboard, so it is hidden on a coarse pointer.

import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_MEDIUM } from "./Classes.ts";

/** The class string of one key. */
export const KBD_CLASS = classNames(
  "inline-flex h-5 min-w-5 select-none items-center justify-center rounded-(--radius-small) border border-stroke-1 bg-select-1 px-(--space-1) font-(family-name:--font-ui) tabular-nums text-ink-2",
  TYPE.micro,
  WEIGHT_MEDIUM
);

/** One key, as in a shortcut hint. */
export const kbd = <Message>(h: HtmlBuilder<Message>, key: string): Html =>
  h.kbd([h.DataAttribute("slot", "kbd"), h.Class(KBD_CLASS)], [key]);

/** A shortcut: one element per key, grouped, hidden on a coarse pointer. */
export const shortcut = <Message>(
  h: HtmlBuilder<Message>,
  keys: ReadonlyArray<string>
): Html =>
  h.kbd(
    [
      h.DataAttribute("slot", "shortcut"),
      h.Class(
        "inline-flex items-center gap-(--space-0-5) pointer-coarse:hidden"
      ),
    ],
    keys.map((key) => kbd(h, key))
  );
