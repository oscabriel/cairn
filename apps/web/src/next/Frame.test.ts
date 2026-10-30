// Scene tests for the `next` frame: it draws the regions a page needs, once, inside the wrapper the
// judges read (`#root`, the sidebar wrapper and inset slots, the sidebar state), marked
// `data-ui="next"`, over the same Model and update as the classic views. Since L6 the sidebar is
// `next`'s own shell, so the classic sidebar region is never drawn.

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
import { initial as initialShell } from "./shell/Model.ts";

/** A live page on `route`, its shell told the same route, as the root's sync tells it. */
const onRoute = (route: AppRoute): Model => ({
  ...liveModel(1),
  route,
  nextShell: {
    ...initialShell,
    context: { ...initialShell.context, route },
  },
});

/** Stand-ins for the classic regions, each marked by its own test id. */
const stubbed = (model: Model, h: HtmlBuilder<Message>) =>
  view(model, h, {
    sidebarState: "expanded",
    sidebar: () => h.aside([h.DataAttribute("testid", "stub-sidebar")], []),
    notice: () => h.div([h.DataAttribute("testid", "stub-notice")], []),
    page: () => h.section([h.DataAttribute("testid", "stub-page")], []),
    thread: () => h.section([h.DataAttribute("testid", "stub-thread")], []),
    threadControls: () =>
      h.span([h.DataAttribute("testid", "stub-controls")], []),
    composer: () => h.form([h.DataAttribute("testid", "stub-composer")], []),
  });

describe("the next frame", () => {
  it("draws a page's regions inside the judged wrapper, marked next, with its own shell", () => {
    Scene.scene(
      { update, view: stubbed },
      Scene.given(onRoute(AppRoute.Settings())),
      Scene.expect(Scene.testId("stub-sidebar")).toBeAbsent(),
      Scene.expect(Scene.testId("stub-notice")).toExist(),
      Scene.expect(Scene.testId("stub-page")).toExist(),
      Scene.expect(Scene.testId("stub-thread")).toBeAbsent(),
      Scene.expect(Scene.testId("shell-rail")).toExist(),
      Scene.expect(Scene.selector('[data-ui="next"]')).toHaveAttr(
        "data-route",
        "Settings"
      ),
      Scene.expect(Scene.selector("#root")).toHaveAttr(
        "data-sidebar-state",
        "expanded"
      ),
      Scene.tap(({ html }) => {
        const hooks = hooksOf(html);

        for (const hook of [
          "data-sidebar-state",
          "data-slot=sidebar-inset",
          "data-slot=sidebar-wrapper",
          "data-chat-header",
          "data-testid=stub-notice",
          "data-testid=stub-page",
          "data-ui",
        ]) {
          assert.include(hooks, hook);
        }
      })
    );
  });

  it("draws a thread's transcript, controls and composer under the new header", () => {
    Scene.scene(
      { update, view: stubbed },
      Scene.given(
        onRoute(
          AppRoute.Thread({ threadId: "01890a5d-ac96-774b-bcce-b302099a8057" })
        )
      ),
      Scene.expect(Scene.testId("next-chat-header")).toExist(),
      Scene.expect(Scene.testId("stub-thread")).toExist(),
      Scene.expect(Scene.testId("stub-controls")).toExist(),
      Scene.expect(Scene.testId("stub-composer")).toExist(),
      Scene.expect(Scene.testId("stub-page")).toBeAbsent(),
      Scene.tap(({ html }) => {
        assert.include(hooksOf(html), "data-chat-column");
      })
    );
  });
});
