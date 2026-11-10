// Scene tests for the `next` disclosure: its header says whether it is open and which body it
// controls, toggles from a click, Enter or Space, sends nothing while disabled, and holds its body
// only while open.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { disclosure } from "./Disclosure.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import type { Message } from "./SceneFixture.ts";

const toggled =
  (id: string) =>
  (isOpen: boolean): Message =>
    sent(`${id}:${isOpen ? "open" : "fold"}`);

const app = appOf((h) => [
  disclosure(
    h,
    {
      id: "fold",
      isOpen: false,
      onToggle: toggled("fold"),
      isDisabled: false,
      attributes: [h.DataAttribute("testid", "folded")],
    },
    {
      glyph: Option.none(),
      title: "Worked for 4m",
      tally: Option.some(
        h.span([h.DataAttribute("testid", "tally")], ["4 agents"])
      ),
      body: [h.p([], ["Folded body"])],
    }
  ),
  disclosure(
    h,
    {
      id: "phase",
      isOpen: true,
      onToggle: toggled("phase"),
      isDisabled: false,
      attributes: [h.DataAttribute("testid", "open")],
    },
    {
      glyph: Option.none(),
      title: "Build",
      tally: Option.none(),
      body: [
        h.ul([h.AriaLabel("Build steps")], [h.li([], ["Port the panel"])]),
      ],
    }
  ),
  disclosure(
    h,
    {
      id: "previous",
      isOpen: false,
      onToggle: toggled("previous"),
      isDisabled: true,
      attributes: [h.DataAttribute("testid", "disabled")],
    },
    {
      glyph: Option.none(),
      title: "Previous agents",
      tally: Option.none(),
      body: [],
    }
  ),
]);

describe("the next disclosure", () => {
  it("says whether it is open, and controls its body only while open", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("folded")).toHaveAttr("aria-expanded", "false"),
      Scene.expect(Scene.testId("folded")).not.toHaveAttr("aria-controls"),
      Scene.expect(Scene.text("Folded body")).not.toExist(),
      Scene.expect(Scene.testId("open")).toHaveAttr("aria-expanded", "true"),
      Scene.expect(Scene.testId("open")).toHaveAttr(
        "aria-controls",
        "phase-panel"
      ),
      Scene.expect(Scene.selector("#phase-panel")).toHaveAttr(
        "data-slot",
        "disclosure-body"
      ),
      Scene.expect(Scene.role("list", { name: "Build steps" })).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("toggles from a click, Enter and Space, and sends nothing while disabled", () => {
    Scene.scene(
      app,
      given,
      Scene.click(Scene.testId("folded")),
      Scene.keydown(Scene.testId("open"), "Enter"),
      Scene.keydown(Scene.testId("folded"), " "),
      Scene.expect(Scene.testId("disabled")).toHaveAttr(
        "aria-disabled",
        "true"
      ),
      Scene.expect(Scene.testId("disabled")).not.toHaveHandler("click"),
      expectSent("fold:open,phase:fold,fold:open"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps its header one line: the title truncates and the tally keeps its slot", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("folded"),
        Scene.expect(Scene.text("Worked for 4m")).toHaveClass("truncate")
      ),
      Scene.inside(
        Scene.testId("folded"),
        Scene.expect(
          Scene.selector('[data-slot="disclosure-tally"]')
        ).toHaveClass("shrink-0")
      ),
      Scene.expect(Scene.testId("folded")).toHaveClass("min-h-9"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
