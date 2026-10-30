// The scratch thread's overlay (the user, 2026-10-29): a floating thread with no project, for a
// one-off question, over a scrim on the overlay surface (the lightest layer). Cmd+J or Ctrl+J shows
// and hides it without losing it, and on the phone the header's button opens it. Its first message
// launches the scratch thread in a throwaway folder; Clear deletes the thread and its folder.
//
// The panel is drawn by its caller around three parts: the head and the foot here (the shell's
// Messages) and the transcript between them, which is the thread page's own and keeps its own
// Messages and Mounts. So the panel itself (`scratchPanel`) takes any Message type.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ArrowUp, MessageSquareDashed, Trash2, X } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { banner } from "../ui/Banner.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_WITHIN_RING,
  TYPE,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { glyph } from "../ui/Glyph.ts";
import { iconButton } from "../ui/IconButton.ts";
import { shortcut } from "../ui/Kbd.ts";
import { Message } from "./Message.ts";
import type { ScratchState } from "./Model.ts";

/** Where an overlay sits: over the whole page, or inside a positioned box (the catalogue). */
export type Placement = "viewport" | "contained";

/** The CSS position of an overlay at `placement`. */
export const positionOf = (placement: Placement): string =>
  placement === "viewport" ? "fixed" : "absolute";

/** The id of the overlay's field, which takes focus when it opens. */
export const SCRATCH_EDITOR_ID = "scratch-editor";

const PANEL = classNames(
  "z-(--layer-sheet) flex flex-col overflow-hidden rounded-(--radius-large) border border-stroke-2 bg-surface-overlay text-ink-1 shadow-(--elevation-3)",
  "inset-x-(--space-2) top-16 bottom-(--space-2)",
  "md:inset-x-auto md:bottom-auto md:left-1/2 md:top-18 md:h-[min(35rem,calc(100%-6rem))] md:w-[min(45rem,calc(100%-4rem))] md:-translate-x-1/2"
);

/** The scrim behind the overlay; a tap on it hides the overlay. */
export const scratchScrim = (
  h: HtmlBuilder<Message>,
  placement: Placement
): Html =>
  h.div([
    h.AriaHidden(true),
    h.OnClick(Message.ClickedCloseScratch()),
    h.Class(
      classNames(positionOf(placement), "inset-0 z-(--layer-scrim) bg-scrim")
    ),
  ]);

/** The overlay's panel around its head, body and foot. */
export const scratchPanel = <M>(
  h: HtmlBuilder<M>,
  placement: Placement,
  parts: ReadonlyArray<Html>
): Html =>
  h.section(
    [
      h.DataAttribute("testid", "scratch-overlay"),
      h.Role("dialog"),
      h.AriaLabel("Scratch thread"),
      h.Class(classNames(positionOf(placement), PANEL)),
    ],
    parts
  );

/** The panel's body: the transcript when the scratch thread exists, else what the overlay is. */
export const scratchBody = <M>(
  h: HtmlBuilder<M>,
  transcript: Option.Option<Html>
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "scratch-body"),
      h.Class("flex min-h-0 flex-1 flex-col"),
    ],
    [
      Option.match(transcript, {
        onSome: (each) => each,
        onNone: () =>
          h.div(
            [
              h.DataAttribute("testid", "scratch-empty"),
              h.Class(
                classNames(
                  "flex flex-1 flex-col items-center justify-center gap-(--space-2) px-(--space-6) text-center text-ink-2",
                  TYPE.ui
                )
              ),
            ],
            [
              h.span(
                [h.Class("text-ink-3")],
                [
                  glyph(
                    h,
                    MessageSquareDashed,
                    "message-square-dashed",
                    "large"
                  ),
                ]
              ),
              h.p(
                [h.Class("max-w-md")],
                [
                  "A thread with no project, for a one-off question. It runs in a throwaway folder, and Clear deletes it.",
                ]
              ),
            ]
          ),
      }),
    ]
  );

