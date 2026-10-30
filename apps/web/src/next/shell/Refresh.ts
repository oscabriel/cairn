// The refresh confirm: a refresh replaces the project thread with a new one and archives this one
// (5H), stopping its run, its queue and its working subagents, so it asks first. The new thread
// starts with the message typed here; Refresh waits until there is one.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_WITHIN_RING,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { Message } from "./Message.ts";
import type { RefreshConfirm } from "./Model.ts";
import type { Placement } from "./Scratch.ts";
import { positionOf } from "./Scratch.ts";

/** The id of the confirm's field, which takes focus when it opens. */
export const REFRESH_TEXT_ID = "refresh-text";

const TITLE_ID = "refresh-title";

/** The confirm and its scrim, when a refresh is being asked; nothing otherwise. */
export const refreshConfirm = (
  h: HtmlBuilder<Message>,
  refresh: Option.Option<RefreshConfirm>,
  projectTitle: string,
  placement: Placement
): Html =>
  Option.match(refresh, {
    onNone: () => h.empty,
    onSome: (confirm) => {
      const position = positionOf(placement);

      return h.div(
        [h.DataAttribute("slot", "refresh"), h.Class("contents")],
        [
          h.div([
            h.AriaHidden(true),
            h.OnClick(Message.ClickedCancelRefresh()),
            h.Class(classNames(position, "inset-0 z-(--layer-scrim) bg-scrim")),
          ]),
          h.section(
            [
              h.DataAttribute("testid", "refresh-confirm"),
              h.Role("alertdialog"),
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
                [`Refresh ${projectTitle}'s project thread?`]
              ),
              h.p(
                [h.Class(classNames("text-ink-2", TYPE.ui))],
                [
                  "A new project thread starts with the message below. This one is archived, and its run and working subagents stop; you can still open it from the archive.",
                ]
              ),
              h.label(
                [
                  h.For(REFRESH_TEXT_ID),
                  h.Class(classNames(TYPE.ui, WEIGHT_MEDIUM)),
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
                      onClick: Option.some(Message.ClickedCancelRefresh()),
                      attributes: [
                        h.DataAttribute("testid", "refresh-confirm-cancel"),
                      ],
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
                      attributes: [
                        h.DataAttribute("testid", "refresh-confirm-go"),
                      ],
                    },
                    ["Refresh"]
                  ),
                ]
              ),
            ]
          ),
        ]
      );
    },
  });
