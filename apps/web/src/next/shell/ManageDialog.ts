// The rename and remove dialog of the basic management actions (U-10; the menus are `Manage.ts`):
// Rename project and Rename thread edit the name; Remove project confirms, saying what happens to
// the project's threads. Its own chunk (`next/page/Chunks.ts`): a cold load never draws it.

import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

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
import { Message } from "./Message.ts";
import { MANAGE_TEXT_ID, ManageAction } from "./Model.ts";
import type { ManageState } from "./Model.ts";
import type { Placement } from "./Scratch.ts";
import { positionOf } from "./Scratch.ts";

const TITLE_ID = "manage-title";

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
