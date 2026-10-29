// The `next` sheet (the surfaces note's Sheet), for the work panel, a brief's fields or a criteria
// list, in three widths: a bottom sheet on the phone (under `sm`), a floating panel at the top right
// of its pane between `sm` and `lg` (the popover case, not anchored to its trigger), and a panel
// docked to the right edge from `lg`. It has a title, a close button when it can be closed, a body
// that scrolls on its own, and actions at its foot that stay in reach of the thumb.
//
// Two ways to draw one:
//   - `sheetToView` is the renderer @foldkit/ui's dialog view takes as `toView`, for a sheet over the
//     whole page. The dialog Submodel owns what a modal needs: the native `<dialog>`, Escape, the
//     focus trap, focus moving to the first control (or the `initialFocus` group) on open and back
//     to the trigger on close, the scroll lock, and a tap on the scrim closing it. Embed it as
//     `h.submodel({ slotId, model, view: Dialog.view, viewInputs: { toView: sheetToView(...) },
//     toParentMessage })`, fold its messages with `Update.foldChild`, and open it with
//     `Update.foldChildStep({ update: Dialog.open, ... })`; the look catalogue's live sheet is the
//     worked example.
//   - `sheet` draws one inside a positioned pane (it covers only that pane and is not modal), its
//     open state only: whether it is open is its caller's.

import type { RenderInfo } from "@foldkit/ui/dialog";
import { Option } from "effect";
import type {
  Attribute,
  ChildAttribute,
  Html,
  HtmlBuilder,
} from "foldkit/html";
import { X } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { buttonDefaults } from "./Button.ts";
import { TYPE, WEIGHT_STRONG } from "./Classes.ts";
import { glyph } from "./Glyph.ts";
import { iconButton } from "./IconButton.ts";

/** Where the sheet sits: over the whole page, or over one positioned pane. */
export type SheetPlacement = "viewport" | "contained";

/** A sheet in a pane: its id, words and messages. */
export interface SheetConfig<Message> {
  /** The id its title takes, which names the dialog. Unique on the page. */
  readonly id: string;
  readonly title: string;
  /** What the close button and a tap on the scrim send; none draws no close button. */
  readonly onClose: Option.Option<Message>;
  readonly attributes: ReadonlyArray<Attribute<Message>>;
}

const POSITION: Readonly<Record<SheetPlacement, string>> = {
  viewport: "fixed",
  contained: "absolute",
};

// Under sm: a bottom sheet. sm to lg: a floating panel inset from the top right. From lg: docked.
const PANEL = classNames(
  "flex flex-col overflow-hidden border-stroke-1 bg-surface-overlay text-ink-1 shadow-(--elevation-3)",
  "inset-x-0 bottom-0 max-h-[85%] rounded-t-(--radius-large) border-t pb-[env(safe-area-inset-bottom)]",
  "sm:inset-x-auto sm:top-(--space-3) sm:right-(--space-3) sm:bottom-auto sm:max-h-[calc(100%-2*var(--space-3))] sm:w-[min(24rem,calc(100%-2*var(--space-3)))] sm:rounded-(--radius-large) sm:border sm:pb-0",
  "lg:top-0 lg:right-0 lg:bottom-0 lg:max-h-none lg:w-[min(24rem,100%)] lg:rounded-none lg:rounded-l-(--radius-large) lg:border-0 lg:border-l"
);

/** The class string of a sheet's panel at `placement`. */
export const sheetClass = (placement: SheetPlacement): string =>
  classNames(POSITION[placement], "z-(--layer-sheet)", PANEL);

/** The class string of the scrim behind a sheet at `placement`. */
export const scrimClass = (placement: SheetPlacement): string =>
  classNames(POSITION[placement], "inset-0 z-(--layer-scrim) bg-scrim");

/** The close button: a ghost icon button named "Close". */
const closeButton = <Message>(
  h: HtmlBuilder<Message>,
  onClose: Option.Option<Message>,
  attributes: ReadonlyArray<ChildAttribute>
): Html =>
  iconButton(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "ghost",
      onClick: onClose,
      label: "Close",
      attributes,
    },
    glyph(h, X, "x", "regular")
  );

/** The panel's insides: grabber, header with the title and the close button, body, actions. */
const panelInsides = <Message>(
  h: HtmlBuilder<Message>,
  title: Html,
  close: Option.Option<Html>,
  body: ReadonlyArray<Html>,
  actions: ReadonlyArray<Html>
): ReadonlyArray<Html> => [
  h.div([
    h.AriaHidden(true),
    h.Class(
      "mx-auto mt-(--space-2) h-1 w-9 shrink-0 rounded-(--radius-round) bg-stroke-2 sm:hidden"
    ),
  ]),
  h.header(
    [
      h.Class(
        "flex min-h-13 shrink-0 items-center gap-(--space-2) border-b border-stroke-1 py-(--space-2) ps-(--space-4) pe-(--space-2)"
      ),
    ],
    [title, Option.getOrElse(close, () => h.empty)]
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
];

const TITLE_CLASS = classNames(
  "min-w-0 flex-1 truncate",
  TYPE.title,
  WEIGHT_STRONG
);

/** A sheet drawn open inside a positioned pane: scrim, then the panel. Not modal. */
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
      h.DataAttribute("placement", "contained"),
      h.Class("contents"),
    ],
    [
      h.div([
        h.DataAttribute("slot", "sheet-scrim"),
        h.AriaHidden(true),
        ...Option.toArray(
          Option.map(config.onClose, (message) => h.OnClick(message))
        ),
        h.Class(scrimClass("contained")),
      ]),
      h.div(
        [
          h.Id(config.id),
          h.Role("dialog"),
          h.AriaLabelledBy(titleId),
          ...config.attributes,
          h.Class(sheetClass("contained")),
        ],
        panelInsides(
          h,
          h.h2([h.Id(titleId), h.Class(TITLE_CLASS)], [config.title]),
          Option.map(config.onClose, (message) =>
            closeButton(h, Option.some(message), [])
          ),
          body,
          actions
        )
      ),
    ]
  );
};

/**
 * The renderer @foldkit/ui's dialog view takes as `toView`: the sheet over the whole page, its
 * scrim the dialog's backdrop, its title the dialog's name and its close button the dialog's.
 */
export const sheetToView =
  <Message>(
    h: HtmlBuilder<Message>,
    title: string,
    body: ReadonlyArray<Html>,
    actions: ReadonlyArray<Html>,
    attributes: ReadonlyArray<Attribute<Message>> = []
  ) =>
  (render: RenderInfo): Html =>
    h.dialog(
      [
        ...render.dialog,
        h.DataAttribute("slot", "sheet"),
        h.DataAttribute("placement", "viewport"),
        h.Class("bg-transparent p-0 backdrop:bg-transparent"),
      ],
      render.isVisible
        ? [
            h.div([
              ...render.backdrop,
              h.DataAttribute("slot", "sheet-scrim"),
              h.Class(scrimClass("viewport")),
            ]),
            h.div(
              [...render.panel, ...attributes, h.Class(sheetClass("viewport"))],
              panelInsides(
                h,
                h.h2([...render.title, h.Class(TITLE_CLASS)], [title]),
                Option.some(closeButton(h, Option.none(), render.closeButton)),
                body,
                actions
              )
            ),
          ]
        : []
    );
