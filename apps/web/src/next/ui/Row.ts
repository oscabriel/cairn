// The `next` row (the surfaces note's ActionRow): one line in a list, a thread or a subagent or a
// file, with a leading glyph, a title that truncates, quiet meta, a key hint, and trailing actions.
// The row's main area is one button, so a click anywhere on it opens the row; trailing actions are
// siblings of that button, never inside it. On a coarse pointer the row is at least `--hit-target`
// tall and the key hint is hidden (there is no keyboard to press it on).
//
// States: rest, hover, current (the open one, `aria-current`), emphasised (unseen work, a stronger
// title), and disabled.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import * as FoldkitButton from "@foldkit/ui/button";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import {
  DISABLED,
  FEEDBACK_MOTION,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "./Classes.ts";

/** A row's state and click. */
export interface RowConfig<Message> {
  /** What a click on the row's main area sends. */
  readonly onClick: Option.Option<Message>;
  /** The open one in its list (`aria-current`). */
  readonly isCurrent: boolean;
  /** Has something the user has not seen: a stronger title. */
  readonly isEmphasised: boolean;
  readonly isDisabled: boolean;
  /** More attributes on the row: test ids, hooks, `data-hover` and `data-focus`. */
  readonly attributes: ReadonlyArray<Attribute<Message>>;
}

/** A plain row: not current, no click. Spread over it to configure one. */
export const rowDefaults = <Message>(): RowConfig<Message> => ({
  onClick: Option.none(),
  isCurrent: false,
  isEmphasised: false,
  isDisabled: false,
  attributes: [],
});

/** What a row shows. */
export interface RowContent {
  /** A status mark or avatar before the title. */
  readonly leading: Option.Option<Html>;
  readonly title: string;
  /** Quiet words after the title: a time, a count, a project. */
  readonly meta: Option.Option<string>;
  /** A key hint, hidden on a coarse pointer. */
  readonly hint: Option.Option<Html>;
  /** Actions after the row's main area, each its own button. */
  readonly trailing: ReadonlyArray<Html>;
}

const ROW =
  "group/row relative flex w-full min-w-0 items-center gap-(--space-1) rounded-(--radius-small) pe-(--space-1) text-ink-1 hover:bg-select-1 has-[[data-hover]]:bg-select-1 has-[[aria-current=true]]:bg-select-3 has-[[aria-current=true]]:hover:bg-select-4";

const MAIN = classNames(
  "flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1) text-start",
  HIT_HEIGHT,
  FOCUS_RING_INSET,
  FEEDBACK_MOTION,
  DISABLED
);

/** A list row: its main area is one button; trailing actions sit beside it. */
export const row = <Message>(
  h: HtmlBuilder<Message>,
  config: RowConfig<Message>,
  content: RowContent
): Html =>
  h.div(
    [h.DataAttribute("slot", "row"), h.Class(ROW)],
    [
      FoldkitButton.view(
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
                h.DataAttribute("slot", "row-main"),
                ...onlyIf(config.isCurrent, h.AriaCurrent("true")),
                ...config.attributes,
                h.Class(MAIN),
              ],
              [
                Option.getOrElse(content.leading, () => h.empty),
                h.span(
                  [
                    h.Class(
                      classNames(
                        "min-w-0 flex-1 truncate",
                        TYPE.ui,
                        config.isEmphasised ? WEIGHT_STRONG : WEIGHT_MEDIUM
                      )
                    ),
                  ],
                  [content.title]
                ),
                Option.match(content.meta, {
                  onNone: () => h.empty,
                  onSome: (meta) =>
                    h.span(
                      [
                        h.Class(
                          classNames(
                            "shrink-0 tabular-nums text-ink-3",
                            TYPE.small
                          )
                        ),
                      ],
                      [meta]
                    ),
                }),
                Option.match(content.hint, {
                  onNone: () => h.empty,
                  onSome: (hint) =>
                    h.span(
                      [
                        h.DataAttribute("slot", "row-hint"),
                        h.Class("shrink-0 pointer-coarse:hidden"),
                      ],
                      [hint]
                    ),
                }),
              ]
            ),
        },
        h
      ),
      ...content.trailing,
    ]
  );
