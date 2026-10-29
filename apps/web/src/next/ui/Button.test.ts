// Scene tests for the `next` button and icon button: a click sends its message; disabled and busy
// buttons stay focusable but send nothing; a toggle says its state; every size is a touch target.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";
import { Settings } from "lucide";

import { button, buttonDefaults } from "./Button.ts";
import { glyph } from "./Glyph.ts";
import { iconButton } from "./IconButton.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import type { Message } from "./SceneFixture.ts";

const app = appOf((h) => [
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "primary",
      onClick: Option.some(sent("save")),
      attributes: [h.DataAttribute("testid", "save")],
    },
    ["Save"]
  ),
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      onClick: Option.some(sent("disabled")),
      isDisabled: true,
      attributes: [h.DataAttribute("testid", "disabled")],
    },
    ["Disabled"]
  ),
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      size: "small",
      onClick: Option.some(sent("busy")),
      isBusy: true,
      attributes: [h.DataAttribute("testid", "busy")],
    },
    ["Busy"]
  ),
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "ghost",
      isPressed: Option.some(true),
      attributes: [h.DataAttribute("testid", "toggle")],
    },
    ["On"]
  ),
  iconButton(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "ghost",
      onClick: Option.some(sent("settings")),
      label: "Settings",
      attributes: [h.DataAttribute("testid", "icon")],
    },
    glyph(h, Settings, "settings", "regular")
  ),
  iconButton(
    h,
    {
      ...buttonDefaults<Message>(),
      isBusy: true,
      label: "Saving",
      attributes: [h.DataAttribute("testid", "icon-busy")],
    },
    glyph(h, Settings, "settings", "regular")
  ),
]);

describe("the next button", () => {
  it("sends its message on a click, as a button that submits nothing", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("save")).toHaveAttr("type", "button"),
      Scene.expect(Scene.testId("save")).toHaveClass("bg-accent-fill"),
      Scene.click(Scene.testId("save")),
      expectSent("save"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("is a touch target on a coarse pointer and draws the focus ring", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("save")).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.expect(Scene.testId("save")).toHaveClass(
        "pointer-coarse:min-w-(--hit-target)"
      ),
      Scene.expect(Scene.testId("save")).toHaveClass(
        "focus-visible:outline-stroke-focus"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("stays focusable but sends nothing while disabled", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("disabled")).toHaveAttr(
        "aria-disabled",
        "true"
      ),
      Scene.expect(Scene.testId("disabled")).not.toHaveAttr("disabled"),
      Scene.expect(Scene.testId("disabled")).not.toHaveHandler("click"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows the busy mark and sends nothing while busy", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("busy")).toHaveAttr("aria-busy", "true"),
      Scene.expect(Scene.testId("busy")).not.toHaveHandler("click"),
      Scene.inside(
        Scene.testId("busy"),
        Scene.expect(Scene.selector('[data-glyph="busy"]')).toExist()
      ),
      Scene.expect(Scene.testId("save")).not.toHaveAttr("aria-busy"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says a toggle's state and nothing on a plain button", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("toggle")).toHaveAttr("aria-pressed", "true"),
      Scene.expect(Scene.testId("save")).not.toHaveAttr("aria-pressed"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the next icon button", () => {
  it("is named by its label and sends its message", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("icon")).toHaveAccessibleName("Settings"),
      Scene.expect(Scene.testId("icon")).toHaveClass("w-9"),
      Scene.click(Scene.testId("icon")),
      expectSent("settings"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("swaps its glyph for the busy mark while busy", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("icon-busy"),
        Scene.expect(Scene.selector('[data-glyph="busy"]')).toExist(),
        Scene.expect(Scene.selector(".lucide-settings")).not.toExist()
      ),
      Scene.expect(Scene.testId("icon-busy")).toHaveAccessibleName("Saving"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
