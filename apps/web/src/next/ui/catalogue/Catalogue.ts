// The look catalogue (`/__look`, dev builds only): every `next` primitive in every state, in the
// one look (Stone revised) in dark or light, picked by the switch at its top or by `?theme=` in its
// address. It is the page `judges/look-rules.ts` judges at 390 and 1,440 px and the one the look
// tool screenshots; it draws with the design tokens only, so a token change shows here first.
//
// Each primitive has its section (`data-testid="look-<primitive>"`) and each state its specimen
// (`data-look-state="<primitive>/<state>"`), so a judge or a screenshot can name one. Hover and
// focus are shown without a pointer or a keyboard through the primitives' `data-hover` and
// `data-focus` hooks. The production build never includes this page: its only entry is
// `apps/web/index.html`, and `Budget.test.ts` fails if any emitted file carries the catalogue.

import { HOLD_LABELS, THREAD_LABELS } from "@cairn/client-logic/ThreadState";
import * as Dialog from "@foldkit/ui/dialog";
import { Option, Schema } from "effect";
import { Update } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Copy, Ellipsis, Inbox, Plus, Search, Settings, X } from "lucide";

import { classNames } from "../../../ui/ClassNames.ts";
import { avatar, glyphAvatar } from "../Avatar.ts";
import type { AvatarSize } from "../Avatar.ts";
import { banner } from "../Banner.ts";
import { BUTTON_VARIANTS, button, buttonDefaults } from "../Button.ts";
import type { ButtonConfig, ButtonSize } from "../Button.ts";
import { card, cardText, recordLines } from "../Card.ts";
import { chip, toggleChip } from "../Chip.ts";
import { TYPE, WEIGHT_STRONG } from "../Classes.ts";
import { disclosure } from "../Disclosure.ts";
import { divider, labelledDivider } from "../Divider.ts";
import { emptyState } from "../EmptyState.ts";
import { fieldDefaults, inputField, textareaField } from "../Field.ts";
import type { FieldConfig } from "../Field.ts";
import { glyph, markOfTone, STATUS_MARKS, statusGlyph } from "../Glyph.ts";
import type { GlyphSize } from "../Glyph.ts";
import { iconButton } from "../IconButton.ts";
import { kbd, shortcut } from "../Kbd.ts";
import { menuPanel } from "../Menu.ts";
import type { MenuItemLook, PanelItem } from "../Menu.ts";
import { meter, progress } from "../Meter.ts";
import { row, rowDefaults } from "../Row.ts";
import type { RowConfig, RowContent } from "../Row.ts";
import { sheet, sheetToView } from "../Sheet.ts";
import { statusChip, statusOfLabel } from "../StatusChip.ts";
import { STEP_STATES, stepper, stepsPill, stepWord } from "../Stepper.ts";
import type { Step } from "../Stepper.ts";
import { tally } from "../Tally.ts";
import type { TallyPart } from "../Tally.ts";
import { TONES, TONE_TEXT } from "../Tone.ts";
import type { Tone } from "../Tone.ts";
import { tooltipBubble } from "../Tooltip.ts";
import { shellSpecimens } from "./ShellSpecimens.ts";

/** A theme: the `dark` class or its absence. */
export const Theme = Schema.Literals(["dark", "light"]);

/** A theme. */
export type Theme = typeof Theme.Type;

/** The catalogue's state: the theme it draws in, and what its live specimens hold. */
export const Model = Schema.Struct({
  theme: Theme,
  /** The toggle chips that are pressed. */
  filters: Schema.Array(Schema.String),
  /** The live sheet over the page: @foldkit/ui's dialog, opened by its button. */
  sheetDialog: Dialog.Model,
  /** The live disclosures that are open, by id. */
  openDisclosures: Schema.Array(Schema.String),
  /** What the live field holds. */
  answer: Schema.String,
});

/** The catalogue's state. */
export type Model = typeof Model.Type;

/** What the catalogue's switch and live specimens send. */
export const Message = defineMessageUnion({
  ChoseTheme: { theme: Theme },
  ToggledFilter: { filter: Schema.String },
  /** A shell specimen was used; the catalogue shows states and keeps none. */
  IgnoredSpecimen: {},
  OpenedSheet: {},
  GotSheetDialogMessage: { message: Dialog.Message },
  ToggledDisclosure: { id: Schema.String, isOpen: Schema.Boolean },
  TypedAnswer: { value: Schema.String },
});

/** What the catalogue's switch and live specimens send. */
export type Message = typeof Message.Type;

type Return = Update.Return<Model, Message>;

/** The live sheet's dialog id. */
const LIVE_SHEET_ID = "look-sheet-live";

/** The dialog's Opened and Closed change nothing here: its own model says whether it is open. */
const keepModel = (): Update.Step<Model, Message> => (model) => ({ model });

const readSheetDialog = (model: Model) => Option.some(model.sheetDialog);

