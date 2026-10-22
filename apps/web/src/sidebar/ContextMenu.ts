// Ported from github.com/pingdotgg/t3code, apps/web/src/contextMenuFallback.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the browser's context menu for a row, its panel,
// row, separator, icon and chevron markup with the same classes and inline styles, submenus opening
// to the right of their item (or to the left at the viewport edge), positions clamped 4px inside the
// viewport, and a destructive tone for delete. Changed: a Foldkit view over the Model (which item is
// highlighted, which submenu is open) instead of DOM built by hand; the clamping is a Mount on each
// panel; dismissal (Escape, a press outside) comes from a Subscription.
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
import type { ContextMenuItem } from "@cairn/client-logic/ThreadMenu";
import { Array, Effect, Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Mount from "foldkit/mount";

import {
  CONTEXT_MENU_CLASS,
  CONTEXT_MENU_INNER_CLASS,
  CONTEXT_MENU_INNER_STYLE,
  CONTEXT_MENU_ROW_CLASS,
  CONTEXT_MENU_ROW_STYLE,
  CONTEXT_MENU_SEPARATOR_CLASS,
  CONTEXT_MENU_SEPARATOR_STYLE,
  CONTEXT_MENU_STYLE,
} from "./Classes.ts";
import { menuIcon } from "./Icons.ts";
import { Message } from "./Message.ts";
import type { ContextMenu } from "./Model.ts";
import { cx } from "./Row.ts";

type H = HtmlBuilder<Message>;

/** The attribute a top-level item carries, so its submenu can find it. */
const ITEM_ATTRIBUTE = "data-context-menu-item";

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(4, value), Math.max(4, max));

/**
 * Places a menu panel: the top level at the pointer, a submenu beside its item (to the left when
 * it would leave the viewport), both kept 4px inside the viewport.
 */
export const PlaceMenu = Mount.define("PlaceMenu", {
  args: {
    x: Schema.Finite,
    y: Schema.Finite,
    anchorIndex: Schema.Option(Schema.Int),
  },
  messages: [Message.CompletedPlaceMenu],
  execute: ({ anchorIndex, element, x, y }) =>
    Effect.sync(() => {
      if (!(element instanceof HTMLElement)) {
        return Message.CompletedPlaceMenu();
      }

      const panel = element.getBoundingClientRect();

      const anchor = Option.flatMap(anchorIndex, (index) =>
        Option.fromNullOr(
          element.ownerDocument.querySelector(`[${ITEM_ATTRIBUTE}="${index}"]`)
        )
      );

      const place = Option.match(anchor, {
        onNone: () => ({ left: x, top: y }),
        onSome: (item) => {
          const rect = item.getBoundingClientRect();
          const right = rect.right + 4;

          return {
            left:
              right + panel.width > window.innerWidth
                ? rect.left - panel.width - 4
                : right,
            top: rect.top,
          };
        },
      });

      element.style.left = `${clamp(place.left, window.innerWidth - panel.width - 4)}px`;
      element.style.top = `${clamp(place.top, window.innerHeight - panel.height - 4)}px`;

      return Message.CompletedPlaceMenu();
    }),
});

const rowStyle = (
  disabled: boolean,
  destructive: boolean,
  highlighted: boolean
) => {
  const style = new Map<string, string>(Object.entries(CONTEXT_MENU_ROW_STYLE));

  if (destructive) {
    style.set("color", "var(--destructive-foreground)");
  }

  if (disabled) {
    style.set("color", "var(--contrast-muted-foreground)");
    style.set("opacity", "0.64");
    style.set("pointer-events", "none");
  } else if (highlighted && destructive) {
    style.set(
      "background",
      "color-mix(in srgb, var(--destructive) 10%, transparent)"
    );
  } else if (highlighted) {
    style.set("background", "var(--accent)");
    style.set("color", "var(--contrast-accent-foreground)");
  }

  return Object.fromEntries(style);
};

const rowClass = (disabled: boolean, destructive: boolean): string => {
  if (disabled) {
    return cx(
      CONTEXT_MENU_ROW_CLASS,
      "pointer-events-none cursor-not-allowed text-muted-foreground opacity-64"
    );
  }

  return cx(
    CONTEXT_MENU_ROW_CLASS,
    destructive
      ? "text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground"
      : "text-foreground hover:bg-accent hover:text-accent-foreground"
  );
};

const ICON_CLASS = "size-4.5 shrink-0 text-muted-foreground sm:size-4";

const DESTRUCTIVE_ICON_CLASS = "size-4.5 shrink-0 sm:size-4";

