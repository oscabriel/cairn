// Scene tests for the `next` sheet: a dialog named by its title, modal only over the whole page,
// closed by its close button or a tap on the scrim, with its body and its actions; a bottom sheet
// under `sm` and a docked panel from `sm`.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import { sheet, sheetClass } from "./Sheet.ts";

const app = appOf((h) => [
  sheet(
    h,
    {
      placement: "viewport",
      id: "criteria",
      title: "Criteria",
      onClose: Option.some(sent("close")),
      attributes: [h.DataAttribute("testid", "viewport")],
    },
    [h.p([], ["Body"])],
    [h.span([h.DataAttribute("testid", "action")], ["Done"])]
  ),
  sheet(
    h,
    {
      placement: "contained",
      id: "steps",
      title: "Steps",
      onClose: Option.none(),
      attributes: [h.DataAttribute("testid", "contained")],
    },
    [],
    []
  ),
]);

describe("the next sheet", () => {
  it("is a dialog named by its title, modal only over the page", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.role("dialog", { name: "Criteria" })).toExist(),
      Scene.expect(Scene.testId("viewport")).toHaveAttr("aria-modal", "true"),
      Scene.expect(Scene.testId("viewport")).toHaveClass("fixed"),
      Scene.expect(Scene.role("dialog", { name: "Steps" })).toExist(),
      Scene.expect(Scene.testId("contained")).not.toHaveAttr("aria-modal"),
      Scene.expect(Scene.testId("contained")).toHaveClass("absolute"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("closes from its close button and from its scrim", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("viewport"),
        Scene.click(Scene.role("button", { name: "Close" }))
      ),
      Scene.click(
        Scene.selector('[data-placement="viewport"] [data-slot="sheet-scrim"]')
      ),
      expectSent("close,close"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows its actions in a footer only when it has some", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("viewport"),
        Scene.expect(Scene.testId("action")).toExist()
      ),
      Scene.inside(
        Scene.testId("contained"),
        Scene.expect(Scene.selector("footer")).not.toExist()
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("is a bottom sheet on the phone and a docked panel from sm", () => {
    Scene.scene(
      appOf((h) => [
        h.div(
          [h.DataAttribute("testid", "panel"), h.Class(sheetClass("viewport"))],
          []
        ),
      ]),
      given,
      Scene.expect(Scene.testId("panel")).toHaveClass("bottom-0"),
      Scene.expect(Scene.testId("panel")).toHaveClass(
        "rounded-t-(--radius-large)"
      ),
      Scene.expect(Scene.testId("panel")).toHaveClass("sm:right-0"),
      Scene.expect(Scene.testId("panel")).toHaveClass("sm:top-0"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
