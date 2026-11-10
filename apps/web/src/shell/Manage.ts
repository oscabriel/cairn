// The basic management actions (U-10): the selected project's menu beside its name at the head of
// the sidebar list, and the open thread's menu in the chat header, each a `menuPanel` (`../ui/Menu.ts`)
// drawn open under its button while the shell says so, closed by a click outside or Escape. Rename
// project and Rename thread open a dialog with the name to edit; Remove project opens a confirm
// that says what happens to its threads (`ManageDialog.ts`, its own chunk: a cold load never draws
// it). The commands are `ProjectUpdate`, `ProjectDelete` and `ThreadRename`; nothing here deletes a
// thread.

import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Ellipsis, Pencil, Trash2 } from "lucide";

import { buttonDefaults } from "../ui/Button.ts";
import { glyph } from "../ui/Glyph.ts";
import { iconButtonWithTooltip } from "../ui/IconButton.ts";
import { menuPanel } from "../ui/Menu.ts";
import type { PanelItem } from "../ui/Menu.ts";
import { Message } from "./Message.ts";
import type { ManageAction, MenuTarget } from "./Model.ts";

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
