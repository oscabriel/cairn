// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ChatHeader.tsx (the right
// panel toggle in the titlebar's panel layout controls) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: the toggle's tooltip-trigger wrapper, its `data-slot="toggle"`, `aria-pressed` and the
// panel-right icon in the titlebar button. Changed: a Foldkit view generic over its parent's
// Message; it toggles Cairn's diff panel, which is the only right panel Cairn has, and is disabled
// until the thread has a checkpoint to show.
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

import { checkpointSummaryOf } from "@cairn/client-logic/DiffTree";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { Entry } from "@cairn/protocol/Thread";
import { Array, Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { PanelRight } from "lucide";

import { icon } from "../composer/Icon.ts";
import { TITLEBAR_BUTTON_CLASS } from "../ui/ChatHeader.ts";
import { Message } from "./Message.ts";
import { isOpen } from "./Model.ts";
import type { Model } from "./Model.ts";

/**
 * The newest turn a `cairn.checkpoint` entry recorded among `entries` (a thread view's entries and
 * the older ones paged in): what the toggle opens. None while the thread has no checkpoint.
 */
export const latestCheckpointTurn = (
  entries: ReadonlyArray<Entry>
): Option.Option<number> =>
  Array.reduce(entries, Option.none<number>(), (latest, entry) =>
    entry.kind === "cairn.checkpoint"
      ? Option.match(checkpointSummaryOf(entry.data), {
          onNone: () => latest,
          onSome: ({ turn }) =>
            Option.some(
              Math.max(
                turn,
                Option.getOrElse(latest, () => turn)
              )
            ),
        })
      : latest
  );

/** Each entry list's newest checkpoint turn, by list: lists are immutable, so a seen one is reused. */
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
 * walking a list the header already read: every streamed delta re-renders the header.
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

/** What the header's diff toggle shows and sends. */
export interface DiffToggleInput<Message> {
  /** True while the diff panel is open. */
  readonly open: boolean;
  /** The Message a click sends; none while the thread has nothing to show. */
  readonly onToggle: Option.Option<Message>;
}

/** The diff panel toggle for a thread page's titlebar controls (`chatHeader`'s `controls`). */
export const diffToggle = <Message>(
  h: HtmlBuilder<Message>,
  input: DiffToggleInput<Message>
): Html =>
  h.span(
    [h.DataAttribute("slot", "tooltip-trigger"), h.Class("flex shrink-0")],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("slot", "toggle"),
          h.DataAttribute("right-panel-toggle", "true"),
          h.DataAttribute("testid", "diff-toggle"),
          h.AriaLabel("Toggle diff panel"),
          h.AriaPressed(input.open ? "true" : "false"),
          h.Title(
            Option.isSome(input.onToggle)
              ? "Toggle diff panel"
              : "No changes to show yet"
          ),
          h.Disabled(Option.isNone(input.onToggle)),
          ...(input.open ? [h.DataAttribute("pressed", "")] : []),
          ...Option.match(input.onToggle, {
            onNone: () => [],
            onSome: (message) => [h.OnClick(message)],
          }),
          h.Class(TITLEBAR_BUTTON_CLASS),
        ],
        [icon(h, PanelRight, "panel-right", "size-4")]
      ),
    ]
  );

/** What the diff panel's own toggle view reads from its thread page. */
export interface ToggleViewInputs {
  readonly threadId: Option.Option<ThreadId>;
  /** The older entries paged in above the thread view. */
  readonly older: ReadonlyArray<Entry>;
  /** The thread view's entries. */
  readonly entries: ReadonlyArray<Entry>;
}

/**
 * The diff toggle as the diff panel's own view, so the panel builds its `ClickedToggle`: it opens
 * the thread's whole diff up to the newest checkpoint turn.
 */
export const toggleView = Submodel.defineView<Model, Message, ToggleViewInputs>(
  (model, { threadId, older, entries }, h) =>
    diffToggle(h, {
      open: isOpen(model),
      onToggle: Option.zipWith(
        threadId,
        latestAcross(older, entries),
        (pageThreadId, latestTurn) =>
          Message.ClickedToggle({ threadId: pageThreadId, latestTurn })
      ),
    })
);
