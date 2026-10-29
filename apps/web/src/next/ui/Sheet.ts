// The `next` sheet (the surfaces note's Sheet): a bottom sheet on the phone, under `sm`, and a panel
// docked to the right edge from `sm` up, for the work panel, a brief's fields or a criteria list.
// It has a title, a close button, a body that scrolls on its own, and actions at its foot that stay
// in reach of the thumb. Drawn over the page (`viewport`) it is a modal dialog over a scrim; drawn
// inside a pane (`contained`) it covers only that pane, which must be positioned, and is not modal.
//
// The sheet draws its open state only; whether it is open, and focus moving into it and back, are
// its caller's (a Foldkit dialog or the page's model).

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { X } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_STRONG } from "./Classes.ts";
import { glyph } from "./Glyph.ts";
import { iconButton } from "./IconButton.ts";

/** Where the sheet sits: over the whole page, or over one positioned pane. */
export type SheetPlacement = "viewport" | "contained";

/** A sheet's place, words and messages. */
export interface SheetConfig<Message> {
  readonly placement: SheetPlacement;
  /** The id its title takes, which names the dialog. Unique on the page. */
  readonly id: string;
  readonly title: string;
  /** What the close button and a tap on the scrim send. */
  readonly onClose: Option.Option<Message>;
  readonly attributes: ReadonlyArray<Attribute<Message>>;
}

const POSITION: Readonly<Record<SheetPlacement, string>> = {
  viewport: "fixed",
  contained: "absolute",
};

const PANEL =
  "flex flex-col overflow-hidden border-stroke-1 bg-surface-overlay text-ink-1 shadow-(--elevation-3) inset-x-0 bottom-0 max-h-[85%] rounded-t-(--radius-large) border-t pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:top-0 sm:right-0 sm:max-h-none sm:w-[min(24rem,100%)] sm:rounded-none sm:rounded-l-(--radius-large) sm:border-t-0 sm:border-l sm:pb-0";

/** The class string of a sheet's panel at `placement`. */
export const sheetClass = (placement: SheetPlacement): string =>
  classNames(POSITION[placement], "z-(--layer-sheet)", PANEL);

/** A sheet drawn open: scrim, then the panel with its title, body and actions. */
export const sheet = <Message>(
  h: HtmlBuilder<Message>,
  config: SheetConfig<Message>,
  body: ReadonlyArray<Html>,
  actions: ReadonlyArray<Html>
): Html => {
  const titleId = `${config.id}-title`;

  return h.div(
    [
      h.DataAttribute("slot", "sheet"),
      h.DataAttribute("placement", config.placement),
      h.Class("contents"),
    ],
    [
      h.div([
        h.DataAttribute("slot", "sheet-scrim"),
        h.AriaHidden(true),
        ...Option.match(config.onClose, {
          onNone: () => [],
          onSome: (message) => [h.OnClick(message)],
        }),
        h.Class(
          classNames(
            POSITION[config.placement],
            "inset-0 z-(--layer-scrim) bg-scrim"
          )
        ),
      ]),
      h.div(
        [
          h.Id(config.id),
          h.Role("dialog"),
          ...onlyIf(config.placement === "viewport", h.AriaModal(true)),
          h.AriaLabelledBy(titleId),
          ...config.attributes,
          h.Class(sheetClass(config.placement)),
        ],
        [
          h.div([
            h.AriaHidden(true),
            h.Class(
              "mx-auto mt-(--space-2) h-1 w-9 shrink-0 rounded-(--radius-round) bg-stroke-2 sm:hidden"
            ),
          ]),
          h.header(
            [
              h.Class(
                "flex shrink-0 items-center gap-(--space-2) border-b border-stroke-1 py-(--space-2) ps-(--space-4) pe-(--space-2)"
              ),
            ],
            [
              h.h2(
                [
                  h.Id(titleId),
                  h.Class(
                    classNames(
                      "min-w-0 flex-1 truncate",
                      TYPE.title,
                      WEIGHT_STRONG
                    )
                  ),
                ],
                [config.title]
              ),
              iconButton(
                h,
                {
                  variant: "ghost",
                  size: "regular",
                  onClick: config.onClose,
                  isDisabled: false,
                  isBusy: false,
                  isPressed: Option.none(),
                  label: "Close",
                  attributes: [],
                },
                glyph(h, X, "x", "regular")
              ),
            ]
          ),
          h.div(
            [
              h.Class(
                classNames(
                  "min-h-0 flex-1 overflow-y-auto overscroll-contain p-(--space-4) text-ink-2",
                  TYPE.body
                )
              ),
            ],
            body
          ),
          actions.length === 0
            ? h.empty
            : h.footer(
                [
                  h.Class(
                    "flex shrink-0 flex-wrap items-center justify-end gap-(--space-2) border-t border-stroke-1 p-(--space-3)"
                  ),
                ],
                actions
              ),
        ]
      ),
    ]
  );
};
