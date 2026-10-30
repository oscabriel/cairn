// The `next` composer's `/`, `@` and `$` menu (plan look track L7): classic's menu
// (`composer/TriggerMenu.ts`, which keeps its contents, keys and picking) drawn in the Stone look
// as a drawer above the box, in the page's flow (the box moves down to make room, so nothing hangs
// outside the lane). Each item is one row at least `--hit-target` tall on a coarse pointer;
// its name and description share the row, and each truncates with an ellipsis rather than
// spilling, so a narrow phone shows "/model  Switch response mo…" and never a sideways scroll.

import type { ComposerTriggerKind } from "@cairn/client-logic/ComposerTrigger";
import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../composer/Message.ts";
import type { Model } from "../../composer/Model.ts";
import {
  MENU_LIST_ID,
  menuContents,
  menuOptionId,
} from "../../composer/TriggerMenu.ts";
import type { MenuContents, MenuItem } from "../../composer/TriggerMenu.ts";
import { HIT_HEIGHT, TYPE } from "../ui/Classes.ts";

const LISTBOX_LABEL: Readonly<Record<ComposerTriggerKind, string>> = {
  path: "Files and folders",
  "slash-command": "Commands",
  "slash-model": "Models",
  skill: "Skills",
};

const EMPTY_TEXT: Readonly<Record<ComposerTriggerKind, string>> = {
  path: "No matching files or folders.",
  skill: "No skills found. Try / to browse commands.",
  "slash-model": "No matching model.",
  "slash-command": "No matching command.",
};

const emptyText = (contents: MenuContents): string => {
  if (contents.loading) {
    return contents.trigger.kind === "path"
      ? "Searching workspace files..."
      : "Searching workspace skills...";
  }

  return Option.getOrElse(
    contents.error,
    () => EMPTY_TEXT[contents.trigger.kind]
  );
};

const ITEM_CLASS = `flex min-h-8 w-full min-w-0 cursor-pointer select-none items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) text-ink-1 hover:bg-select-1 data-active:bg-select-3 ${HIT_HEIGHT}`;

const itemRow = (
  item: MenuItem,
  isActive: boolean,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.Key(item.id),
      h.Id(menuOptionId(item.id)),
      h.Role("option"),
      h.AriaSelected(isActive),
      h.DataAttribute("slot", "command-item"),
      h.DataAttribute("composer-item-id", item.id),
      ...onlyIf(isActive, h.DataAttribute("active", "true")),
      h.Class(ITEM_CLASS),
      h.OnMouseMove(Message.HighlightedMenuItem({ id: item.id })),
      h.OnClick(Message.PickedMenuItem({ id: item.id })),
    ],
    [
      h.span(
        [
          h.Class(
            `min-w-0 max-w-[45%] shrink-0 truncate font-(family-name:--font-code) ${TYPE.small}`
          ),
        ],
        [item.label]
      ),
      h.span(
        [h.Class(`min-w-0 flex-1 truncate text-ink-2 ${TYPE.small}`)],
        [item.description]
      ),
    ]
  );

/** The open menu's list, or what it says when nothing matches. */
const menuBody = (contents: MenuContents, h: HtmlBuilder<Message>): Html =>
  contents.items.length > 0
    ? h.div(
        [
          h.Id(MENU_LIST_ID),
          h.Role("listbox"),
          h.AriaLabel(LISTBOX_LABEL[contents.trigger.kind]),
          h.DataAttribute("slot", "command-list"),
          h.Class(
            "max-h-72 min-h-0 overflow-y-auto overscroll-contain p-(--space-1-5)"
          ),
        ],
        [
          h.div(
            [h.Role("group"), h.DataAttribute("slot", "command-group")],
            contents.items.map((item) =>
              itemRow(item, Option.contains(contents.activeId, item.id), h)
            )
          ),
        ]
      )
    : h.p(
        [h.Class(`px-(--space-4) py-(--space-3) text-ink-2 ${TYPE.small}`)],
        [emptyText(contents)]
      );

/** The drawer above the box while a `/`, `@` or `$` menu is open. */
export const triggerMenuView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(menuContents(model), {
    onNone: () => h.empty,
    onSome: (contents) =>
      h.div(
        [
          h.DataAttribute("composer-drawer-layer", "true"),
          h.Class(
            "pointer-events-auto relative z-40 -mb-px flex flex-col px-(--space-3)"
          ),
        ],
        [
          h.div(
            [
              h.DataAttribute("composer-banner-surface", "floating"),
              h.DataAttribute("composer-command-drawer", "true"),
              h.Class(
                "flex min-h-0 w-full flex-col overflow-hidden rounded-t-(--radius-medium) border border-b-0 border-stroke-2 bg-surface-overlay shadow-(--elevation-2)"
              ),
            ],
            [
              h.div(
                [
                  h.DataAttribute("testid", "composer-menu"),
                  h.DataAttribute("trigger", contents.trigger.kind),
                  h.Class("flex min-h-0 flex-col"),
                ],
                [menuBody(contents, h)]
              ),
            ]
          ),
        ]
      ),
  });