const writeSheetDialog = (model: Model, sheetDialog: Dialog.Model): Model => ({
  ...model,
  sheetDialog,
});

const toGotSheetDialogMessage = (message: Dialog.Message): Message =>
  Message.GotSheetDialogMessage({ message });

const foldSheetDialog = Update.foldChild({
  update: Dialog.update,
  read: readSheetDialog,
  write: writeSheetDialog,
  toParentMessage: toGotSheetDialogMessage,
  foldOutMessage: keepModel,
});

const openSheetDialog = Update.foldChildStep({
  update: Dialog.open,
  read: readSheetDialog,
  write: writeSheetDialog,
  toParentMessage: toGotSheetDialogMessage,
  foldOutMessage: keepModel,
});

const decodeTheme = Schema.decodeUnknownOption(Theme);

/** The catalogue as an address asks for it: `?theme=`, else dark. */
export const initialOf = (search: string): Model => {
  const query = new URLSearchParams(search);

  return {
    theme: Option.getOrElse(
      decodeTheme(query.get("theme")),
      () => "dark" as const
    ),
    filters: ["Open"],
    sheetDialog: Dialog.init({ id: LIVE_SHEET_ID }),
    openDisclosures: ["look-disclosure-phase"],
    answer: "",
  };
};

/** The catalogue's update: the switch sets the theme; live specimens keep their state. */
export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ChoseTheme: ({ theme }) => ({ model: { ...model, theme } }),
    ToggledFilter: ({ filter }) => ({
      model: {
        ...model,
        filters: model.filters.includes(filter)
          ? model.filters.filter((each) => each !== filter)
          : [...model.filters, filter],
      },
    }),
    OpenedSheet: () => openSheetDialog(model),
    GotSheetDialogMessage: ({ message: dialogMessage }) =>
      foldSheetDialog(model, dialogMessage),
    ToggledDisclosure: ({ id, isOpen }) => ({
      model: {
        ...model,
        openDisclosures: isOpen
          ? [...model.openDisclosures.filter((each) => each !== id), id]
          : model.openDisclosures.filter((each) => each !== id),
      },
    }),
    TypedAnswer: ({ value }) => ({ model: { ...model, answer: value } }),
    IgnoredSpecimen: () => ({ model }),
  });

// ---------------------------------------------------------------------------------------------
// Layout

type H = HtmlBuilder<Message>;

const HOVER = (h: H): Attribute<Message> => h.DataAttribute("hover", "");

const FOCUS = (h: H): Attribute<Message> => h.DataAttribute("focus", "");

/** One state of one primitive, captioned with the state's name. */
const specimen = (
  h: H,
  state: string,
  caption: string,
  content: ReadonlyArray<Html>,
  layout = "flex flex-wrap items-center gap-(--space-2)"
): Html =>
  h.figure(
    [
      h.DataAttribute("look-state", state),
      h.Class("flex min-w-0 flex-col gap-(--space-1-5)"),
    ],
    [
      h.div([h.Class(classNames("min-w-0", layout))], content),
      h.figcaption([h.Class(classNames("text-ink-3", TYPE.small))], [caption]),
    ]
  );

/** One primitive's section: its name and its specimens. */
const section = (
  h: H,
  id: string,
  title: string,
  specimens: ReadonlyArray<Html>,
  wide = false
): Html =>
  h.section(
    [
      h.DataAttribute("testid", `look-${id}`),
      h.AriaLabel(title),
      h.Class(
        classNames(
          "flex min-w-0 flex-col gap-(--space-4) rounded-(--radius-large) border border-stroke-1 bg-surface-sidebar p-(--space-4)",
          wide && "lg:col-span-2"
        )
      ),
    ],
    [
      h.h2(
        [h.Class(classNames("text-ink-1", TYPE.title, WEIGHT_STRONG))],
        [title]
      ),
      h.div(
        [
          h.Class(
            "grid min-w-0 grid-cols-1 gap-(--space-4) sm:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]"
          ),
        ],
        specimens
      ),
    ]
  );

// ---------------------------------------------------------------------------------------------
// Specimens

const buttonOf = (
  h: H,
  config: Partial<ButtonConfig<Message>>,
  label: string
): Html => button(h, { ...buttonDefaults<Message>(), ...config }, [label]);

