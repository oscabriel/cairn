import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";
import { describe, expect, it } from "vitest";

import { diffStatLabel } from "./Card.ts";

type Message = never;

const view = (_model: null, h: HtmlBuilder<Message>): Html =>
  h.div([], [diffStatLabel(h, { additions: 12, deletions: 3 })]);

const config = { update: (model: null) => ({ model }), view };

describe("the changed-files card's line counts", () => {
  it("draws added lines in the done tone and removed lines in the failed tone", () => {
    Scene.scene(
      config,
      Scene.given(null),
      Scene.expect(Scene.selector(".text-tone-done")).toHaveText("+12"),
      Scene.expect(Scene.selector(".text-tone-failed")).toHaveText("−3"),
      Scene.expect(Scene.selector('[role="group"]')).toHaveAttr(
        "aria-label",
        "12 additions, 3 deletions"
      ),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });
});
