// The `next` chat header's diff toggle (plan look track L7): classic's toggle (`diff/Toggle.ts`,
// whose `toggleView` builds the same `ClickedToggle` from the newest checkpoint turn) as a `next`
// ghost icon button beside L6's Refresh and scratch buttons, so it is `--hit-target` square on a
// coarse pointer and shows the focus ring on keyboard focus only. It is pressed while the panel is
// open; with no checkpoint yet it says so and takes no click.

import type { Entry } from "@cairn/protocol/Thread";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { PanelRight } from "lucide";

import { Message } from "../../diff/Message.ts";
import { isOpen } from "../../diff/Model.ts";
import type { Model } from "../../diff/Model.ts";
import { latestCheckpointTurn } from "../../diff/Toggle.ts";
import type { ToggleViewInputs } from "../../diff/Toggle.ts";
import { buttonDefaults } from "../ui/Button.ts";
import { glyph } from "../ui/Glyph.ts";
import { iconButton } from "../ui/IconButton.ts";

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

/** The diff toggle for the `next` chat header. */
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
