// Scene tests for the `next` sheet: in a pane it is a dialog named by its title, not modal, closed
// by its close button or a tap on its scrim, and with no close button when nothing closes it; over
// the page it is @foldkit/ui's dialog drawn as a sheet, modal, its scrim, title and close button the
// dialog's own, and nothing while the dialog is hidden; as a modal sheet its caller keeps whether
// it is open, focus moves to the control it names as its element mounts, and Escape, the scrim and
// Close come back as the caller's close while the dialog's other news changes nothing; as a column
// it is a named region, not modal. A bottom sheet on the phone; from `sm` or `md` its kind.

import { assert, describe, it } from "@effect/vitest";
import * as Dialog from "@foldkit/ui/dialog";
import type { RenderInfo } from "@foldkit/ui/dialog";
import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import type { Message } from "./SceneFixture.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import {
  dialogMessageTo,
  modalSheet,
  sheet,
  sheetClass,
  sheetDefaults,
  sheetToView,
  sideColumn,
} from "./Sheet.ts";

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
      ...sheetDefaults<Message>("criteria", "Criteria"),
      onClose: Option.some(sent("close")),
      attributes: [h.DataAttribute("testid", "closable")],
    },
    [h.p([], ["Body"])],
    [h.span([h.DataAttribute("testid", "action")], ["Done"])]
  ),
  sheet(
    h,
    {
      ...sheetDefaults<Message>("steps", "Steps"),
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
        {
          ...sheetDefaults<Message>("over", "Over the page"),
          role: "alertdialog",
          focusSelector: Option.none(),
          attributes: [h.DataAttribute("testid", "viewport-panel")],
        },
        [h.p([], ["Shown body"])],
        []
      )(render(true)),
    ]
  ),
  h.div(
    [h.DataAttribute("testid", "hidden")],
    [
      sheetToView(
        h,
        {
          ...sheetDefaults<Message>("hidden", "Hidden sheet"),
          role: "dialog",
          focusSelector: Option.none(),
        },
        [],
        []
      )(render(false)),
    ]
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
  it("draws @foldkit/ui's dialog as a fixed sheet with its role, title and close button", () => {
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
      Scene.inside(
        Scene.testId("shown"),
        Scene.expect(Scene.selector("dialog")).toHaveAttr("role", "alertdialog")
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

  it("is a bottom sheet on the phone; a panel floats from sm and docks from lg, a dialog is a card from md", () => {
    Scene.scene(
      appOf((h) => [
        h.div(
          [h.DataAttribute("testid", "panel"), h.Class(sheetClass("viewport"))],
          []
        ),
        h.div(
          [
            h.DataAttribute("testid", "dialog"),
            h.Class(sheetClass("viewport", "dialog")),
          ],
          []
        ),
        h.div(
          [
            h.DataAttribute("testid", "thread"),
            h.Class(sheetClass("viewport", "thread")),
          ],
          []
        ),
      ]),
      given,
      ...["panel", "dialog", "thread"].flatMap((kind) => [
        Scene.expect(Scene.testId(kind)).toHaveClass("bottom-0"),
        Scene.expect(Scene.testId(kind)).toHaveClass(
          "rounded-t-(--radius-large)"
        ),
      ]),
      Scene.expect(Scene.testId("panel")).toHaveClass("sm:top-(--space-3)"),
      Scene.expect(Scene.testId("panel")).toHaveClass("lg:right-0"),
      Scene.expect(Scene.testId("dialog")).toHaveClass("md:top-24"),
      Scene.expect(Scene.testId("dialog")).toHaveClass("md:max-w-lg"),
      Scene.expect(Scene.testId("thread")).toHaveClass("md:max-w-[45rem]"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

/** A caller that keeps whether its modal sheet is open, as the shell keeps its overlays'. */
interface Overlay {
  readonly isOpen: boolean;
  readonly sent: ReadonlyArray<string>;
}

const overlayApp = {
  update: (model: Overlay, message: Message) => ({
    model: {
      isOpen: message.what === "close" ? false : model.isOpen,
      sent: [...model.sent, message.what],
    },
  }),
  view: (model: Overlay, h: HtmlBuilder<Message>): Html =>
    h.div(
      [],
      [
        model.isOpen
          ? modalSheet(
              h,
              {
                ...sheetDefaults<Message>("rename", "Rename thread"),
                kind: "dialog",
                role: "dialog",
                focusSelector: Option.some("#rename-field"),
                onClose: sent("close"),
                onSettled: sent("settled"),
                attributes: [h.DataAttribute("testid", "modal-panel")],
              },
              [h.input([h.Id("rename-field")])],
              []
            )
          : h.empty,
        h.output([h.DataAttribute("testid", "sent")], [model.sent.join(",")]),
      ]
    ),
};

/** A modal sheet named and identified by `id`, with nothing in it. */
const plainModal = (h: HtmlBuilder<Message>, id: string): Html =>
  modalSheet(
    h,
    {
      ...sheetDefaults<Message>(id, id),
      kind: "dialog",
      role: "dialog",
      focusSelector: Option.none(),
      onClose: sent("close"),
      onSettled: sent("settled"),
    },
    [],
    []
  );

/** The keys of the `<dialog>` elements in `node`, in document order. */
const dialogKeys = (node: Html): ReadonlyArray<unknown> => {
  if (node === null) {
    return [];
  }

  const below = (node.children ?? []).flatMap((child) =>
    Predicate.isString(child) ? [] : dialogKeys(child)
  );

  return node.sel?.startsWith("dialog") === true ? [node.key, ...below] : below;
};

describe("the next sheet as a modal over the page", () => {
  it("takes the page as it mounts, focusing the control it names, and is a modal dialog named by its title", () => {
    Scene.scene(
      overlayApp,
      Scene.given<Overlay>({ isOpen: true, sent: [] }),
      Scene.Mount.expectHas(
        Dialog.AcquireResources({
          id: "rename",
          focusSelector: "#rename-field",
        })
      ),
      Scene.expect(Scene.selector("dialog#rename")).toHaveAttr(
        "aria-modal",
        "true"
      ),
      Scene.expect(Scene.selector("dialog#rename")).toHaveAttr(
        "aria-labelledby",
        "rename-dialog-title"
      ),
      Scene.expect(Scene.role("heading", { name: "Rename thread" })).toExist(),
      Scene.Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      expectSent("settled"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("closes from Close as its caller's close, and gives the page back as it leaves", () => {
    Scene.scene(
      overlayApp,
      Scene.given<Overlay>({ isOpen: true, sent: [] }),
      Scene.Mount.resolve(
        Dialog.AcquireResources,
        Dialog.Message.SucceededAcquireResources()
      ),
      Scene.inside(
        Scene.testId("modal-panel"),
        Scene.click(Scene.role("button", { name: "Close" }))
      ),
      Scene.expect(Scene.testId("modal-panel")).not.toExist(),
      Scene.Mount.expectEnded(Dialog.AcquireResources),
      expectSent("settled,close"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keys each dialog by its id, so one opened beside another is never patched into it", () => {
    // Two overlays drawn as siblings, the second opened while the first is open: unkeyed, the
    // renderer would patch the open dialog's element into the new one, whose Mount then never
    // runs, so it never takes the keyboard.
    Scene.scene(
      appOf((h) => [
        plainModal(h, "scratch-overlay"),
        plainModal(h, "add-project"),
      ]),
      given,
      Scene.tap(({ html }) => {
        assert.deepStrictEqual(dialogKeys(html), [
          "scratch-overlay",
          "add-project",
        ]);
      }),
      Scene.Mount.resolveAll(
        [Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()],
        [Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()]
      )
    );
  });

  it("maps Escape and the scrim to the caller's close, and every other dialog Message to nothing to keep", () => {
    const toCaller = dialogMessageTo(sent("close"), sent("settled"));

    assert.deepStrictEqual(
      [
        Dialog.Message.RequestedClose(),
        Dialog.Message.SucceededAcquireResources(),
        Dialog.Message.FailedAcquireResources(),
        Dialog.Message.Unmounted(),
        Dialog.Message.CompletedCloseDialog(),
      ].map((message) => toCaller(message).what),
      ["close", "settled", "settled", "settled", "settled"]
    );
  });
});

describe("the next sheet as a column", () => {
  it("is a named region beside the page, not modal, closed by its button", () => {
    Scene.scene(
      appOf((h) => [
        sideColumn(
          h,
          {
            ...sheetDefaults<Message>("work", "Work"),
            layout: "list",
            onClose: Option.some(sent("close")),
            attributes: [h.DataAttribute("testid", "column")],
          },
          [h.p([], ["Children"])],
          []
        ),
      ]),
      given,
      Scene.expect(Scene.role("complementary", { name: "Work" })).toExist(),
      Scene.expect(Scene.testId("column")).not.toHaveAttr("aria-modal"),
      Scene.expect(Scene.testId("column")).toHaveClass("w-[22rem]"),
      Scene.click(Scene.role("button", { name: "Close" })),
      expectSent("close"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