const buttons = (h: H): Html =>
  section(h, "button", "Button", [
    ...(["regular", "small"] as const).flatMap((size: ButtonSize) =>
      BUTTON_VARIANTS.map((variant) =>
        specimen(h, `button/${variant}-${size}`, `${variant}, ${size}`, [
          buttonOf(h, { variant, size }, "Rest"),
          buttonOf(h, { variant, size, attributes: [HOVER(h)] }, "Hover"),
          buttonOf(h, { variant, size, attributes: [FOCUS(h)] }, "Focus"),
          buttonOf(h, { variant, size, isBusy: true }, "Busy"),
          buttonOf(h, { variant, size, isDisabled: true }, "Disabled"),
        ])
      )
    ),
    specimen(h, "button/toggle", "toggle: off, on", [
      buttonOf(h, { isPressed: Option.some(false) }, "Off"),
      buttonOf(h, { isPressed: Option.some(true) }, "On"),
      buttonOf(h, { variant: "ghost", isPressed: Option.some(false) }, "Off"),
      buttonOf(h, { variant: "ghost", isPressed: Option.some(true) }, "On"),
    ]),
    specimen(h, "button/glyph", "with a glyph", [
      button(h, { ...buttonDefaults<Message>(), variant: "primary" }, [
        glyph(h, Plus, "plus", "regular"),
        "New thread",
      ]),
      button(h, { ...buttonDefaults<Message>(), size: "small" }, [
        glyph(h, Copy, "copy", "small"),
        "Copy",
      ]),
    ]),
  ]);

const iconButtons = (h: H): Html => {
  const of = (
    variant: ButtonConfig<Message>["variant"],
    size: ButtonSize,
    state: "rest" | "hover" | "focus" | "busy" | "disabled"
  ) => {
    const forced: Readonly<
      Record<typeof state, ReadonlyArray<Attribute<Message>>>
    > = {
      rest: [],
      hover: [HOVER(h)],
      focus: [FOCUS(h)],
      busy: [],
      disabled: [],
    };

    return iconButton(
      h,
      {
        ...buttonDefaults<Message>(),
        variant,
        size,
        isBusy: state === "busy",
        isDisabled: state === "disabled",
        label: `Settings (${state})`,
        attributes: forced[state],
      },
      glyph(h, Settings, "settings", size === "small" ? "small" : "regular")
    );
  };

  return section(h, "icon-button", "Icon button", [
    ...(["regular", "small"] as const).flatMap((size: ButtonSize) =>
      BUTTON_VARIANTS.map((variant) =>
        specimen(
          h,
          `icon-button/${variant}-${size}`,
          `${variant}, ${size}: rest, hover, focus, busy, disabled`,
          (["rest", "hover", "focus", "busy", "disabled"] as const).map(
            (state) => of(variant, size, state)
          )
        )
      )
    ),
    specimen(h, "icon-button/tooltip", "with its tooltip", [
      iconButton(
        h,
        {
          ...buttonDefaults<Message>(),
          variant: "ghost",
          label: "More actions",
          attributes: [h.AriaDescribedBy("look-tooltip-more")],
        },
        glyph(h, Ellipsis, "ellipsis", "regular")
      ),
      tooltipBubble(h, "look-tooltip-more", "More actions"),
    ]),
  ]);
};

const chips = (h: H, model: Model): Html =>
  section(h, "chip", "Chip", [
    specimen(
      h,
      "chip/tones",
      "every tone",
      TONES.map((tone) =>
        chip(h, tone, {
          glyph: Option.none(),
          label: tone,
          count: Option.none(),
        })
      )
    ),
    specimen(h, "chip/parts", "glyph, count, long label", [
      chip(h, "neutral", {
        glyph: Option.some(glyph(h, Search, "search", "small")),
        label: "Search",
        count: Option.none(),
      }),
      chip(h, "accent", {
        glyph: Option.none(),
        label: "Subagents",
        count: Option.some(12),
      }),
      h.span(
        [h.Class("flex min-w-0 max-w-40")],
        [
          chip(h, "neutral", {
            glyph: Option.none(),
            label: "a branch name long enough to be cut short by its chip",
            count: Option.none(),
          }),
        ]
      ),
    ]),
    specimen(h, "chip/toggle", "toggle: pressed, not, hover, focus", [
      ...["Open", "Waiting", "Done"].map((filter) =>
        toggleChip(
          h,
          {
            isPressed: model.filters.includes(filter),
            onClick: Option.some(Message.ToggledFilter({ filter })),
            attributes: [],
          },
          { glyph: Option.none(), label: filter, count: Option.none() }
        )
      ),
      toggleChip(
        h,
        { isPressed: false, onClick: Option.none(), attributes: [HOVER(h)] },
        { glyph: Option.none(), label: "Hover", count: Option.none() }
      ),
      toggleChip(
        h,
        { isPressed: false, onClick: Option.none(), attributes: [FOCUS(h)] },
        { glyph: Option.none(), label: "Focus", count: Option.none() }
      ),
    ]),
  ]);

const statusChips = (h: H): Html =>
  section(h, "status-chip", "Status chip", [
    specimen(
      h,
      "status-chip/tones",
      "every tone with its mark",
      TONES.map((tone) =>
        statusChip(h, { tone, mark: markOfTone(tone), word: tone })
      )
    ),
    specimen(
      h,
      "status-chip/labels",
      "every thread label",
      Object.values(THREAD_LABELS).map((label) =>
        statusChip(h, statusOfLabel(label))
      )
    ),
    specimen(
      h,
      "status-chip/holds",
      "every hold label",
      Object.values(HOLD_LABELS).map((label) =>
        statusChip(h, statusOfLabel(label))
      )
    ),
  ]);

