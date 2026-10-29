// Scene tests for the `next` sheet: in a pane it is a dialog named by its title, not modal, closed
// by its close button or a tap on its scrim, and with no close button when nothing closes it; over
// the page it is @foldkit/ui's dialog drawn as a sheet, its scrim, title and close button the
// dialog's own, and nothing while the dialog is hidden. A bottom sheet under `sm`, a floating panel
// from `sm`, docked from `lg`.

import { assert, describe, it } from "@effect/vitest";
import type { RenderInfo } from "@foldkit/ui/dialog";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import { sheet, sheetClass, sheetToView } from "./Sheet.ts";

const render = (isVisible: boolean): RenderInfo => ({
  dialog: [],
  backdrop: [],
  panel: [],
  title: [],
  description: [],
  initialFocus: [],
  closeButton: [],
  isVisible,
});

const app = appOf((h) => [
  sheet(
    h,
    {
      id: "criteria",
      title: "Criteria",
      onClose: Option.some(sent("close")),
      attributes: [h.DataAttribute("testid", "closable")],
    },
    [h.p([], ["Body"])],
    [h.span([h.DataAttribute("testid", "action")], ["Done"])]
  ),
  sheet(
    h,
    {
      id: "steps",
      title: "Steps",
      onClose: Option.none(),
      attributes: [h.DataAttribute("testid", "fixed")],
    },
    [],
    []
  ),
  h.div(
    [h.DataAttribute("testid", "shown")],
    [
      sheetToView(
        h,
        "Over the page",
        [h.p([], ["Shown body"])],
        [],
        [h.DataAttribute("testid", "viewport-panel")]
      )(render(true)),
    ]
  ),
  h.div(
    [h.DataAttribute("testid", "hidden")],
    [sheetToView(h, "Hidden sheet", [], [])(render(false))]
  ),
]);

describe("the next sheet in a pane", () => {
  it("is a dialog named by its title, and not modal", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.role("dialog", { name: "Criteria" })).toExist(),
      Scene.expect(Scene.testId("closable")).not.toHaveAttr("aria-modal"),
      Scene.expect(Scene.testId("closable")).toHaveClass("absolute"),
      Scene.expect(Scene.role("dialog", { name: "Steps" })).toExist(),
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
        Scene.testId("closable"),
        Scene.click(Scene.role("button", { name: "Close" }))
      ),
      Scene.click(
        Scene.selector('[data-placement="contained"] [data-slot="sheet-scrim"]')
      ),
      expectSent("close,close"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws no close button when nothing closes it", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("fixed"),
        Scene.expect(Scene.role("button", { name: "Close" })).not.toExist()
      ),
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
        Scene.testId("closable"),
        Scene.expect(Scene.testId("action")).toExist()
      ),
      Scene.inside(
        Scene.testId("fixed"),
        Scene.expect(Scene.selector("footer")).not.toExist()
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the next sheet over the page", () => {
  it("draws @foldkit/ui's dialog as a fixed sheet with its title and close button", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("shown"),
        Scene.expect(Scene.selector("dialog")).toHaveAttr(
          "data-placement",
          "viewport"
        )
      ),
      Scene.expect(Scene.testId("viewport-panel")).toHaveClass("fixed"),
      Scene.inside(
        Scene.testId("viewport-panel"),
        Scene.expect(Scene.role("heading", { name: "Over the page" })).toExist()
      ),
      Scene.inside(
        Scene.testId("viewport-panel"),
        Scene.expect(Scene.role("button", { name: "Close" })).toExist()
      ),
      Scene.inside(
        Scene.testId("shown"),
        Scene.expect(Scene.selector('[data-slot="sheet-scrim"]')).toHaveClass(
          "bg-scrim"
        )
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws nothing inside the dialog while it is hidden", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("hidden"),
        Scene.expect(Scene.text("Hidden sheet")).not.toExist()
      ),
      Scene.inside(
        Scene.testId("hidden"),
        Scene.expect(Scene.selector('[data-slot="sheet-scrim"]')).not.toExist()
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("is a bottom sheet on the phone, floats from sm and docks from lg", () => {
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
      Scene.expect(Scene.testId("panel")).toHaveClass("sm:top-(--space-3)"),
      Scene.expect(Scene.testId("panel")).toHaveClass(
        "sm:rounded-(--radius-large)"
      ),
      Scene.expect(Scene.testId("panel")).toHaveClass("lg:right-0"),
      Scene.expect(Scene.testId("panel")).toHaveClass("lg:top-0"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
