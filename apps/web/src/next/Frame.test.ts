// Scene tests for the `next` frame: it draws the regions a page needs, once, inside the wrapper the
// judges read (`#root`, the sidebar wrapper and inset slots, the sidebar state), marked
// `data-ui="next"`, over the same Model and update as the classic views. Since L6 the sidebar is
// `next`'s own shell, so the classic sidebar region is never drawn.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { Mount } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { Message as AttachmentsMessage } from "../attachments/Message.ts";
import { AttachmentPaste } from "../attachments/Paste.ts";
import { ComposerInput } from "../composer/Editor.ts";
import { MeasureFooter } from "../composer/Footer.ts";
import { Message as ComposerMessage } from "../composer/Message.ts";
import type { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { AppRoute } from "../Route.ts";
import { liveModel } from "../TestFixtures.ts";
import { Message as ListMessage } from "../timeline/list/Message.ts";
import { ObserveList } from "../timeline/list/Place.ts";
import { update } from "../Update.ts";
import { view } from "./Frame.ts";
import { hooksOf } from "./Hooks.ts";
import { LoadScratch } from "./shell/Command.ts";
import { Message as ShellMessage } from "./shell/Message.ts";
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

/**
 * Stand-ins for the classic regions, each marked by its own test id. Since look track L7 the frame
 * draws only the notice bar from them; the page, the thread, its controls and the composer are its
 * own, so their stand-ins must never show.
 */
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
  it("draws its own page inside the judged wrapper, marked next, with its own shell", () => {
    Scene.scene(
      { update, view: stubbed },
      Scene.given(onRoute(AppRoute.Settings())),
      Scene.expect(Scene.testId("stub-sidebar")).toBeAbsent(),
      Scene.expect(Scene.testId("stub-notice")).toExist(),
      // The page is next's own (look track L7), not the classic region.
      Scene.expect(Scene.testId("stub-page")).toBeAbsent(),
      Scene.expect(Scene.testId("settings-page")).toExist(),
      Scene.expect(Scene.role("combobox", { name: "Views" })).toExist(),
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
          "data-testid=settings-page",
          "data-ui",
        ]) {
          assert.include(hooks, hook);
        }
      })
    );
  });

  it("draws a thread's transcript and its diff toggle under the new header, its own and not classic's", () => {
    Scene.scene(
      { update, view: stubbed },
      Scene.given(
        onRoute(
          AppRoute.Thread({ threadId: "01890a5d-ac96-774b-bcce-b302099a8057" })
        )
      ),
      // The transcript's measured list watches its scroller once drawn.
      Scene.Mount.resolve(ObserveList, ListMessage.SettledScroll()),
      // That first update is the shell's first too: it reads this device's scratch thread.
      Scene.Command.resolve(
        LoadScratch,
        ShellMessage.LoadedScratch({ threadId: Option.none() })
      ),
      // Then the composer docks under the transcript.
      Scene.Mount.resolve(ComposerInput, ComposerMessage.FocusedEditor()),
      Scene.Mount.resolve(
        Mount.mapMessage(AttachmentPaste(), (message: AttachmentsMessage) =>
          ComposerMessage.GotAttachmentsMessage({ message })
        ),
        ComposerMessage.GotAttachmentsMessage({
          message: AttachmentsMessage.ClickedDismissNotice(),
        })
      ),
      Scene.Mount.resolve(
        MeasureFooter,
        ComposerMessage.MeasuredFooter({
          width: 900,
          hostWidth: 634,
          measurement: {
            gap: 4,
            naturalFixedWidth: 169,
            minimumFixedWidth: 52,
            blockWidths: [124, 140],
            iconOnlyBlockWidths: Option.some([63, 63]),
            overflowWidth: 38,
          },
        })
      ),
      Scene.expect(Scene.testId("composer-send")).toHaveClass("bg-accent-fill"),
      Scene.expect(Scene.testId("next-chat-header")).toExist(),
      Scene.expect(Scene.testId("thread-page")).toExist(),
      Scene.expect(Scene.testId("diff-toggle")).toHaveClass(
        "pointer-coarse:min-h-(--hit-target)"
      ),
      Scene.expect(Scene.testId("stub-thread")).toBeAbsent(),
      Scene.expect(Scene.testId("stub-controls")).toBeAbsent(),
      Scene.expect(Scene.testId("stub-composer")).toBeAbsent(),
      Scene.expect(Scene.testId("stub-page")).toBeAbsent(),
      Scene.tap(({ html }) => {
        assert.include(hooksOf(html), "data-chat-column");
      })
    );
  });
});
