// Scene tests for the `next` row: its main area is one button that sends its message, trailing
// actions sit beside it (never inside), the open row says so, a disabled row sends nothing, and the
// key hint hides on a coarse pointer.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";
import { Ellipsis } from "lucide";

import { buttonDefaults } from "./Button.ts";
import { glyph } from "./Glyph.ts";
import { iconButton } from "./IconButton.ts";
import { kbd } from "./Kbd.ts";
import { row, rowDefaults } from "./Row.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import type { Message } from "./SceneFixture.ts";

const app = appOf((h) => [
  row(
    h,
    {
      ...rowDefaults<Message>(),
      onClick: Option.some(sent("open")),
      isCurrent: true,
      attributes: [h.DataAttribute("testid", "current")],
    },
    {
      leading: Option.none(),
      title: "Port the request card",
      meta: Option.some("4m"),
      hint: Option.some(kbd(h, "1")),
      trailing: [
        iconButton(
          h,
          {
            ...buttonDefaults<Message>(),
            variant: "ghost",
            onClick: Option.some(sent("menu")),
            label: "Thread actions",
            attributes: [h.DataAttribute("testid", "trailing")],
          },
          glyph(h, Ellipsis, "ellipsis", "small")
        ),
      ],
    }
  ),
  row(
    h,
    {
      ...rowDefaults<Message>(),
      onClick: Option.some(sent("disabled")),
      isDisabled: true,
      isEmphasised: true,
      attributes: [h.DataAttribute("testid", "disabled")],
    },
    {
      leading: Option.none(),
      title: "Archived",
      meta: Option.none(),
      hint: Option.none(),
      trailing: [],
    }
  ),
]);

describe("the next row", () => {
  it("opens from its main area and runs a trailing action on its own", () => {
    Scene.scene(
      app,
      given,
      Scene.click(Scene.testId("current")),
      Scene.click(Scene.testId("trailing")),
      expectSent("open,menu"),
      Scene.inside(
        Scene.testId("current"),
        Scene.expect(Scene.testId("trailing")).not.toExist()
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("marks the open row current, and is a touch target with an inset ring", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("current")).toHaveAttr("aria-current", "true"),
      Scene.expect(Scene.testId("disabled")).not.toHaveAttr("aria-current"),
      Scene.expect(Scene.testId("current")).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.expect(Scene.testId("current")).toHaveClass(
        "focus-visible:-outline-offset-2"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("hides its key hint on a coarse pointer and truncates its title", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("current"),
        Scene.expect(Scene.selector('[data-slot="kbd"]')).toExist(),
        Scene.expect(Scene.text("Port the request card")).toHaveClass(
          "truncate"
        )
      ),
      Scene.expect(Scene.selector('[data-slot="row-hint"]')).toHaveClass(
        "pointer-coarse:hidden"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("sends nothing while disabled, and draws an emphasised title strong", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("disabled")).toHaveAttr(
        "aria-disabled",
        "true"
      ),
      Scene.expect(Scene.testId("disabled")).not.toHaveHandler("click"),
      Scene.expect(Scene.text("Archived")).toHaveClass(
        "font-(--weight-strong)"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