const itemView = <Id extends string>(
  h: H,
  item: ContextMenuItem<Id>,
  inputs: {
    readonly index: number;
    readonly highlighted: boolean;
    readonly isTopLevel: boolean;
  }
): Html => {
  const hasChildren = item.children.length > 0;

  const destructive =
    !hasChildren && (item.destructive || item.id === "delete");

  const leading = Option.match(item.checked, {
    onNone: () =>
      Option.match(item.icon, {
        onNone: () => h.empty,
        onSome: (name) =>
          menuIcon(h, name, destructive ? DESTRUCTIVE_ICON_CLASS : ICON_CLASS),
      }),
    onSome: (checked) =>
      checked
        ? menuIcon(h, "check", ICON_CLASS)
        : h.span(
            [
              h.AriaHidden(true),
              h.Class("size-4.5 shrink-0 sm:size-4"),
              h.Style({
                display: "inline-block",
                width: "1rem",
                height: "1rem",
                "flex-shrink": "0",
              }),
            ],
            []
          ),
  });

  return h.button(
    [
      h.Type("button"),
      h.Disabled(item.disabled),
      h.DataAttribute("menu-id", item.id),
      ...(inputs.isTopLevel
        ? [h.Attribute(ITEM_ATTRIBUTE, String(inputs.index))]
        : []),
      ...Option.match(item.checked, {
        onNone: () => [],
        onSome: (checked) => [h.Role("menuitemradio"), h.AriaChecked(checked)],
      }),
      ...(hasChildren
        ? [h.AriaHasPopup("menu"), h.AriaExpanded(inputs.highlighted)]
        : []),
      h.Class(rowClass(item.disabled, destructive)),
      h.Style(rowStyle(item.disabled, destructive, inputs.highlighted)),
      h.OnMouseEnter(
        inputs.isTopLevel
          ? Message.HoveredMenuItem({ index: inputs.index })
          : Message.HoveredSubmenuItem({ index: inputs.index })
      ),
      h.OnClick(
        hasChildren
          ? Message.HoveredMenuItem({ index: inputs.index })
          : Message.ChoseMenuItem({ id: item.id })
      ),
    ],
    [
      leading,
      h.span([h.Class("min-w-0 flex-1 truncate")], [item.label]),
      hasChildren
        ? menuIcon(
            h,
            "chevron-right",
            "-me-0.5 ms-auto size-4.5 shrink-0 text-muted-foreground opacity-80 sm:size-4"
          )
        : h.empty,
    ]
  );
};

const panelView = <Id extends string>(
  h: H,
  items: ReadonlyArray<ContextMenuItem<Id>>,
  inputs: {
    readonly level: number;
    readonly x: number;
    readonly y: number;
    readonly highlighted: Option.Option<number>;
    readonly anchorIndex: Option.Option<number>;
  }
): Html =>
  h.div(
    [
      h.Key(
        `context-menu-${inputs.level}-${Option.getOrElse(inputs.anchorIndex, () => -1)}`
      ),
      h.DataAttribute("level", String(inputs.level)),
      h.DataAttribute(
        "testid",
        inputs.level === 0 ? "sidebar-context-menu" : "sidebar-context-submenu"
      ),
      h.Role("menu"),
      h.Class(CONTEXT_MENU_CLASS),
      h.Style({
        ...CONTEXT_MENU_STYLE,
        left: `${inputs.x}px`,
        top: `${inputs.y}px`,
      }),
      h.OnMount(
        PlaceMenu({ x: inputs.x, y: inputs.y, anchorIndex: inputs.anchorIndex })
      ),
    ],
    [
      h.div(
        [
          h.Class(CONTEXT_MENU_INNER_CLASS),
          h.Style({ ...CONTEXT_MENU_INNER_STYLE }),
        ],
        items.flatMap((item, index) => [
          item.separatorBefore && index > 0
            ? h.div(
                [
                  h.Role("separator"),
                  h.DataAttribute("context-menu-separator", "true"),
                  h.Class(CONTEXT_MENU_SEPARATOR_CLASS),
                  h.Style({ ...CONTEXT_MENU_SEPARATOR_STYLE }),
                ],
                []
              )
            : h.empty,
          itemView(h, item, {
            index,
            highlighted: Option.contains(inputs.highlighted, index),
            isTopLevel: inputs.level === 0,
          }),
        ])
      ),
    ]
  );

/** The open context menu and, when its highlighted item has children, that submenu. */
export const contextMenuView = <Id extends string>(
  h: H,
  menu: ContextMenu,
  items: ReadonlyArray<ContextMenuItem<Id>>
): Html => {
  const submenu = Option.flatMap(menu.highlighted, (index) =>
    Option.filter(
      Option.map(Array.get(items, index), (item) => ({ index, item })),
      ({ item }) => item.children.length > 0 && !item.disabled
    )
  );

  return h.div(
    [h.Class("contents")],
    [
      panelView(h, items, {
        level: 0,
        x: menu.x,
        y: menu.y,
        highlighted: menu.highlighted,
        anchorIndex: Option.none(),
      }),
      Option.match(submenu, {
        onNone: () => h.empty,
        onSome: ({ index, item }) =>
          panelView(h, item.children, {
            level: 1,
            x: menu.x,
            y: menu.y,
            highlighted: menu.childHighlighted,
            anchorIndex: Option.some(index),
          }),
      }),
    ]
  );
};