const glyphs = (h: H): Html =>
  section(
    h,
    "glyph",
    "Glyph",
    (["small", "regular", "large"] as const).map((size: GlyphSize) =>
      specimen(
        h,
        `glyph/${size}`,
        `status marks, ${size}`,
        STATUS_MARKS.map((mark) =>
          h.span(
            [
              h.Class(
                TONE_TEXT[
                  TONES.find((tone) => markOfTone(tone) === mark) ?? "neutral"
                ]
              ),
            ],
            [statusGlyph(h, mark, size)]
          )
        )
      )
    )
  );

const avatars = (h: H): Html =>
  section(h, "avatar", "Avatar", [
    ...(["small", "regular", "large"] as const).map((size: AvatarSize) =>
      specimen(
        h,
        `avatar/${size}`,
        `${size}, every tone`,
        TONES.map((tone, index) =>
          avatar(
            h,
            ["cairn", "@worker", "@scout", "pi durable", "porch", "web"][
              index
            ] ?? "cairn",
            size,
            tone
          )
        )
      )
    ),
    specimen(h, "avatar/glyph", "glyph", [
      glyphAvatar(h, glyph(h, Inbox, "inbox", "small"), "regular", "accent"),
      glyphAvatar(h, glyph(h, Inbox, "inbox", "large"), "large", "neutral"),
    ]),
  ]);

const rowOf = (
  h: H,
  config: Partial<RowConfig<Message>>,
  content: Partial<RowContent>
): Html =>
  row(
    h,
    { ...rowDefaults<Message>(), ...config },
    {
      leading: Option.some(
        h.span([h.Class(TONE_TEXT.done)], [statusGlyph(h, "done", "regular")])
      ),
      title: "Port the request card",
      meta: Option.some("4m"),
      hint: Option.none(),
      trailing: [],
      ...content,
    }
  );

const rows = (h: H): Html =>
  section(h, "row", "Row", [
    specimen(
      h,
      "row/states",
      "rest, hover, focus, current, emphasised, disabled",
      [
        rowOf(h, {}, { title: "Rest" }),
        rowOf(h, { attributes: [HOVER(h)] }, { title: "Hover" }),
        rowOf(h, { attributes: [FOCUS(h)] }, { title: "Focus" }),
        rowOf(h, { isCurrent: true }, { title: "Current" }),
        rowOf(h, { isEmphasised: true }, { title: "Emphasised" }),
        rowOf(h, { isDisabled: true }, { title: "Disabled" }),
      ],
      "flex flex-col"
    ),
    specimen(
      h,
      "row/parts",
      "status, key hint, trailing action, long title",
      [
        rowOf(
          h,
          {},
          {
            leading: Option.some(
              h.span(
                [h.Class(TONE_TEXT.working)],
                [statusGlyph(h, "busy", "regular")]
              )
            ),
            title: "Working",
            meta: Option.none(),
            hint: Option.some(shortcut(h, ["Ctrl", "1"])),
          }
        ),
        rowOf(
          h,
          {},
          {
            title:
              "A thread title long enough that it has to be cut short at the end of its row",
            trailing: [
              iconButton(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost",
                  size: "small",
                  label: "Thread actions",
                },
                glyph(h, Ellipsis, "ellipsis", "small")
              ),
            ],
          }
        ),
        rowOf(
          h,
          {},
          {
            leading: Option.some(avatar(h, "@scout", "small", "accent")),
            title: "@scout reads the reach note",
            meta: Option.some("$0.04"),
          }
        ),
      ],
      "flex flex-col"
    ),
  ]);

const cards = (h: H): Html =>
  section(
    h,
    "card",
    "Card",
    [
      ...TONES.map((tone) =>
        specimen(h, `card/${tone}`, tone, [
          card(h, {
            tone,
            title: `A ${tone} card`,
            aside: [
              statusChip(h, { tone, mark: markOfTone(tone), word: tone }),
            ],
            body: [cardText(h, "One paragraph of body text in the card.")],
            actions: [],
          }),
        ])
      ),
      specimen(h, "card/brief", "fields and actions", [
        card(h, {
          tone: "waiting",
          title: "Brief: port pendingUserInput and its tests from the nightly",
          aside: [statusChip(h, statusOfLabel(THREAD_LABELS.go))],
          body: [
            recordLines(h, [
              ["Role", "@worker"],
              ["Writes", "packages/client-logic/src/PendingCard.ts"],
              ["Result", "a summary and the test count"],
              ["Budget", "$2.00"],
            ]),
          ],
          actions: [
            buttonOf(h, { variant: "ghost" }, "Decline"),
            buttonOf(h, {}, "Send back"),
            buttonOf(h, { variant: "primary" }, "Go"),
          ],
        }),
      ]),
    ],
    true
  );

const menuItemLook = (
  label: string,
  look: Partial<MenuItemLook> = {}
): MenuItemLook => ({
  glyph: Option.none(),
  label,
  hint: Option.none(),
  isDestructive: false,
  ...look,
});

