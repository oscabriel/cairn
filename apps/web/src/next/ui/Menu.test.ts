// Scene tests for the `next` menu panel and tooltip: the panel is a labelled menu of menuitem
// buttons in groups with a separator between them; the active item is marked, a disabled item
// sends nothing, a destructive one takes the failed tone, and hints hide on a coarse pointer. A
// tooltip bubble has its role and the id its trigger names, and shows only while visible.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { kbd } from "./Kbd.ts";
import { MENU_ITEM_CLASS, menuItem, menuPanel } from "./Menu.ts";
import type { MenuItemLook } from "./Menu.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import { tooltipBubble, tooltipToView } from "./Tooltip.ts";

const look = (label: string, isDestructive = false): MenuItemLook => ({
  glyph: Option.none(),
  label,
  hint: Option.none(),
  isDestructive,
});

const app = appOf((h) => [
  menuPanel(h, "Thread actions", [
    {
      heading: Option.some("Thread"),
      items: [
        {
          look: { ...look("Rename"), hint: Option.some(kbd(h, "R")) },
          isActive: true,
          isDisabled: false,
          onClick: Option.some(sent("rename")),
        },
        {
          look: look("Move"),
          isActive: false,
          isDisabled: true,
          onClick: Option.some(sent("move")),
        },
      ],
    },
    {
      heading: Option.none(),
      items: [
        {
          look: look("Archive", true),
          isActive: false,
          isDisabled: false,
          onClick: Option.some(sent("archive")),
        },
      ],
    },
  ]),
  tooltipBubble(h, "tip", "Copy link"),
  tooltipToView(
    h,
    h.span([], ["trigger"]),
    "Shown"
  )({
    trigger: [],
    panel: [],
    isVisible: true,
  }),
  tooltipToView(
    h,
    h.span([], ["trigger"]),
    "Hidden"
  )({
    trigger: [],
    panel: [],
    isVisible: false,
  }),
  menuItem(h, look("Copy")).content,
]);

describe("the next menu panel", () => {
  it("is a labelled menu of grouped items with a separator between groups", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.role("menu", { name: "Thread actions" })).toExist(),
      Scene.expectAll(Scene.all.role("menuitem")).toHaveCount(3),
      Scene.expectAll(Scene.all.role("separator")).toHaveCount(1),
      Scene.expect(Scene.text("Thread")).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("marks the active item, sends a click, and sends nothing from a disabled item", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.role("menuitem", { name: /^Rename/u })).toHaveAttr(
        "data-active"
      ),
      Scene.expect(Scene.role("menuitem", { name: "Move" })).toHaveAttr(
        "aria-disabled",
        "true"
      ),
      Scene.expect(Scene.role("menuitem", { name: "Move" })).not.toHaveHandler(
        "click"
      ),
      Scene.click(Scene.role("menuitem", { name: "Archive" })),
      Scene.click(Scene.role("menuitem", { name: /^Rename/u })),
      expectSent("archive,rename"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws a destructive item in the failed tone and items as touch targets", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.selector('[data-variant="destructive"]')).toHaveText(
        "Archive"
      ),
      Scene.expect(Scene.role("menuitem", { name: "Archive" })).toHaveClass(
        "data-[variant=destructive]:text-tone-failed"
      ),
      Scene.expect(Scene.role("menuitem", { name: "Archive" })).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("gives @foldkit/ui's menu the same item class", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.text("Copy")).toHaveClass("truncate")
    );
    Scene.scene(
      appOf((h) => [
        h.div(
          [
            h.DataAttribute("testid", "item"),
            h.Class(menuItem(h, look("Copy")).className ?? ""),
          ],
          []
        ),
      ]),
      given,
      Scene.expect(Scene.testId("item")).toHaveClass(
        MENU_ITEM_CLASS.split(" ")[0] ?? ""
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the next tooltip", () => {
  it("is a tooltip with the id its trigger names, shown only while visible", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.role("tooltip")).toHaveId("tip"),
      Scene.expect(Scene.role("tooltip")).toHaveText("Copy link"),
      Scene.expect(Scene.text("Shown")).toHaveAttr("data-slot", "tooltip"),
      Scene.expect(Scene.text("Hidden")).not.toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
