// Scene tests for the shell's overlays on the `next` sheet (U-12): over the page, the refresh
// confirm, the rename and remove dialog and the add-project picker are each a modal dialog named by
// its title (an alert dialog for what nothing undoes), which takes focus on the control it names as
// it mounts, whenever its chunk arrives, and whose Close, scrim and Escape come back as the
// overlay's own Cancel; the dialog's other news changes nothing.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import * as Dialog from "@foldkit/ui/dialog";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { addProjectPicker } from "./AddProject.ts";
import { manageDialog } from "./ManageDialog.ts";
import type { Message } from "./Message.ts";
import { FolderListing, ManageAction } from "./Model.ts";
import { refreshConfirm } from "./Refresh.ts";

/** What the scene keeps: the Messages the overlay sent, by tag. */
interface Sent {
  readonly sent: ReadonlyArray<string>;
}

const appOf = (draw: (h: HtmlBuilder<Message>) => Html) => ({
  update: (model: Sent, message: Message) => ({
    model: { sent: [...model.sent, message._tag] },
  }),
  view: (model: Sent, h: HtmlBuilder<Message>): Html =>
    h.div(
      [],
      [
        draw(h),
        h.output([h.DataAttribute("testid", "sent")], [model.sent.join(",")]),
      ]
    ),
});

const given = Scene.given<Sent>({ sent: [] });

const expectSent = (words: string) =>
  Scene.expect(Scene.testId("sent")).toHaveText(words);

const acquired = Scene.Mount.resolve(
  Dialog.AcquireResources,
  Dialog.Message.SucceededAcquireResources()
);

const PROJECT = ProjectId.make("prj_cairn");

/** The rename or remove dialog open on `action`, with the project's name typed. */
const open = (action: ManageAction) =>
  Option.some({
    action,
    text: "cairn",
    isSending: false,
    failure: Option.none(),
  });

describe("the shell's overlays over the page", () => {
  it("asks for a refresh in an alert dialog whose field takes focus, and cancels from Close and the scrim", () => {
    Scene.scene(
      appOf((h) =>
        refreshConfirm(
          h,
          Option.some({
            projectId: PROJECT,
            replaces: ThreadId.make("019a0000-0000-7000-8000-000000000001"),
            text: "",
            isSending: false,
            failure: Option.none(),
          }),
          "cairn",
          "viewport"
        )
      ),
      given,
      Scene.Mount.expectHas(
        Dialog.AcquireResources({
          id: "refresh-confirm",
          focusSelector: "#refresh-text",
        })
      ),
      Scene.expect(Scene.selector("dialog#refresh-confirm")).toHaveAttr(
        "role",
        "alertdialog"
      ),
      Scene.expect(Scene.selector("dialog#refresh-confirm")).toHaveAttr(
        "aria-modal",
        "true"
      ),
      Scene.expect(
        Scene.role("heading", { name: "Refresh cairn's project thread?" })
      ).toExist(),
      acquired,
      Scene.inside(
        Scene.testId("refresh-confirm"),
        Scene.click(Scene.role("button", { name: "Close" }))
      ),
      Scene.click(Scene.selector('[data-slot="sheet-scrim"]')),
      Scene.click(Scene.testId("refresh-confirm-cancel")),
      expectSent(
        "SettledOverlay,ClickedCancelRefresh,ClickedCancelRefresh,ClickedCancelRefresh"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("renames in a dialog whose name field takes focus, and removes in an alert dialog that focuses Cancel", () => {
    const names = { name: "cairn", folder: "/home/u/cairn" };

    Scene.scene(
      appOf((h) =>
        manageDialog(
          h,
          open(ManageAction.RenameProject({ projectId: PROJECT })),
          names,
          "viewport"
        )
      ),
      given,
      Scene.Mount.expectHas(
        Dialog.AcquireResources({
          id: "manage-dialog",
          focusSelector: "#manage-text",
        })
      ),
      Scene.expect(Scene.selector("dialog#manage-dialog")).toHaveAttr(
        "role",
        "dialog"
      ),
      acquired,
      Scene.inside(
        Scene.testId("manage-dialog"),
        Scene.click(Scene.role("button", { name: "Close" }))
      ),
      expectSent("SettledOverlay,ClickedCancelManage"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    Scene.scene(
      appOf((h) =>
        manageDialog(
          h,
          open(ManageAction.RemoveProject({ projectId: PROJECT })),
          names,
          "viewport"
        )
      ),
      given,
      Scene.Mount.expectHas(
        Dialog.AcquireResources({
          id: "manage-dialog",
          focusSelector: "#manage-text-cancel",
        })
      ),
      Scene.expect(Scene.selector("dialog#manage-dialog")).toHaveAttr(
        "role",
        "alertdialog"
      ),
      acquired,
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("picks a folder in a dialog that focuses its first control, not its field, and lists folders as rows", () => {
    Scene.scene(
      appOf((h) =>
        addProjectPicker(
          h,
          Option.some({
            folder: "",
            listing: FolderListing.Loaded({
              result: {
                path: "/home/u",
                parent: Option.none(),
                entries: [
                  { name: "cairn", path: "/home/u/cairn", isGitRepo: true },
                ],
              },
            }),
            request: 1,
            home: Option.some("/home/u"),
            adding: Option.none(),
            failure: Option.none(),
          }),
          "viewport"
        )
      ),
      given,
      Scene.Mount.expectHas(
        Dialog.AcquireResources({
          id: "add-project",
          focusSelector: "[data-foldkit-dialog-initial-focus]",
        })
      ),
      Scene.expect(Scene.role("heading", { name: "Add project" })).toExist(),
      Scene.expect(Scene.selector('[data-slot="row"]')).toExist(),
      acquired,
      Scene.click(Scene.testId("add-project-entry")),
      Scene.click(Scene.selector('[data-slot="sheet-scrim"]')),
      expectSent("SettledOverlay,ClickedBrowseFolder,ClickedCancelAddProject"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