const panelItem = (
  look: MenuItemLook,
  state: Partial<PanelItem<Message>> = {}
): PanelItem<Message> => ({
  look,
  isActive: false,
  isDisabled: false,
  onClick: Option.none(),
  ...state,
});

const menus = (h: H): Html =>
  section(h, "menu", "Menu", [
    specimen(h, "menu/open", "open: active, hint, disabled, destructive", [
      menuPanel(h, "Thread actions", [
        {
          heading: Option.some("Thread"),
          items: [
            panelItem(
              menuItemLook("Rename", { hint: Option.some(kbd(h, "R")) }),
              { isActive: true }
            ),
            panelItem(
              menuItemLook("Copy link", {
                glyph: Option.some(glyph(h, Copy, "copy", "regular")),
              })
            ),
            panelItem(menuItemLook("Move to project"), { isDisabled: true }),
          ],
        },
        {
          heading: Option.none(),
          items: [
            panelItem(
              menuItemLook("Archive", {
                isDestructive: true,
                glyph: Option.some(glyph(h, X, "x", "regular")),
              })
            ),
          ],
        },
      ]),
    ]),
  ]);

const sheets = (h: H, model: Model): Html =>
  section(
    h,
    "sheet",
    "Sheet",
    [
      specimen(
        h,
        "sheet/contained",
        "open in a pane, nothing closes it: bottom sheet on the phone, floating from sm, docked from lg",
        [
          h.div(
            [
              h.Class(
                "relative h-80 w-full overflow-hidden rounded-(--radius-medium) border border-stroke-1 bg-surface-ground"
              ),
            ],
            [
              h.p(
                [h.Class(classNames("p-(--space-4) text-ink-2", TYPE.body))],
                ["The pane under the sheet."]
              ),
              sheet(
                h,
                {
                  id: "look-sheet-contained",
                  title: "Steps",
                  onClose: Option.none(),
                  attributes: [],
                },
                [
                  cardText(
                    h,
                    "The work panel's steps for a child, or a goal's criteria."
                  ),
                ],
                [buttonOf(h, { variant: "primary" }, "Done")]
              ),
            ]
          ),
        ],
        "flex"
      ),
      specimen(h, "sheet/live", "over the page, opened by a button", [
        buttonOf(
          h,
          {
            onClick: Option.some(Message.OpenedSheet()),
            attributes: [h.DataAttribute("testid", "look-open-sheet")],
          },
          "Open sheet"
        ),
        h.submodel({
          slotId: "look-sheet-live",
          model: model.sheetDialog,
          view: Dialog.view,
          viewInputs: {
            toView: sheetToView(
              h,
              "Criteria",
              [cardText(h, "Escape, the scrim or Close dismisses it.")],
              [buttonOf(h, { variant: "primary" }, "Done")],
              [h.DataAttribute("testid", "look-live-sheet")]
            ),
          },
          toParentMessage: toGotSheetDialogMessage,
        }),
      ]),
    ],
    true
  );

const tooltips = (h: H): Html =>
  section(h, "tooltip", "Tooltip", [
    specimen(h, "tooltip/short", "short", [
      tooltipBubble(h, "look-tooltip-short", "Copy link"),
    ]),
    specimen(h, "tooltip/long", "long, wraps", [
      tooltipBubble(
        h,
        "look-tooltip-long",
        "Stops this subagent; its parent keeps working and is told the child stopped."
      ),
    ]),
  ]);

const fieldOf = (
  id: string,
  label: string,
  config: Partial<FieldConfig<Message>>
): FieldConfig<Message> => ({
  ...fieldDefaults<Message>(id, label),
  ...config,
});

