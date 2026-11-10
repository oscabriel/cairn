// The `next` sheet (the surfaces note's Sheet): every overlay the shell opens (the work and goal
// panels, the scratch overlay, the refresh confirm, the add-project picker, the rename and remove
// dialog) and the catalogue's specimens. It has a title, a close button with its tooltip, a body
// that scrolls on its own (or, for a thread, lays out its own scrolling), and actions at its foot
// that stay in reach of the thumb. On a phone it is always a bottom sheet with a grabber; wider, its
// kind says what it is:
//   - `panel`: a floating panel at the top right of its pane from `sm`, docked to the right edge
//     from `lg` (a brief's fields, a criteria list);
//   - `dialog`: a card under the top of the window from `md` (a confirm, a picker);
//   - `thread`: a tall, wide card from `md` that holds a transcript and its composer (the scratch
//     overlay).
//
// The ways to draw one:
//   - `modalSheet` over the whole page, as a real dialog: @foldkit/ui's dialog owns the native
//     `<dialog>`, the role and its name, the background made inert, the focus trap, focus moving in
//     (to `focusSelector`, else the first control) and back to what held it, the scroll lock,
//     Escape and a tap on the scrim. The caller keeps whether the sheet is open, so the dialog takes
//     the page when its element mounts (`AcquireResources`, which also serves a view drawn late
//     from its chunk) and gives it back when the element leaves; Escape, the scrim and Close come
//     back as the caller's `onClose`, and the dialog's other news as `onSettled`, which changes
//     nothing.
//   - `sheet` inside a positioned pane (the catalogue's specimens): it covers only that pane and is
//     not modal.
//   - `sideColumn`: the same parts as a column beside the page from `lg` (the work and goal panels
//     on a wide screen), not modal, since the page beside it stays in use.
//   - `sheetToView` is the renderer `modalSheet` hands the dialog, for a caller (the catalogue's live
//     sheet) that keeps the dialog's own Model.

import * as Dialog from "@foldkit/ui/dialog";
import type { RenderInfo } from "@foldkit/ui/dialog";
import { Option, Predicate } from "effect";
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
import { iconButtonWithTooltip } from "./IconButton.ts";

/** Where the sheet sits: over the whole page, or over one positioned pane. */
export type SheetPlacement = "viewport" | "contained";

/** What the sheet is from `sm` or `md` up: a side panel, a dialog, or a thread's card. */
export type SheetKind = "panel" | "dialog" | "thread";

/**
 * How the body lays out: `text`, padded words that scroll; `list`, rows and sections with a gap
 * that scroll; `fill`, a body that lays out its own scrolling (a transcript over its composer).
 */
export type SheetLayout = "text" | "list" | "fill";

/** A sheet's id, words, kind and attributes. */
export interface SheetConfig<Message> {
  /** The sheet's id, which its title's id derives from. Unique on the page. */
  readonly id: string;
  readonly title: string;
  readonly kind: SheetKind;
  readonly layout: SheetLayout;
  /** Controls in the header between the title and Close: a hint, an action of the sheet's own. */
  readonly headerExtras: ReadonlyArray<Html>;
  /** The close button's name, which its tooltip repeats. */
  readonly closeLabel: string;
  /** What Close and a tap on the scrim send; none draws no close button (in a pane or a column). */
  readonly onClose: Option.Option<Message>;
  /**
   * More classes on the panel, for what its kind leaves to the caller (a `dialog`'s height); never
   * one its kind sets.
   */
  readonly panelClass: string;
  /** More attributes on the panel: test ids, hooks. */
  readonly attributes: ReadonlyArray<Attribute<Message>>;
  readonly scrimAttributes: ReadonlyArray<Attribute<Message>>;
  readonly closeAttributes: ReadonlyArray<Attribute<Message>>;
}

/** A plain panel sheet named `title` that nothing closes. Spread over it to configure one. */
export const sheetDefaults = <Message>(
  id: string,
  title: string
): SheetConfig<Message> => ({
  id,
  title,
  kind: "panel",
  layout: "text",
  headerExtras: [],
  closeLabel: "Close",
  onClose: Option.none(),
  panelClass: "",
  attributes: [],
  scrimAttributes: [],
  closeAttributes: [],
});

/** A sheet over the whole page, as a dialog: the sheet's config with what the dialog needs. */
export interface ModalSheetConfig<Message> extends Omit<
  SheetConfig<Message>,
  "onClose"
> {
  /** `alertdialog` for a confirm of something nothing undoes. */
  readonly role: "dialog" | "alertdialog";
  /** The control that takes focus when it opens; none gives it to the first control. */
  readonly focusSelector: Option.Option<string>;
  /** What Escape, a tap on the scrim and Close send. */
  readonly onClose: Message;
  /** What the dialog's other news sends (it took or gave back the page); it changes nothing. */
  readonly onSettled: Message;
}

const POSITION: Readonly<Record<SheetPlacement, string>> = {
  viewport: "fixed",
  contained: "absolute",
};

