// Scene tests for the look catalogue: it opens in the theme its address names (dark otherwise),
// its switch changes it, it offers no look switch (one look, Stone revised), it has a section for
// every primitive, its live specimens work (a toggle chip, the field, the disclosures, and the sheet
// over the page through @foldkit/ui's dialog), and every state has a name a judge can point at.

import { assert, describe, it } from "@effect/vitest";
import * as Dialog from "@foldkit/ui/dialog";
import { Option } from "effect";
import { Mount } from "foldkit";
import * as Scene from "foldkit/scene";

import { Message as AttachmentsMessage } from "../../../attachments/Message.ts";
import { AttachmentPaste } from "../../../attachments/Paste.ts";
import { ComposerInput } from "../../../composer/Editor.ts";
import { MeasureFooter } from "../../../composer/Footer.ts";
import { Message as ComposerMessage } from "../../../composer/Message.ts";
import { initialOf, update, view } from "./Catalogue.ts";

/** One composer's Mounts, acknowledged as the browser would run them. */
const composerMounts = [
  Scene.Mount.resolve(ComposerInput, ComposerMessage.BlurredEditor()),
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
      width: 640,
      hostWidth: 640,
      measurement: {
        gap: 4,
        naturalFixedWidth: 169,
        minimumFixedWidth: 52,
        blockWidths: [124, 139],
        iconOnlyBlockWidths: Option.some([63, 63]),
        overflowWidth: 38,
      },
    })
  ),
];

/** The Mounts of the scratch overlay's two specimens, each with the real composer (U-16). */
const acknowledgeMounts = [...composerMounts, ...composerMounts];

const PRIMITIVES = [
  "button",
  "icon-button",
  "chip",
  "status-chip",
  "glyph",
  "row",
  "menu",
  "card",
  "sheet",
  "disclosure",
  "tooltip",
  "field",
  "banner",
  "kbd",
  "meter",
];

describe("the look catalogue", () => {
  it("opens in the theme its address names, else dark", () => {
    assert.include(initialOf("?theme=light"), { theme: "light" });
    assert.include(initialOf(""), { theme: "dark" });
    assert.include(initialOf("?theme=dim"), { theme: "dark" });
    assert.notProperty(initialOf("?look=stone&theme=light"), "look");
  });

  it("switches theme by the dark class, and has no look switch", () => {
    Scene.scene(
      { update, view },
      Scene.given(initialOf("")),
      ...acknowledgeMounts,
      Scene.expect(Scene.selector('[data-ui="next"]')).not.toHaveAttr(
        "data-look"
      ),
      Scene.expect(
        Scene.selector('[role="group"][aria-label="Look"]')
      ).not.toExist(),
      Scene.expect(Scene.selector("[data-look-catalogue]")).toHaveClass("dark"),
      Scene.click(Scene.testId("look-theme-light")),
      Scene.expect(Scene.selector('[data-ui="next"]')).toHaveAttr(
        "data-theme",
        "light"
      ),
      Scene.expect(Scene.selector("[data-look-catalogue]")).not.toHaveClass(
        "dark"
      ),
      Scene.expect(Scene.testId("look-theme-light")).toHaveAttr(
        "aria-pressed",
        "true"
      ),
      Scene.expect(Scene.testId("look-theme-dark")).toHaveAttr(
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
      ...acknowledgeMounts,
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
      ...acknowledgeMounts,
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
      ...acknowledgeMounts,
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