const fields = (h: H, model: Model): Html => {
  const control = (value: string) => ({
    value,
    placeholder: Option.some("Type an answer"),
    onInput: Option.none<(value: string) => Message>(),
  });

  return section(
    h,
    "field",
    "Input and textarea",
    [
      specimen(h, "field/live", "live, with a hint", [
        inputField(
          h,
          fieldOf("look-field-live", "Answer", {
            hint: Option.some("Sent to the parent first."),
          }),
          {
            value: model.answer,
            placeholder: Option.some("Type an answer"),
            onInput: Option.some((value: string) =>
              Message.TypedAnswer({ value })
            ),
          }
        ),
      ]),
      specimen(h, "field/hover", "hover", [
        inputField(
          h,
          fieldOf("look-field-hover", "Budget", {
            shellAttributes: [HOVER(h)],
          }),
          control("$5.00")
        ),
      ]),
      specimen(h, "field/focus", "focus", [
        inputField(
          h,
          fieldOf("look-field-focus", "Budget", {
            shellAttributes: [FOCUS(h)],
          }),
          control("$5.00")
        ),
      ]),
      specimen(h, "field/invalid", "invalid, with its error", [
        inputField(
          h,
          fieldOf("look-field-invalid", "Budget", {
            error: Option.some("A budget is a dollar amount above zero."),
          }),
          control("five")
        ),
      ]),
      specimen(h, "field/disabled", "disabled", [
        inputField(
          h,
          fieldOf("look-field-disabled", "Budget", { isDisabled: true }),
          control("$5.00")
        ),
      ]),
      specimen(h, "field/parts", "glyph and trailing action", [
        inputField(
          h,
          fieldOf("look-field-parts", "Search", {
            leading: Option.some(glyph(h, Search, "search", "regular")),
            trailing: [
              iconButton(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost",
                  size: "small",
                  label: "Clear search",
                },
                glyph(h, X, "x", "small")
              ),
            ],
          }),
          control("porch")
        ),
      ]),
      specimen(h, "field/textarea", "textarea", [
        textareaField(
          h,
          fieldOf("look-textarea", "Send back with", {
            hint: Option.some("What the brief should change."),
          }),
          control(""),
          3
        ),
      ]),
      specimen(h, "field/textarea-invalid", "textarea, invalid", [
        textareaField(
          h,
          fieldOf("look-textarea-invalid", "Send back with", {
            error: Option.some("Say what should change."),
          }),
          control(""),
          3
        ),
      ]),
    ],
    true
  );
};

const banners = (h: H): Html =>
  section(
    h,
    "banner",
    "Banner",
    [
      ...TONES.map((tone: Tone) =>
        specimen(h, `banner/${tone}`, tone, [
          banner(h, {
            tone,
            mark: Option.none(),
            title: `A ${tone} banner.`,
            detail: Option.some("One more line of detail."),
            actions: [],
          }),
        ])
      ),
      specimen(h, "banner/actions", "with actions, long words", [
        banner(h, {
          tone: "waiting",
          mark: Option.none(),
          title: "Parked after five restarts.",
          detail: Option.some(
            "The run stopped at the same tool call each time; retry it or stop the thread."
          ),
          actions: [
            buttonOf(h, { size: "small", variant: "ghost" }, "Stop"),
            buttonOf(h, { size: "small" }, "Retry"),
          ],
        }),
      ]),
    ],
    true
  );

const dividers = (h: H): Html =>
  section(h, "divider", "Divider", [
    specimen(
      h,
      "divider/horizontal",
      "horizontal",
      [
        h.p([h.Class(classNames("text-ink-2", TYPE.ui))], ["Above"]),
        divider(h, "horizontal"),
        h.p([h.Class(classNames("text-ink-2", TYPE.ui))], ["Below"]),
      ],
      "flex flex-col gap-(--space-2)"
    ),
    specimen(h, "divider/vertical", "vertical", [
      h.span([h.Class(classNames("text-ink-2", TYPE.ui))], ["Left"]),
      divider(h, "vertical"),
      h.span([h.Class(classNames("text-ink-2", TYPE.ui))], ["Right"]),
    ]),
    specimen(
      h,
      "divider/labelled",
      "labelled",
      [labelledDivider(h, "Previous agents")],
      "flex flex-col"
    ),
  ]);

const TALLY: ReadonlyArray<TallyPart> = [
  { count: 4, word: "agents", tone: "neutral" },
  { count: 2, word: "working", tone: "working" },
  { count: 0, word: "failed", tone: "failed" },
  { count: 1, word: "done", tone: "done" },
];

const STEPS: ReadonlyArray<Step> = [
  { title: "Read the workflows note", state: "done", meta: Option.some("1m") },
  {
    title: "Port deriveWorkflowGroups",
    state: "done",
    meta: Option.some("6m"),
  },
  { title: "Port the panel's tests", state: "working", meta: Option.none() },
  { title: "Run the steps judge", state: "todo", meta: Option.none() },
  { title: "Draw the phone sheet", state: "todo", meta: Option.none() },
];

const FAILED_STEPS: ReadonlyArray<Step> = [
  ...STEPS.slice(0, 2),
  { title: "Port the panel's tests", state: "failed", meta: Option.some("2m") },
];

const tallies = (h: H): Html =>
  section(h, "tally", "Tally", [
    specimen(
      h,
      "tally/parts",
      "counts with their words, empty parts left out",
      [tally(h, TALLY)]
    ),
    specimen(h, "tally/total", "a total only, even at zero", [
      tally(h, [{ count: 0, word: "agents", tone: "neutral" }]),
      tally(h, [
        { count: 12, word: "tool calls", tone: "neutral" },
        { count: 3, word: "edits", tone: "neutral" },
        { count: 1, word: "approval", tone: "waiting" },
      ]),
    ]),
  ]);

