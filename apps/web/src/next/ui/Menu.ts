// The `next` menu: the look of @foldkit/ui's menu (its popup, items, group headings and separators)
// on the design tokens, and `menuPanel`, the same popup drawn open without the menu's behaviour, for
// the catalogue and for any surface that shows a menu's items in place. @foldkit/ui marks the active
// item `data-active` and a disabled one `aria-disabled` with `data-disabled`; the classes key on
// those, so both forms look alike. On a coarse pointer every item is a full touch target and key
// hints are hidden.
//
// A destructive item's tone is in its own class string (`menuItemClass`), not keyed on an
// attribute: @foldkit/ui's `ItemConfig` carries only a class and content, so the item element
// itself can carry no `data-variant` for a class to key on.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import type { GroupHeading, ItemConfig } from "@foldkit/ui/menu";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import {
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
} from "./Classes.ts";

/** The class string of the menu's popup. */
export const MENU_POPUP_CLASS =
  "flex max-w-[calc(100vw-2rem)] min-w-[min(12rem,calc(100vw-2rem))] flex-col rounded-(--radius-medium) border border-stroke-1 bg-surface-overlay p-(--space-1) text-ink-1 shadow-(--elevation-3) outline-none";

const MENU_ITEM_BASE = classNames(
  "flex min-h-8 w-full cursor-pointer select-none items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1) text-start hover:bg-select-2 data-active:bg-select-2 data-hover:bg-select-2 data-disabled:cursor-not-allowed data-disabled:opacity-50",
  TYPE.ui,
  HIT_HEIGHT,
  FOCUS_RING_INSET
);

/** An item's ink: its label and its glyph. A destructive item draws both in the failed tone. */
const MENU_ITEM_INK = {
  plain: "text-ink-1 [&_svg]:text-ink-2",
  destructive: "text-tone-failed [&_svg]:text-current",
} as const;

/** The class string of one item, destructive or not. */
export const menuItemClass = (isDestructive: boolean): string =>
  classNames(
    MENU_ITEM_BASE,
    isDestructive ? MENU_ITEM_INK.destructive : MENU_ITEM_INK.plain
  );

/** The class string of a group's heading. */
export const MENU_GROUP_LABEL_CLASS = classNames(
  "px-(--space-2) pt-(--space-2) pb-(--space-1) text-ink-3",
  TYPE.small,
  WEIGHT_MEDIUM
);

/** The class string of a separator between groups. */
export const MENU_SEPARATOR_CLASS =
  "mx-(--space-2) my-(--space-1) h-px bg-stroke-1";

/** The classes @foldkit/ui's menu view takes. */
export const menuClassNames = {
  itemsClassName: MENU_POPUP_CLASS,
  groupClassName: "flex flex-col",
  separatorClassName: MENU_SEPARATOR_CLASS,
} as const;

/** One item's look. */
export interface MenuItemLook {
  readonly glyph: Option.Option<Html>;
  readonly label: string;
  /** A key hint after the label, hidden on a coarse pointer. */
  readonly hint: Option.Option<Html>;
  /** Ends or removes something: drawn in the failed tone. */
  readonly isDestructive: boolean;
}

const itemContent = <Message>(
  h: HtmlBuilder<Message>,
  look: MenuItemLook
): Html =>
  h.span(
    [
      h.Class("flex min-w-0 flex-1 items-center gap-(--space-2)"),
      ...onlyIf(look.isDestructive, h.DataAttribute("variant", "destructive")),
    ],
    [
      Option.getOrElse(look.glyph, () => h.empty),
      h.span([h.Class("min-w-0 flex-1 truncate")], [look.label]),
      Option.match(look.hint, {
        onNone: () => h.empty,
        onSome: (hint) =>
          h.span([h.Class("ms-auto shrink-0 pointer-coarse:hidden")], [hint]),
      }),
    ]
  );

/** One item for @foldkit/ui's `itemToConfig`. */
export const menuItem = <Message>(
  h: HtmlBuilder<Message>,
  look: MenuItemLook
): ItemConfig => ({
  className: menuItemClass(look.isDestructive),
  content: itemContent(h, look),
});

/** A group heading for @foldkit/ui's `groupToHeading`. */
export const menuGroupHeading = <Message>(
  h: HtmlBuilder<Message>,
  label: string
): GroupHeading => ({
  content: h.span([], [label]),
  className: MENU_GROUP_LABEL_CLASS,
});

/** An item in a drawn-open panel, with its state. */
export interface PanelItem<Message> {
  readonly look: MenuItemLook;
  /** The item the keyboard or pointer is on (`data-active`). */
  readonly isActive: boolean;
  readonly isDisabled: boolean;
  readonly onClick: Option.Option<Message>;
}

/** A group of items in a drawn-open panel, with its heading if it has one. */
export interface PanelGroup<Message> {
  readonly heading: Option.Option<string>;
  readonly items: ReadonlyArray<PanelItem<Message>>;
}

/** One item of a drawn-open panel: a disabled item says so and takes no click. */
const panelItem = <Message>(
  h: HtmlBuilder<Message>,
  item: PanelItem<Message>
): Html => {
  const click = item.isDisabled
    ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")]
    : Option.toArray(Option.map(item.onClick, (message) => h.OnClick(message)));

  return h.button(
    [
      h.Type("button"),
      h.Role("menuitem"),
      ...onlyIf(item.isActive, h.DataAttribute("active", "")),
      ...onlyIf(
        item.look.isDestructive,
        h.DataAttribute("variant", "destructive")
      ),
      ...click,
      h.Class(menuItemClass(item.look.isDestructive)),
    ],
    [itemContent(h, item.look)]
  );
};

/**
 * The menu's popup drawn open, with no menu behaviour: groups with their headings, separated, and
 * each item in its state. The items are `menuitem` buttons, so they take focus and clicks.
 */
export const menuPanel = <Message>(
  h: HtmlBuilder<Message>,
  label: string,
  groups: ReadonlyArray<PanelGroup<Message>>,
  attributes: ReadonlyArray<Attribute<Message>> = []
): Html =>
  h.div(
    [
      h.Role("menu"),
      h.AriaLabel(label),
      h.DataAttribute("slot", "menu"),
      ...attributes,
      h.Class(MENU_POPUP_CLASS),
    ],
    groups.flatMap((group, index) => [
      index === 0
        ? h.empty
        : h.div([h.Role("separator"), h.Class(MENU_SEPARATOR_CLASS)]),
      h.div(
        [h.Role("group"), h.Class("flex flex-col")],
        [
          Option.match(group.heading, {
            onNone: () => h.empty,
            onSome: (heading) =>
              h.div([h.Class(MENU_GROUP_LABEL_CLASS)], [heading]),
          }),
          ...group.items.map((item) => panelItem(h, item)),
        ]
      ),
    ])
  );
