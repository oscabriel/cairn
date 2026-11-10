// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ChatHeader.tsx (the right
// panel toggle in the titlebar's panel layout controls) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: the toggle's tooltip-trigger wrapper, its `data-slot="toggle"`, `aria-pressed` and the
// panel-right icon. Changed: it toggles Cairn's diff panel, the only right panel Cairn has, from
// the newest checkpoint turn (`Toggle.ts`), and is disabled until the thread has one.
//
// The chat header's diff toggle (plan look track L7) as a ghost icon button beside L6's Refresh and
// scratch buttons, so it is `--hit-target` square on a coarse pointer and shows the focus ring on
// keyboard focus only. It is pressed while the panel is open; with no checkpoint yet it says so and
// takes no click. The classic toggle it replaced was deleted with its titlebar class (W-6).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { Entry } from "@cairn/protocol/Thread";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { PanelRight } from "lucide";

import { buttonDefaults } from "../ui/Button.ts";
import { glyph } from "../ui/Glyph.ts";
import { iconButton } from "../ui/IconButton.ts";
import { Message } from "./Message.ts";
import { isOpen } from "./Model.ts";
import type { Model } from "./Model.ts";
import { latestCheckpointTurn } from "./Toggle.ts";
import type { ToggleViewInputs } from "./Toggle.ts";

/** Each entry list's newest checkpoint turn: lists are immutable, so a seen one is reused. */
const latestByList = new WeakMap<ReadonlyArray<Entry>, Option.Option<number>>();

const latestOfList = (entries: ReadonlyArray<Entry>): Option.Option<number> => {
  const seen = latestByList.get(entries);

  if (seen !== undefined) {
    return seen;
  }

  const latest = latestCheckpointTurn(entries);

  latestByList.set(entries, latest);

  return latest;
};

/**
 * The newest checkpoint turn across a thread view's entries and the older ones paged in, without
 * walking a list already read: every streamed delta draws the header again.
 */
const latestAcross = (
  older: ReadonlyArray<Entry>,
  entries: ReadonlyArray<Entry>
): Option.Option<number> =>
  Option.match(latestOfList(entries), {
    onNone: () => latestOfList(older),
    onSome: (turn) =>
      Option.some(
        Math.max(
          turn,
          Option.getOrElse(latestOfList(older), () => turn)
        )
      ),
  });

/** The diff toggle for the chat header. */
export const diffToggle = (
  h: HtmlBuilder<Message>,
  open: boolean,
  onToggle: Option.Option<Message>
): Html =>
  h.span(
    [h.DataAttribute("slot", "tooltip-trigger"), h.Class("flex shrink-0")],
    [
      iconButton(
        h,
        {
          ...buttonDefaults<Message>(),
          variant: "ghost",
          label: "Toggle diff panel",
          onClick: onToggle,
          isDisabled: Option.isNone(onToggle),
          isPressed: Option.some(open),
          attributes: [
            h.DataAttribute("slot", "toggle"),
            h.DataAttribute("right-panel-toggle", "true"),
            h.DataAttribute("testid", "diff-toggle"),
            h.Title(
              Option.isSome(onToggle)
                ? "Toggle diff panel"
                : "No changes to show yet"
            ),
          ],
        },
        glyph(h, PanelRight, "panel-right", "regular")
      ),
    ]
  );

/**
 * The toggle as the diff panel's own view, so the panel builds its `ClickedToggle`: it opens the
 * thread's whole diff up to the newest checkpoint turn.
 */
export const toggleView = Submodel.defineView<Model, Message, ToggleViewInputs>(
  (model, { threadId, older, entries }, h) =>
    diffToggle(
      h,
      isOpen(model),
      Option.zipWith(
        threadId,
        latestAcross(older, entries),
        (pageThreadId, latestTurn) =>
          Message.ClickedToggle({ threadId: pageThreadId, latestTurn })
      )
    )
);