const steppers = (h: H): Html =>
  section(h, "stepper", "Stepper", [
    specimen(
      h,
      "stepper/states",
      "every step state: to do, working, done, failed",
      [
        stepper(
          h,
          "Every step state",
          STEP_STATES.map((state) => ({
            title: `A step ${stepWord(state)}`,
            state,
            meta: Option.none(),
          }))
        ),
      ],
      "flex flex-col"
    ),
    specimen(
      h,
      "stepper/pill",
      "the steps pill: working, failed, done, to do, opening the sheet",
      [
        stepsPill(h, STEPS, Option.none()),
        stepsPill(h, FAILED_STEPS, Option.none()),
        stepsPill(
          h,
          STEPS.map((step) => ({ ...step, state: "done" as const })),
          Option.none()
        ),
        stepsPill(
          h,
          STEPS.map((step) => ({ ...step, state: "todo" as const })),
          Option.none()
        ),
        stepsPill(h, STEPS, Option.some(Message.OpenedSheet())),
      ]
    ),
  ]);

const disclosures = (h: H, model: Model): Html => {
  const live = (
    id: string,
    title: string,
    glyphOf: Option.Option<Html>,
    tallyOf: Option.Option<Html>,
    body: ReadonlyArray<Html>
  ) =>
    disclosure(
      h,
      {
        id,
        isOpen: model.openDisclosures.includes(id),
        onToggle: (isOpen) => Message.ToggledDisclosure({ id, isOpen }),
        isDisabled: false,
        attributes: [h.DataAttribute("look-live-disclosure", "")],
      },
      { glyph: glyphOf, title, tally: tallyOf, body }
    );

  const still = (
    title: string,
    config: {
      readonly isOpen: boolean;
      readonly isDisabled: boolean;
      readonly attributes: ReadonlyArray<Attribute<Message>>;
    }
  ) =>
    disclosure(
      h,
      {
        id: `look-disclosure-${title.toLowerCase()}`,
        onToggle: () => Message.ChoseTheme({ theme: model.theme }),
        ...config,
      },
      {
        glyph: Option.none(),
        title,
        tally: Option.some(tally(h, TALLY.slice(0, 2))),
        body: [cardText(h, "The body, below the header.")],
      }
    );

  return section(
    h,
    "disclosure",
    "Disclosure",
    [
      specimen(
        h,
        "disclosure/live",
        "fold, phase and previous agents, live: opening one moves nothing above it",
        [
          h.p(
            [h.Class(classNames("text-ink-2", TYPE.body))],
            ["Text above the folds stays where it is."]
          ),
          live(
            "look-disclosure-fold",
            "Worked for 4m 12s",
            Option.none(),
            Option.some(tally(h, TALLY)),
            [
              rowOf(h, {}, { title: "Read packages/client-logic" }),
              rowOf(h, {}, { title: "Edited Steps.ts" }),
            ]
          ),
          live(
            "look-disclosure-phase",
            "Build",
            Option.some(
              h.span(
                [h.Class(TONE_TEXT.working)],
                [statusGlyph(h, "busy", "regular")]
              )
            ),
            Option.some(stepsPill(h, STEPS, Option.none())),
            [stepper(h, "Build steps", STEPS)]
          ),
          live(
            "look-disclosure-previous",
            "Previous agents",
            Option.none(),
            Option.some(
              tally(h, [{ count: 3, word: "agents", tone: "neutral" }])
            ),
            [
              rowOf(
                h,
                {},
                {
                  leading: Option.some(avatar(h, "@scout", "small", "accent")),
                  title: "@scout read the reach note",
                }
              ),
            ]
          ),
        ],
        "flex flex-col gap-(--space-1)"
      ),
      specimen(
        h,
        "disclosure/states",
        "folded, open, hover, focus, disabled",
        [
          still("Folded", { isOpen: false, isDisabled: false, attributes: [] }),
          still("Open", { isOpen: true, isDisabled: false, attributes: [] }),
          still("Hover", {
            isOpen: false,
            isDisabled: false,
            attributes: [HOVER(h)],
          }),
          still("Focus", {
            isOpen: false,
            isDisabled: false,
            attributes: [FOCUS(h)],
          }),
          still("Disabled", {
            isOpen: false,
            isDisabled: true,
            attributes: [],
          }),
        ],
        "flex flex-col gap-(--space-1)"
      ),
    ],
    true
  );
};

const kbds = (h: H): Html =>
  section(h, "kbd", "Key hint", [
    specimen(h, "kbd/key", "one key", [kbd(h, "K"), kbd(h, "Enter")]),
    specimen(h, "kbd/shortcut", "shortcut (hidden on a phone)", [
      shortcut(h, ["Ctrl", "K"]),
      shortcut(h, ["Shift", "Ctrl", "P"]),
    ]),
  ]);

