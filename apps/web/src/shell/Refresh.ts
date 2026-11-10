// The refresh confirm: a refresh replaces the project thread with a new one and archives this one
// (5H), stopping its run, its queue and its working subagents, so it asks first. The new thread
// starts with the message typed here; Refresh waits until there is one. A Refresh that could not go
// (the project thread left the shell meanwhile) says why here and keeps the message. It is the
// sheet in its dialog shape, an alert dialog whose field takes focus when it opens.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { banner } from "../ui/Banner.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_WITHIN_RING,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { placedSheet, sheetDefaults } from "../ui/Sheet.ts";
import type { SheetPlacement } from "../ui/Sheet.ts";
import { Message } from "./Message.ts";
import { REFRESH_TEXT_ID } from "./Model.ts";
import type { RefreshConfirm } from "./Model.ts";

/** The confirm's id; its dialog's and its title's ids derive from it. */
const REFRESH_ID = "refresh-confirm";

const body = (h: HtmlBuilder<Message>, confirm: RefreshConfirm): Html =>
  h.div(
    [h.Class("flex flex-col gap-(--space-3)")],
    [
      h.p(
        [h.Class(classNames("text-ink-2", TYPE.ui))],
        [
          "A new project thread starts with the message below. This one is archived, and its run and working subagents stop; you can still open it under Previous in the sidebar.",
        ]
      ),
      h.label(
        [
          h.For(REFRESH_TEXT_ID),
          h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_MEDIUM)),
        ],
        ["First message"]
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
          h.textarea([
            h.Id(REFRESH_TEXT_ID),
            h.DataAttribute("testid", "refresh-text"),
            h.Rows(3),
            h.Placeholder("What the new project thread starts on"),
            h.Value(confirm.text),
            h.OnInput((value) => Message.ChangedRefreshText({ value })),
            h.Class(
              classNames(
                "min-h-20 min-w-0 flex-1 resize-none bg-transparent py-(--space-2) text-ink-1 outline-none placeholder:text-ink-3",
                TYPE.ui
              )
            ),
          ]),
        ]
      ),
      Option.match(confirm.failure, {
        onNone: () => h.empty,
        onSome: (text) =>
          banner(
            h,
            {
              tone: "failed",
              mark: Option.none(),
              title: "Not refreshed.",
              detail: Option.some(text),
              actions: [],
            },
            [h.DataAttribute("testid", "refresh-failure")]
          ),
      }),
    ]
  );

const actions = (
  h: HtmlBuilder<Message>,
  confirm: RefreshConfirm
): ReadonlyArray<Html> => [
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "ghost",
      onClick: Option.some(Message.ClickedCancelRefresh()),
      attributes: [h.DataAttribute("testid", "refresh-confirm-cancel")],
    },
    ["Cancel"]
  ),
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "primary",
      onClick: Option.some(Message.ClickedConfirmRefresh()),
      isDisabled: confirm.text.trim() === "",
      isBusy: confirm.isSending,
      attributes: [h.DataAttribute("testid", "refresh-confirm-go")],
    },
    ["Refresh"]
  ),
];

/** The confirm, when a refresh is being asked; nothing otherwise. */
export const refreshConfirm = (
  h: HtmlBuilder<Message>,
  refresh: Option.Option<RefreshConfirm>,
  projectTitle: string,
  placement: SheetPlacement
): Html =>
  Option.match(refresh, {
    onNone: () => h.empty,
    onSome: (confirm) =>
      placedSheet(
        h,
        placement,
        {
          ...sheetDefaults<Message>(
            REFRESH_ID,
            `Refresh ${projectTitle}'s project thread?`
          ),
          kind: "dialog",
          role: "alertdialog",
          focusSelector: Option.some(`#${REFRESH_TEXT_ID}`),
          onClose: Message.ClickedCancelRefresh(),
          onSettled: Message.SettledOverlay(),
          attributes: [h.DataAttribute("testid", "refresh-confirm")],
        },
        [body(h, confirm)],
        actions(h, confirm)
      ),
  });
