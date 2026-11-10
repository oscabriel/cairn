// The basic management actions (U-10): the selected project's menu beside its name at the head of
// the sidebar list, and the open thread's menu in the chat header, each a `menuPanel` (`../ui/Menu.ts`)
// drawn open under its button while the shell says so, closed by a click outside or Escape. Rename
// project and Rename thread open a dialog with the name to edit; Remove project opens a confirm
// that says what happens to its threads. The commands are `ProjectUpdate`, `ProjectDelete` and
// `ThreadRename`; nothing here deletes a thread.

import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Ellipsis, Pencil, Trash2 } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { banner } from "../ui/Banner.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_WITHIN_RING,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { glyph } from "../ui/Glyph.ts";
import { iconButtonWithTooltip } from "../ui/IconButton.ts";
import { menuPanel } from "../ui/Menu.ts";
import type { PanelItem } from "../ui/Menu.ts";
import { Message } from "./Message.ts";
import { ManageAction } from "./Model.ts";
import type { ManageState, MenuTarget } from "./Model.ts";
import type { Placement } from "./Scratch.ts";
import { positionOf } from "./Scratch.ts";

/** The id of the dialog's name field, which takes focus when it opens (`-cancel` for a remove). */
export const MANAGE_TEXT_ID = "manage-text";

const TITLE_ID = "manage-title";

/** A menu's button and, while it is open, its items under it. */
export const menuAnchor = (
  h: HtmlBuilder<Message>,
  config: {
    readonly target: MenuTarget;
    readonly label: string;
    readonly testId: string;
    readonly isOpen: boolean;
    readonly items: ReadonlyArray<PanelItem<Message>>;
  }
): Html =>
  h.div(
    [h.Class("relative shrink-0")],
    [
      iconButtonWithTooltip(
        h,
        {
          ...buttonDefaults<Message>(),
          variant: "ghost",
          label: config.label,
          onClick: Option.some(Message.ClickedMenu({ target: config.target })),
          attributes: [
            h.DataAttribute("testid", config.testId),
            h.AriaHasPopup("menu"),
            h.AriaExpanded(config.isOpen),
          ],
        },
        glyph(h, Ellipsis, "ellipsis", "regular"),
        "end"
      ),
      config.isOpen
        ? h.div(
            [h.Class("contents")],
            [
              h.div([
                h.AriaHidden(true),
                h.OnClick(Message.ClickedCloseMenu()),
                h.Class("fixed inset-0 z-(--layer-popover)"),
              ]),
              h.div(
                [
                  h.Class(
                    "absolute end-0 top-full z-(--layer-popover) mt-(--space-1)"
                  ),
                ],
                [
                  menuPanel(
                    h,
                    config.label,
                    [{ heading: Option.none(), items: config.items }],
                    [h.DataAttribute("testid", `${config.testId}-items`)]
                  ),
                ]
              ),
            ]
          )
        : h.empty,
    ]
  );

/** One menu item that opens `action`'s dialog. */
export const manageItem = (
  h: HtmlBuilder<Message>,
  label: string,
  action: ManageAction
): PanelItem<Message> => {
  const isRemove = Predicate.isTagged(action, "RemoveProject");

  return {
    look: {
      glyph: Option.some(
        isRemove
          ? glyph(h, Trash2, "trash-2", "small")
          : glyph(h, Pencil, "pencil", "small")
      ),
      label,
      hint: Option.none(),
      isDestructive: isRemove,
    },
    isActive: false,
    isDisabled: false,
    onClick: Option.some(Message.ClickedManage({ action })),
  };
};

/** What the dialog says about its target: the project's or the thread's name and root. */
export interface ManageNames {
  /** The project's or the thread's name. */
  readonly name: string;
  /** The project's folder, for a remove. */
  readonly folder: string;
}

const titleOf = (action: ManageAction, names: ManageNames): string =>
  ManageAction.match(action, {
    RenameProject: () => "Rename project",
    RemoveProject: () => `Remove ${names.name}?`,
    RenameThread: () => "Rename thread",
  });

