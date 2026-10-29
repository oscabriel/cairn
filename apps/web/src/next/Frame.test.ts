// Scene tests for the `next` frame: it draws every region it is handed, once, inside the wrapper
// the judges read (`#root`, the sidebar wrapper and inset slots, the sidebar state), marked
// `data-ui="next"`, over the same Model and update as the classic views.

import { assert, describe, it } from "@effect/vitest";
import type { HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import type { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { AppRoute } from "../Route.ts";
import { liveModel } from "../TestFixtures.ts";
import { update } from "../Update.ts";
import { view } from "./Frame.ts";
import { hooksOf } from "./Hooks.ts";

/** Stand-ins for the classic regions, each marked by its own test id. */
const stubbed = (model: Model, h: HtmlBuilder<Message>) =>
  view(model, h, {
    sidebarState: "expanded",
    sidebar: () => h.aside([h.DataAttribute("testid", "stub-sidebar")], []),
    notice: () => h.div([h.DataAttribute("testid", "stub-notice")], []),
    page: () => h.section([h.DataAttribute("testid", "stub-page")], []),
  });

describe("the next frame", () => {
  it("draws every region inside the judged wrapper, marked next", () => {
    Scene.scene(
      { update, view: stubbed },
      Scene.given({ ...liveModel(1), route: AppRoute.Settings() }),
      Scene.expect(Scene.testId("stub-sidebar")).toExist(),
      Scene.expect(Scene.testId("stub-notice")).toExist(),
      Scene.expect(Scene.testId("stub-page")).toExist(),
      Scene.expect(Scene.selector('[data-ui="next"]')).toHaveAttr(
        "data-route",
        "Settings"
      ),
      Scene.expect(Scene.selector("#root")).toHaveAttr(
        "data-sidebar-state",
        "expanded"
      ),
      Scene.tap(({ html }) => {
        assert.deepStrictEqual(hooksOf(html), [
          "data-sidebar-state",
          "data-slot=sidebar-inset",
          "data-slot=sidebar-wrapper",
          "data-testid=stub-notice",
          "data-testid=stub-page",
          "data-testid=stub-sidebar",
          "data-ui",
        ]);
      })
    );
  });
});