// On the phone, every kind: a bottom sheet with a grabber.
const BOTTOM =
  "flex flex-col overflow-hidden border-stroke-2 bg-surface-overlay text-ink-1 shadow-(--elevation-3) inset-x-0 bottom-0 max-h-[85%] rounded-t-(--radius-large) border-t pb-[env(safe-area-inset-bottom)]";

const KIND: Readonly<Record<SheetKind, string>> = {
  // sm to lg: a floating panel inset from the top right. From lg: docked.
  panel: classNames(
    "sm:inset-x-auto sm:top-(--space-3) sm:right-(--space-3) sm:bottom-auto sm:max-h-[calc(100%-2*var(--space-3))] sm:w-[min(24rem,calc(100%-2*var(--space-3)))] sm:rounded-(--radius-large) sm:border sm:pb-0",
    "lg:top-0 lg:right-0 lg:bottom-0 lg:max-h-none lg:w-[min(24rem,100%)] lg:rounded-none lg:rounded-l-(--radius-large) lg:border-0 lg:border-l"
  ),
  // From md: a card under the top of the window.
  dialog:
    "md:inset-x-(--space-3) md:top-24 md:bottom-auto md:mx-auto md:max-h-[calc(100%-8rem)] md:max-w-lg md:rounded-(--radius-large) md:border md:pb-0",
  // Tall on the phone, so the transcript has room; from md a wide card.
  thread:
    "h-[calc(100%-4rem)] md:inset-x-(--space-8) md:top-18 md:bottom-auto md:mx-auto md:h-[min(35rem,calc(100%-6rem))] md:max-h-none md:max-w-[45rem] md:rounded-(--radius-large) md:border md:pb-0",
};

// The grabber shows while the sheet is a bottom sheet.
const GRABBER: Readonly<Record<SheetKind, string>> = {
  panel: "sm:hidden",
  dialog: "md:hidden",
  thread: "md:hidden",
};

/** The class string of a sheet's panel at `placement`, of `kind`. */
export const sheetClass = (
  placement: SheetPlacement,
  kind: SheetKind = "panel"
): string =>
  classNames(POSITION[placement], "z-(--layer-sheet)", BOTTOM, KIND[kind]);

/** The class string of the scrim behind a sheet at `placement`. */
export const scrimClass = (placement: SheetPlacement): string =>
  classNames(POSITION[placement], "inset-0 z-(--layer-scrim) bg-scrim");

/** The column beside a page from `lg`: the sheet's parts, docked, on the page's ground. */
const COLUMN_CLASS =
  "flex w-[22rem] min-w-0 shrink-0 flex-col overflow-hidden border-l border-stroke-1 bg-surface-ground text-ink-1";

const BODY: Readonly<Record<SheetLayout, string>> = {
  text: classNames(
    "min-h-0 flex-1 overflow-y-auto overscroll-contain p-(--space-4) text-ink-2",
    TYPE.body
  ),
  list: "flex min-h-0 flex-1 flex-col gap-(--space-3) overflow-y-auto overscroll-contain p-(--space-2)",
  fill: "flex min-h-0 flex-1 flex-col",
};

const TITLE_CLASS = classNames(
  "min-w-0 flex-1 truncate",
  TYPE.title,
  WEIGHT_STRONG
);

/** The close button: a ghost icon button with its name as a tooltip. */
const closeButton = <Message>(
  h: HtmlBuilder<Message>,
  config: Pick<SheetConfig<Message>, "closeLabel" | "closeAttributes">,
  onClose: Option.Option<Message>,
  attributes: ReadonlyArray<ChildAttribute>
): Html =>
  iconButtonWithTooltip(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "ghost",
      onClick: onClose,
      label: config.closeLabel,
      attributes: [...attributes, ...config.closeAttributes],
    },
    glyph(h, X, "x", "regular"),
    "end"
  );

/** The panel's insides: grabber, header with the title and the close button, body, actions. */
const panelInsides = <Message>(
  h: HtmlBuilder<Message>,
  config: Pick<SheetConfig<Message>, "kind" | "layout" | "headerExtras">,
  title: Html,
  close: Option.Option<Html>,
  body: ReadonlyArray<Html>,
  actions: ReadonlyArray<Html>
): ReadonlyArray<Html> => [
  h.div([
    h.AriaHidden(true),
    h.Class(
      classNames(
        "mx-auto mt-(--space-2) h-1 w-9 shrink-0 rounded-(--radius-round) bg-stroke-2",
        GRABBER[config.kind]
      )
    ),
  ]),
  h.header(
    [
      h.Class(
        "flex min-h-13 shrink-0 items-center gap-(--space-2) border-b border-stroke-1 py-(--space-2) ps-(--space-4) pe-(--space-2) lg:min-h-14"
      ),
    ],
    [title, ...config.headerExtras, Option.getOrElse(close, () => h.empty)]
  ),
  h.div(
    [h.DataAttribute("slot", "sheet-body"), h.Class(BODY[config.layout])],
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
        ...config.scrimAttributes,
        h.Class(scrimClass("contained")),
      ]),
      h.div(
        [
          h.Id(config.id),
          h.Role("dialog"),
          h.AriaLabelledBy(titleId),
          ...config.attributes,
          h.Class(
            classNames(sheetClass("contained", config.kind), config.panelClass)
          ),
        ],
        panelInsides(
          h,
          config,
          h.h2([h.Id(titleId), h.Class(TITLE_CLASS)], [config.title]),
          Option.map(config.onClose, (message) =>
            closeButton(h, config, Option.some(message), [])
          ),
          body,
          actions
        )
      ),
    ]
  );
};