const meters = (h: H): Html =>
  section(h, "meter", "Progress and meter", [
    specimen(
      h,
      "meter/progress",
      "progress: none, some, all, unknown",
      [
        progress(h, "Nodes", Option.some(0)),
        progress(h, "Nodes", Option.some(0.42)),
        progress(h, "Nodes", Option.some(1)),
        progress(h, "Nodes", Option.none()),
      ],
      "flex flex-col gap-(--space-3)"
    ),
    specimen(
      h,
      "meter/reading",
      "meter: under, warning, at the limit, unknown",
      [
        meter(h, "Spend", {
          value: Option.some(1.2),
          max: 5,
          warnAt: 0.8,
          text: "$1.20 of $5.00",
        }),
        meter(h, "Spend", {
          value: Option.some(4.3),
          max: 5,
          warnAt: 0.8,
          text: "$4.30 of $5.00",
        }),
        meter(h, "Spend", {
          value: Option.some(5.6),
          max: 5,
          warnAt: 0.8,
          text: "$5.60 of $5.00",
        }),
        meter(h, "Plan window", {
          value: Option.none(),
          max: 100,
          warnAt: 0.8,
          text: "",
        }),
      ],
      "flex flex-col gap-(--space-3)"
    ),
  ]);

const empties = (h: H): Html =>
  section(h, "empty", "Empty state", [
    specimen(h, "empty/full", "glyph, body and action", [
      emptyState(h, {
        glyph: Option.some(glyph(h, Inbox, "inbox", "large")),
        title: "Nothing needs you",
        body: Option.some(
          "Questions, approvals and briefs from your threads land here."
        ),
        action: Option.some(buttonOf(h, { variant: "primary" }, "New thread")),
      }),
    ]),
    specimen(h, "empty/plain", "title only", [
      emptyState(h, {
        glyph: Option.none(),
        title: "No subagents yet",
        body: Option.none(),
        action: Option.none(),
      }),
    ]),
  ]);

// ---------------------------------------------------------------------------------------------
// The page

// The shell's specimens are whole regions (a sidebar, a header, an overlay), so each takes the
// section's full width rather than one cell of its grid.
const shell = (h: H): Html =>
  h.section(
    [
      h.DataAttribute("testid", "look-shell"),
      h.AriaLabel("Shell"),
      h.Class(
        "flex min-w-0 flex-col gap-(--space-4) rounded-(--radius-large) border border-stroke-1 bg-surface-sidebar p-(--space-4) lg:col-span-2"
      ),
    ],
    [
      h.h2(
        [h.Class(classNames("text-ink-1", TYPE.title, WEIGHT_STRONG))],
        ["Shell"]
      ),
      h.div(
        [h.Class("grid min-w-0 grid-cols-1 gap-(--space-4) xl:grid-cols-2")],
        shellSpecimens(h, {
          specimen: (state, caption, content) =>
            specimen(h, state, caption, content, "flex min-w-0"),
          ignore: Message.IgnoredSpecimen(),
        })
      ),
    ]
  );

const THEMES: ReadonlyArray<Theme> = Theme.literals;

const switches = (h: H, model: Model): Html =>
  h.header(
    [
      h.Class(
        "sticky top-0 z-(--layer-sticky) flex flex-wrap items-center gap-(--space-3) border-b border-stroke-1 bg-surface-rail px-(--space-4) py-(--space-2)"
      ),
    ],
    [
      h.h1(
        [h.Class(classNames("me-auto text-ink-1", TYPE.title, WEIGHT_STRONG))],
        ["Look catalogue"]
      ),
      h.div(
        [
          h.Role("group"),
          h.AriaLabel("Theme"),
          h.Class("flex flex-wrap gap-(--space-1)"),
        ],
        THEMES.map((theme) =>
          buttonOf(
            h,
            {
              variant: "ghost",
              size: "small",
              isPressed: Option.some(model.theme === theme),
              onClick: Option.some(Message.ChoseTheme({ theme })),
              attributes: [h.DataAttribute("testid", `look-theme-${theme}`)],
            },
            theme
          )
        )
      ),
    ]
  );

/** The catalogue: the theme switch, then every primitive's section, in the chosen theme. */
export const view = (model: Model, h: H): Html =>
  h.div(
    [
      h.DataAttribute("look-catalogue", ""),
      h.Class(model.theme === "dark" ? "dark" : ""),
    ],
    [
      h.div(
        [
          h.DataAttribute("ui", "next"),
          h.DataAttribute("theme", model.theme),
          h.Class(
            "min-h-dvh bg-surface-ground font-(family-name:--font-ui) text-ink-1"
          ),
        ],
        [
          switches(h, model),
          h.main(
            [
              h.Class(
                "mx-auto grid w-full max-w-[96rem] min-w-0 grid-cols-1 gap-(--space-4) p-(--space-4) lg:grid-cols-2"
              ),
            ],
            [
              buttons(h),
              iconButtons(h),
              chips(h, model),
              statusChips(h),
              glyphs(h),
              avatars(h),
              rows(h),
              menus(h),
              cards(h),
              sheets(h, model),
              disclosures(h, model),
              tallies(h),
              steppers(h),
              tooltips(h),
              fields(h, model),
              banners(h),
              dividers(h),
              kbds(h),
              meters(h),
              empties(h),
              shell(h),
            ]
          ),
        ]
      ),
    ]
  );
