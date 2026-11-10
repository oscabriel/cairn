// The scratch thread's overlay (the user, 2026-10-29): a floating thread with no project, for a
// one-off question, on the `next` sheet in its thread shape (`next/ui/Sheet.ts`): a dialog that
// takes the keyboard, a tall bottom sheet on the phone and a wide card from `md`. Cmd+J or Ctrl+J
// shows and hides it without losing it, and on the phone the header's button opens it. Its first
// message launches the scratch thread in a throwaway folder; Clear deletes the thread and its folder.
//
// The sheet is drawn by its caller around three parts: the head's extras here (the shell's
// Messages), the transcript, which is the thread page's own and keeps its own Messages and Mounts,
// and at its foot the real composer (U-16), which serves the scratch thread while the overlay is
// shown, with its model pill, mode, attachments, queue or steer and Stop. So the body here
// (`scratchBody`) takes any Message type.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { MessageSquareDashed, Trash2 } from "lucide";

import { EDITOR_TEST_ID } from "../../composer/Editor.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import { TYPE } from "../ui/Classes.ts";
import { glyph } from "../ui/Glyph.ts";
import { shortcut } from "../ui/Kbd.ts";
import { sheetDefaults } from "../ui/Sheet.ts";
import type { SheetConfig } from "../ui/Sheet.ts";
import { Message } from "./Message.ts";
import type { ScratchState } from "./Model.ts";

/** The overlay's id; its dialog's and its title's ids derive from it. */
const SCRATCH_ID = "scratch-overlay";

/** What takes focus when the overlay opens: its composer's editor. */
export const SCRATCH_FOCUS = `[data-testid="${EDITOR_TEST_ID}"]`;

/** The overlay's sheet, before its caller says what closes it. */
export const scratchSheet = <M>(
  h: HtmlBuilder<M>,
  headerExtras: ReadonlyArray<Html>
): SheetConfig<M> => ({
  ...sheetDefaults<M>(SCRATCH_ID, "Scratch"),
  kind: "thread",
  layout: "fill",
  headerExtras,
  closeLabel: "Hide the scratch thread",
  attributes: [h.DataAttribute("testid", "scratch-overlay")],
  scrimAttributes: [h.DataAttribute("testid", "scratch-scrim")],
  closeAttributes: [h.DataAttribute("testid", "scratch-close")],
});

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

/** The head's extras beside the title: what the overlay is, the shortcut's hint, and Clear. */
export const scratchHeadExtras = (
  h: HtmlBuilder<Message>,
  scratch: ScratchState,
  keys: ReadonlyArray<string>
): Html =>
  h.div(
    [h.Class("flex min-w-0 shrink items-center gap-(--space-2) text-ink-3")],
    [
      // Gives up its room first when there is none.
      h.span(
        [h.Class(classNames("min-w-0 truncate max-md:hidden", TYPE.small))],
        ["no project · cleared when you clear it"]
      ),
      h.span(
        [
          h.Class(
            classNames(
              "inline-flex items-center gap-(--space-1) whitespace-nowrap pointer-coarse:hidden max-md:hidden",
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
          isDisabled: Option.isNone(scratch.threadId),
          isBusy: scratch.isBusy,
          ariaLabel: Option.some(
            "Clear: delete the scratch thread and its folder"
          ),
          attributes: [h.DataAttribute("testid", "scratch-clear")],
        },
        [glyph(h, Trash2, "trash-2", "small"), "Clear"]
      ),
    ]
  );