/** The sheet's parts as a column beside the page (from `lg`): a named region, not modal. */
export const sideColumn = <Message>(
  h: HtmlBuilder<Message>,
  config: SheetConfig<Message>,
  body: ReadonlyArray<Html>,
  actions: ReadonlyArray<Html>
): Html => {
  const titleId = `${config.id}-title`;

  return h.aside(
    [
      h.Id(config.id),
      h.DataAttribute("slot", "sheet"),
      h.DataAttribute("placement", "column"),
      h.AriaLabelledBy(titleId),
      ...config.attributes,
      h.Class(COLUMN_CLASS),
    ],
    panelInsides(
      h,
      config,
      h.h2([h.Id(titleId), h.Class(TITLE_CLASS)], [config.title]),
      Option.map(config.onClose, (message) =>
        closeButton(h, config, Option.some(message), [])
      ),
      body,
      actions
    )
  );
};

/**
 * The renderer @foldkit/ui's dialog view takes as `toView`: the sheet over the whole page, its
 * scrim the dialog's backdrop, its title the dialog's name and its close button the dialog's.
 */
export const sheetToView =
  <Message>(
    h: HtmlBuilder<Message>,
    config: Omit<ModalSheetConfig<Message>, "onClose" | "onSettled">,
    body: ReadonlyArray<Html>,
    actions: ReadonlyArray<Html>
  ) =>
  (render: RenderInfo): Html =>
    h.dialog(
      [
        ...render.dialog,
        h.Role(config.role),
        h.DataAttribute("slot", "sheet"),
        h.DataAttribute("placement", "viewport"),
        h.Class("bg-transparent p-0 backdrop:bg-transparent"),
      ],
      render.isVisible
        ? [
            h.div([
              ...render.backdrop,
              h.DataAttribute("slot", "sheet-scrim"),
              ...config.scrimAttributes,
              h.Class(scrimClass("viewport")),
            ]),
            h.div(
              [
                ...render.panel,
                ...config.attributes,
                h.Class(
                  classNames(
                    sheetClass("viewport", config.kind),
                    config.panelClass
                  )
                ),
              ],
              panelInsides(
                h,
                config,
                h.h2([...render.title, h.Class(TITLE_CLASS)], [config.title]),
                Option.some(
                  closeButton(h, config, Option.none(), render.closeButton)
                ),
                body,
                actions
              )
            ),
          ]
        : []
    );

/** The dialog's Model while its sheet is open: the caller keeps whether it is. */
const openDialog = (
  id: string,
  focusSelector: Option.Option<string>
): Dialog.Model => ({
  ...Option.match(focusSelector, {
    onNone: () => Dialog.init({ id }),
    onSome: (selector) => Dialog.init({ id, focusSelector: selector }),
  }),
  isOpen: true,
});

/** What a dialog's Message is to the caller: Escape, the scrim or Close, else nothing to keep. */
export const dialogMessageTo =
  <Message>(onClose: Message, onSettled: Message) =>
  (message: Dialog.Message): Message =>
    Predicate.isTagged(message, "RequestedClose") ? onClose : onSettled;

/**
 * A sheet over the whole page, open while the caller draws it: a real dialog (see the header).
 * Draw nothing in its place to close it; focus goes back to what held it before it opened.
 */
export const modalSheet = <Message>(
  h: HtmlBuilder<Message>,
  config: ModalSheetConfig<Message>,
  body: ReadonlyArray<Html>,
  actions: ReadonlyArray<Html>
): Html =>
  h.submodel({
    slotId: config.id,
    model: openDialog(config.id, config.focusSelector),
    view: Dialog.view,
    viewInputs: { toView: sheetToView(h, config, body, actions) },
    toParentMessage: dialogMessageTo(config.onClose, config.onSettled),
  });

/**
 * A modal sheet where `placement` says: over the whole page as a dialog (`modalSheet`), or in a
 * positioned pane as the catalogue's specimen (`sheet`), closed by the same Message.
 */
export const placedSheet = <Message>(
  h: HtmlBuilder<Message>,
  placement: SheetPlacement,
  config: ModalSheetConfig<Message>,
  body: ReadonlyArray<Html>,
  actions: ReadonlyArray<Html>
): Html =>
  placement === "viewport"
    ? modalSheet(h, config, body, actions)
    : sheet(
        h,
        { ...config, onClose: Option.some(config.onClose) },
        body,
        actions
      );
