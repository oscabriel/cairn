// Scene tests for the `next` card and banner: a card's rule takes its tone and its header carries
// the title and aside, the record lines pair labels with values in order, actions appear only when
// there are some; a banner is announced (an alert when failed), with its mark, words and actions.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { banner } from "./Banner.ts";
import { button, buttonDefaults } from "./Button.ts";
import { card, cardText, recordLines } from "./Card.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import type { Message } from "./SceneFixture.ts";

const app = appOf((h) => [
  card(
    h,
    {
      tone: "waiting",
      title: "Brief",
      aside: [h.span([h.DataAttribute("testid", "aside")], ["Go"])],
      body: [
        recordLines(h, [
          ["Role", "@worker"],
          ["Budget", "$2.00"],
        ]),
      ],
      actions: [
        button(
          h,
          {
            ...buttonDefaults<Message>(),
            variant: "primary",
            onClick: Option.some(sent("go")),
            attributes: [h.DataAttribute("testid", "go")],
          },
          ["Go"]
        ),
      ],
    },
    [h.DataAttribute("testid", "brief")]
  ),
  card(
    h,
    {
      tone: "neutral",
      title: "Note",
      aside: [],
      body: [cardText(h, "Only words.")],
      actions: [],
    },
    [h.DataAttribute("testid", "note")]
  ),
  banner(
    h,
    {
      tone: "failed",
      mark: Option.none(),
      title: "Run failed.",
      detail: Option.some("The provider refused the login."),
      actions: [],
    },
    [h.DataAttribute("testid", "failed")]
  ),
  banner(
    h,
    {
      tone: "waiting",
      mark: Option.some("warning"),
      title: "Parked.",
      detail: Option.none(),
      actions: [h.span([h.DataAttribute("testid", "retry")], ["Retry"])],
    },
    [h.DataAttribute("testid", "parked")]
  ),
]);

describe("the next card", () => {
  it("draws its tone's rule, its header and its actions", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("brief")).toHaveClass("border-l-tone-waiting"),
      Scene.expect(Scene.testId("brief")).toHaveAttr("data-tone", "waiting"),
      Scene.inside(
        Scene.testId("brief"),
        Scene.expect(Scene.role("heading", { name: "Brief" })).toExist(),
        Scene.expect(Scene.testId("aside")).toExist(),
        Scene.expect(Scene.selector("footer")).toExist()
      ),
      Scene.click(Scene.testId("go")),
      expectSent("go"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("pairs record labels with values in order, and has no footer without actions", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("brief"),
        Scene.expect(Scene.selector("dl")).toHaveText("Role@workerBudget$2.00")
      ),
      Scene.inside(
        Scene.testId("note"),
        Scene.expect(Scene.selector("footer")).not.toExist()
      ),
      Scene.expect(Scene.testId("note")).toHaveClass("border-l-stroke-2"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the next banner", () => {
  it("announces a failure as an alert, and any other hold as a status", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.testId("failed")).toHaveAttr("role", "alert"),
      Scene.expect(Scene.testId("parked")).toHaveAttr("role", "status"),
      Scene.expect(Scene.testId("failed")).toHaveText(
        "Run failed. The provider refused the login."
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows its tone's mark unless it names one, and its actions", () => {
    Scene.scene(
      app,
      given,
      Scene.inside(
        Scene.testId("failed"),
        Scene.expect(Scene.selector('[data-glyph="failed"]')).toExist()
      ),
      Scene.inside(
        Scene.testId("parked"),
        Scene.expect(Scene.selector('[data-glyph="warning"]')).toExist(),
        Scene.expect(Scene.testId("retry")).toExist()
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