const nameField = (h: HtmlBuilder<Message>, manage: ManageState): Html =>
  h.div(
    [h.Class("flex flex-col gap-(--space-1-5)")],
    [
      h.label(
        [h.For(MANAGE_TEXT_ID), h.Class(classNames(TYPE.ui, WEIGHT_MEDIUM))],
        ["Name"]
      ),
      h.div(
        [
          h.DataAttribute("slot", "field-shell"),
          h.Class(
            classNames(
              "flex rounded-(--radius-small) border border-stroke-2 bg-surface-sunken px-(--space-2)",
              FOCUS_WITHIN_RING,
              FEEDBACK_MOTION
            )
          ),
        ],
        [
          h.input([
            h.Id(MANAGE_TEXT_ID),
            h.Type("text"),
            h.DataAttribute("testid", "manage-text"),
            h.Value(manage.text),
            h.OnInput((value) => Message.ChangedManageText({ value })),
            h.OnKeyDownPreventDefault((key) =>
              key === "Enter"
                ? Option.some(Message.ClickedConfirmManage())
                : Option.none()
            ),
            h.Class(
              classNames(
                "min-h-10 min-w-0 flex-1 bg-transparent text-ink-1 outline-none placeholder:text-ink-3",
                TYPE.ui
              )
            ),
          ]),
        ]
      ),
    ]
  );

const removeWords = (names: ManageNames): string =>
  `Its project thread, its earlier project threads and the threads they manage leave Cairn, and any of them still working stops. The folder ${names.folder} and everything in it stays on the Beelink, and you can add it again as a project.`;

/** The rename or remove dialog and its scrim, while one is open; nothing otherwise. */
export const manageDialog = (
  h: HtmlBuilder<Message>,
  manage: Option.Option<ManageState>,
  names: ManageNames,
  placement: Placement
): Html =>
  Option.match(manage, {
    onNone: () => h.empty,
    onSome: (open) => {
      const position = positionOf(placement);
      const isRemove = Predicate.isTagged(open.action, "RemoveProject");

      return h.div(
        [h.DataAttribute("slot", "manage"), h.Class("contents")],
        [
          h.div([
            h.AriaHidden(true),
            h.OnClick(Message.ClickedCancelManage()),
            h.Class(classNames(position, "inset-0 z-(--layer-scrim) bg-scrim")),
          ]),
          h.section(
            [
              h.DataAttribute("testid", "manage-dialog"),
              h.Role(isRemove ? "alertdialog" : "dialog"),
              h.AriaModal(true),
              h.AriaLabelledBy(TITLE_ID),
              h.Class(
                classNames(
                  position,
                  "inset-x-(--space-3) top-24 z-(--layer-sheet) mx-auto flex max-w-lg flex-col gap-(--space-3) rounded-(--radius-large) border border-stroke-2 bg-surface-overlay p-(--space-4) text-ink-1 shadow-(--elevation-3)"
                )
              ),
            ],
            [
              h.h2(
                [
                  h.Id(TITLE_ID),
                  h.Class(classNames(TYPE.title, WEIGHT_STRONG)),
                ],
                [titleOf(open.action, names)]
              ),
              isRemove
                ? h.p(
                    [
                      h.DataAttribute("testid", "manage-remove-words"),
                      h.Class(classNames("text-ink-2", TYPE.ui)),
                    ],
                    [removeWords(names)]
                  )
                : nameField(h, open),
              Option.match(open.failure, {
                onNone: () => h.empty,
                onSome: (text) =>
                  banner(
                    h,
                    {
                      tone: "failed",
                      mark: Option.none(),
                      title: isRemove ? "Not removed." : "Not renamed.",
                      detail: Option.some(text),
                      actions: [],
                    },
                    [h.DataAttribute("testid", "manage-failure")]
                  ),
              }),
              h.div(
                [
                  h.Class(
                    "flex flex-wrap items-center justify-end gap-(--space-2)"
                  ),
                ],
                [
                  button(
                    h,
                    {
                      ...buttonDefaults<Message>(),
                      variant: "ghost",
                      onClick: Option.some(Message.ClickedCancelManage()),
                      attributes: [
                        h.Id(`${MANAGE_TEXT_ID}-cancel`),
                        h.DataAttribute("testid", "manage-cancel"),
                      ],
                    },
                    ["Cancel"]
                  ),
                  button(
                    h,
                    {
                      ...buttonDefaults<Message>(),
                      variant: isRemove ? "danger" : "primary",
                      onClick: Option.some(Message.ClickedConfirmManage()),
                      isDisabled: !isRemove && open.text.trim() === "",
                      isBusy: open.isSending,
                      attributes: [h.DataAttribute("testid", "manage-confirm")],
                    },
                    [isRemove ? "Remove project" : "Save"]
                  ),
                ]
              ),
            ]
          ),
        ]
      );
    },
  });