/** The panel's head: its name, what it is, the shortcut's hint, Clear and Hide. */
export const scratchHead = (
  h: HtmlBuilder<Message>,
  scratch: ScratchState,
  keys: ReadonlyArray<string>
): Html => {
  const hasThread = Option.isSome(scratch.threadId);

  return h.header(
    [
      h.Class(
        "flex h-12 shrink-0 items-center gap-(--space-2) border-b border-stroke-1 ps-(--space-4) pe-(--space-2) text-ink-2 max-md:ps-(--space-3) max-md:pe-(--space-1) pointer-coarse:h-14"
      ),
    ],
    [
      glyph(h, MessageSquareDashed, "message-square-dashed", "regular"),
      h.h2(
        [h.Class(classNames("text-ink-1", TYPE.body, WEIGHT_STRONG))],
        ["Scratch"]
      ),
      // Takes the room left, and gives it up first when there is none.
      h.span(
        [h.Class(classNames("min-w-0 flex-1 truncate text-ink-3", TYPE.small))],
        [
          h.span(
            [h.Class("max-md:hidden")],
            ["no project · cleared when you clear it"]
          ),
        ]
      ),
      h.span(
        [
          h.Class(
            classNames(
              "inline-flex items-center gap-(--space-1) whitespace-nowrap text-ink-3 pointer-coarse:hidden max-md:hidden",
              TYPE.small
            )
          ),
        ],
        [shortcut(h, keys), "to hide"]
      ),
      button(
        h,
        {
          ...buttonDefaults<Message>(),
          variant: "ghost",
          size: "small",
          onClick: Option.some(Message.ClickedClearScratch()),
          isDisabled: !hasThread && scratch.draft === "",
          isBusy: scratch.isBusy && hasThread,
          ariaLabel: Option.some(
            "Clear: delete the scratch thread and its folder"
          ),
          attributes: [h.DataAttribute("testid", "scratch-clear")],
        },
        [glyph(h, Trash2, "trash-2", "small"), "Clear"]
      ),
      iconButton(
        h,
        {
          ...buttonDefaults<Message>(),
          variant: "ghost",
          label: "Hide the scratch thread",
          onClick: Option.some(Message.ClickedCloseScratch()),
          attributes: [h.DataAttribute("testid", "scratch-close")],
        },
        glyph(h, X, "x", "regular")
      ),
    ]
  );
};

/** The panel's foot: why the last turn was not sent, then the field and Send. */
export const scratchFoot = (
  h: HtmlBuilder<Message>,
  scratch: ScratchState,
  failure: Option.Option<string>
): Html =>
  h.div(
    [
      h.Class(
        "flex shrink-0 flex-col gap-(--space-2) px-(--space-3) pb-(--space-3) max-md:px-(--space-2) max-md:pb-(--space-2)"
      ),
    ],
    [
      Option.match(failure, {
        onNone: () => h.empty,
        onSome: (text) =>
          banner(h, {
            tone: "failed",
            mark: Option.none(),
            title: "Not sent.",
            detail: Option.some(text),
            actions: [],
          }),
      }),
      h.form(
        [
          h.DataAttribute("slot", "field-shell"),
          h.OnSubmit(Message.ClickedSendScratch()),
          h.Class(
            classNames(
              "flex items-end gap-(--space-2) rounded-(--radius-large) border border-stroke-2 bg-surface-raised p-(--space-2) ps-(--space-3)",
              FOCUS_WITHIN_RING,
              FEEDBACK_MOTION
            )
          ),
        ],
        [
          h.textarea([
            h.Id(SCRATCH_EDITOR_ID),
            h.DataAttribute("testid", "scratch-editor"),
            h.AriaLabel("Message the scratch thread"),
            h.Placeholder("Ask something quick"),
            h.Rows(1),
            h.Value(scratch.draft),
            h.OnInput((value) => Message.ChangedScratchDraft({ value })),
            h.OnKeyDownPreventDefault((key, modifiers) =>
              key === "Enter" &&
              !modifiers.shiftKey &&
              !modifiers.altKey &&
              !modifiers.ctrlKey &&
              !modifiers.metaKey
                ? Option.some(Message.PressedScratchEnter())
                : Option.none()
            ),
            h.Class(
              classNames(
                "max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-(--space-1-5) text-ink-1 outline-none placeholder:text-ink-3 [field-sizing:content] pointer-coarse:min-h-(--hit-target)",
                TYPE.body
              )
            ),
          ]),
          iconButton(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "primary",
              label: "Send to the scratch thread",
              onClick: Option.some(Message.ClickedSendScratch()),
              isDisabled: scratch.draft.trim() === "",
              isBusy: scratch.isBusy,
              attributes: [h.DataAttribute("testid", "scratch-send")],
            },
            glyph(h, ArrowUp, "arrow-up", "regular")
          ),
        ]
      ),
    ]
  );
