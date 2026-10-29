// Scene tests for the look catalogue: it opens in the look and theme its address names (graphite
// in dark otherwise), its switches change both, it has a section for every primitive, its live
// specimens work (a toggle chip, the field, the disclosures, and the sheet over the page through
// @foldkit/ui's dialog), and every state has a name a judge can point at.

import { assert, describe, it } from "@effect/vitest";
import * as Dialog from "@foldkit/ui/dialog";
import * as Scene from "foldkit/scene";

import { initialOf, update, view } from "./Catalogue.ts";

const PRIMITIVES = [
  "button",
  "icon-button",
  "chip",
  "status-chip",
  "glyph",
  "avatar",
  "row",
  "menu",
  "card",
  "sheet",
  "disclosure",
  "tally",
  "stepper",
  "tooltip",
  "field",
  "banner",
  "divider",
  "kbd",
  "meter",
  "empty",
];

describe("the look catalogue", () => {
  it("opens in the look and theme its address names, else graphite in dark", () => {
    assert.include(initialOf("?look=stone&theme=light"), {
      look: "stone",
      theme: "light",
    });
    assert.include(initialOf(""), { look: "graphite", theme: "dark" });
    assert.include(initialOf("?look=neon&theme=dim"), {
      look: "graphite",
      theme: "dark",
    });
  });

  it("switches look and theme on the next root, and dark by the dark class", () => {
    Scene.scene(
      { update, view },
      Scene.given(initialOf("")),
      Scene.expect(Scene.selector('[data-ui="next"]')).toHaveAttr(
        "data-look",
        "graphite"
      ),
      Scene.expect(Scene.selector("[data-look-catalogue]")).toHaveClass("dark"),
      Scene.click(Scene.testId("look-choose-ink")),
      Scene.click(Scene.testId("look-theme-light")),
      Scene.expect(Scene.selector('[data-ui="next"]')).toHaveAttr(
        "data-look",
        "ink"
      ),
      Scene.expect(Scene.selector('[data-ui="next"]')).toHaveAttr(
        "data-theme",
        "light"
      ),
      Scene.expect(Scene.selector("[data-look-catalogue]")).not.toHaveClass(
        "dark"
      ),
      Scene.expect(Scene.testId("look-choose-ink")).toHaveAttr(
        "aria-pressed",
        "true"
      ),
      Scene.expect(Scene.testId("look-choose-graphite")).toHaveAttr(
        "aria-pressed",
        "false"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("has a section for every primitive, each with named states", () => {
    Scene.scene(
      { update, view },
      Scene.given(initialOf("")),
      ...PRIMITIVES.map((primitive) =>
        Scene.expect(Scene.testId(`look-${primitive}`)).toExist()
      ),
      ...PRIMITIVES.map((primitive) =>
        Scene.inside(
          Scene.testId(`look-${primitive}`),
          Scene.expect(
            Scene.first(
              Scene.all.selector(`[data-look-state^="${primitive}/"]`)
            )
          ).toExist()
        )
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("opens and folds its live disclosures", () => {
    Scene.scene(
      { update, view },
      Scene.given(initialOf("")),
      Scene.expect(Scene.selector("#look-disclosure-phase-button")).toHaveAttr(
        "aria-expanded",
        "true"
      ),
      Scene.expect(Scene.selector("#look-disclosure-fold-button")).toHaveAttr(
        "aria-expanded",
        "false"
      ),
      Scene.click(Scene.selector("#look-disclosure-fold-button")),
      Scene.click(Scene.selector("#look-disclosure-phase-button")),
      Scene.expect(Scene.selector("#look-disclosure-fold-button")).toHaveAttr(
        "aria-expanded",
        "true"
      ),
      Scene.expect(Scene.selector("#look-disclosure-fold-panel")).toExist(),
      Scene.expect(Scene.selector("#look-disclosure-phase-button")).toHaveAttr(
        "aria-expanded",
        "false"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("runs its live specimens: a toggle chip, the field and the sheet", () => {
    Scene.scene(
      { update, view },
      Scene.given(initialOf("")),
      Scene.expect(Scene.role("button", { name: "Open" })).toHaveAttr(
        "aria-pressed",
        "true"
      ),
      Scene.click(Scene.role("button", { name: "Open" })),
      Scene.expect(Scene.role("button", { name: "Open" })).toHaveAttr(
        "aria-pressed",
        "false"
      ),
      Scene.type(Scene.label("Answer"), "yes"),
      Scene.expect(Scene.label("Answer")).toHaveValue("yes"),
      Scene.expect(Scene.testId("look-live-sheet")).not.toExist(),
      Scene.click(Scene.testId("look-open-sheet")),
      Scene.Command.resolve(
        Dialog.ShowDialog,
        Dialog.Message.SucceededShowDialog()
      ),
      Scene.Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      Scene.expect(Scene.testId("look-live-sheet")).toExist(),
      Scene.inside(
        Scene.testId("look-live-sheet"),
        Scene.expect(Scene.role("heading", { name: "Criteria" })).toExist()
      ),
      Scene.inside(
        Scene.testId("look-live-sheet"),
        Scene.click(Scene.role("button", { name: "Close" }))
      ),
      Scene.Command.resolve(
        Dialog.CloseDialog,
        Dialog.Message.CompletedCloseDialog()
      ),
      Scene.expect(Scene.testId("look-live-sheet")).not.toExist(),
      Scene.Mount.expectEnded(Dialog.AcquireResources),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
