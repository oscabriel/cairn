// The views a cold load never draws, fetched as chunks (W-8, ADR 0021): which views are wanted,
// each chunk asked for once, a failure told and tried again, a late picker given its focus, and the
// frame drawing a page only once its chunk is in. `Budget.test.ts` judges that they are chunks.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Url } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { Popover } from "../composer/Model.ts";
import { view } from "../Frame.ts";
import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { AppRoute } from "../Route.ts";
import {
  FolderListing,
  initial as initialShell,
  initialWork,
  ManageAction,
} from "../shell/Model.ts";
import { MYR, PROJECT_THREAD } from "../shell/ShellFixtures.ts";
import { liveModel } from "../TestFixtures.ts";
import { update } from "../Update.ts";
import * as Chunks from "./Chunks.ts";

const namesOf = (commands: ReadonlyArray<{ readonly name: string }> = []) =>
  commands.map((command) => command.name);

/** A live page on `route`, its shell told the same route, as the root's sync tells it. */
const onRoute = (route: AppRoute): Model => ({
  ...liveModel(1),
  route,
  nextShell: { ...initialShell, context: { ...initialShell.context, route } },
});

const frame = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    view(model, h, { notice: () => h.empty }),
};

describe("the chunks a cold load never draws", () => {
  it("wants a view's chunk only while the page draws it", () => {
    const thread = onRoute(AppRoute.Thread({ threadId: "thread-1" }));

    assert.deepStrictEqual(Chunks.wantedChunks(thread), []);
    assert.deepStrictEqual(Chunks.wantedChunks(onRoute(AppRoute.Settings())), [
      "settings",
    ]);
    assert.deepStrictEqual(Chunks.wantedChunks(onRoute(AppRoute.Usage())), [
      "usage",
    ]);
    assert.deepStrictEqual(
      Chunks.wantedChunks({
        ...thread,
        composer: {
          ...thread.composer,
          popover: Option.some(
            Popover.ModelPicker({
              query: "",
              highlighted: Option.none(),
              provider: Option.none(),
            })
          ),
        },
        nextShell: {
          ...thread.nextShell,
          work: { ...initialWork, isOpen: true },
        },
      }),
      ["popovers", "workPanel"]
    );
  });

  it("asks for a wanted chunk once, and takes one the warm-up brought in as in", () => {
    const asked = Chunks.want(Chunks.initial, ["settings"]);

    assert.strictEqual(asked.model.settings, "loading");
    assert.deepStrictEqual(namesOf(asked.commands), ["LoadChunk"]);
    assert.isTrue(Chunks.isServed(asked.model, ["settings"]));

    const warmed = Chunks.update(
      asked.model,
      Chunks.Message.WarmedChunks({ chunks: ["settings", "usage"] })
    );

    // The settings fetch on its way answers for itself, and focuses what its view opens with.
    assert.strictEqual(warmed.model.settings, "loading");
    assert.strictEqual(warmed.model.usage, "loaded");
    assert.deepStrictEqual(namesOf(warmed.commands), []);
  });

  it("tells the root when a wanted chunk fails, and asks again when its view is next wanted", () => {
    const failed = Chunks.update(
      Chunks.want(Chunks.initial, ["popovers"]).model,
      Chunks.Message.FailedChunk({ chunk: "popovers" })
    );

    assert.strictEqual(failed.model.popovers, "failed");
    assert.deepStrictEqual(
      failed.outMessage,
      Chunks.OutMessage.FailedChunk({ chunk: "popovers" })
    );
    // While the chunk is wanted the failure stands, so nothing refetches on every update; the root
    // closes the view that waited (below), which puts it back to idle.
    assert.isTrue(Chunks.isServed(failed.model, ["popovers"]));

    const closed = Chunks.want(failed.model, []);

    assert.strictEqual(closed.model.popovers, "idle");

    const reopened = Chunks.want(closed.model, ["popovers"]);

    assert.strictEqual(reopened.model.popovers, "loading");
    assert.deepStrictEqual(namesOf(reopened.commands), ["LoadChunk"]);
  });

  it("puts the keyboard in a popover's search when its chunk arrives after it opened, and leaves an overlay's focus to its dialog", () => {
    const arrived = Chunks.update(
      Chunks.want(Chunks.initial, ["popovers"]).model,
      Chunks.Message.LoadedChunk({ chunk: "popovers" })
    );

    assert.strictEqual(arrived.model.popovers, "loaded");
    assert.deepStrictEqual(namesOf(arrived.commands), ["FocusOnArrival"]);

    // An overlay is a dialog that takes focus as it mounts, whenever its chunk arrives, and gives
    // it back on close; a focus from here would become the place focus goes back to (U-12).
    for (const chunk of [
      "addProject",
      "refresh",
      "manageDialog",
      "workPanel",
      "goalPanel",
    ] as const) {
      const overlay = Chunks.update(
        Chunks.want(Chunks.initial, [chunk]).model,
        Chunks.Message.LoadedChunk({ chunk })
      );

      assert.deepStrictEqual(namesOf(overlay.commands), [], chunk);
    }
  });

  it("asks for the settings page's chunk when the route opens it, and says so when it fails", () => {
    const opened = update(onRoute(AppRoute.Settings()), Message.WokeUp());

    assert.strictEqual(opened.model.chunks.settings, "loading");
    assert.include(namesOf(opened.commands), "LoadChunk");

    const failed = update(
      opened.model,
      Message.GotChunkMessage({
        message: Chunks.Message.FailedChunk({ chunk: "settings" }),
      })
    );

    assert.deepStrictEqual(
      failed.model.notice,
      Option.some(Chunks.failureNotice("settings"))
    );
  });

  // A view whose chunk failed is closed, so its control's next tap opens it again and asks again:
  // a touch screen has no Escape, and Cancel is inside the view that never drew (W-8 review).
  it.each<[Chunks.ChunkName, (model: Model) => Model]>([
    [
      "refresh",
      (model) => ({
        ...model,
        nextShell: {
          ...model.nextShell,
          refresh: Option.some({
            projectId: MYR,
            replaces: PROJECT_THREAD,
            text: "",
            isSending: false,
            failure: Option.none(),
          }),
        },
      }),
    ],
    [
      "addProject",
      (model) => ({
        ...model,
        nextShell: {
          ...model.nextShell,
          addProject: Option.some({
            folder: "",
            listing: FolderListing.Loading({ path: Option.none() }),
            request: 1,
            home: Option.none(),
            adding: Option.none(),
            failure: Option.none(),
          }),
        },
      }),
    ],
    [
      "manageDialog",
      (model) => ({
        ...model,
        nextShell: {
          ...model.nextShell,
          manage: Option.some({
            action: ManageAction.RenameProject({ projectId: MYR }),
            text: "",
            isSending: false,
            failure: Option.none(),
          }),
        },
      }),
    ],
    [
      "popovers",
      (model) => ({
        ...model,
        composer: {
          ...model.composer,
          popover: Option.some(
            Popover.ModelPicker({
              query: "",
              highlighted: Option.none(),
              provider: Option.none(),
            })
          ),
        },
      }),
    ],
    [
      "workPanel",
      (model) => ({
        ...model,
        nextShell: {
          ...model.nextShell,
          work: { ...model.nextShell.work, isOpen: true },
        },
      }),
    ],
    [
      "goalPanel",
      (model) => ({
        ...model,
        nextShell: {
          ...model.nextShell,
          goal: { ...model.nextShell.goal, isOpen: true },
        },
      }),
    ],
  ])(
    "closes the %s view when its chunk fails, so the next open asks again",
    (chunk, open) => {
      const opened = update(
        open(onRoute(AppRoute.Thread({ threadId: "thread-1" }))),
        Message.WokeUp()
      );

      assert.strictEqual(opened.model.chunks[chunk], "loading");

      const failed = update(
        opened.model,
        Message.GotChunkMessage({
          message: Chunks.Message.FailedChunk({ chunk }),
        })
      );

      assert.deepStrictEqual(Chunks.wantedChunks(failed.model), []);
      assert.strictEqual(failed.model.chunks[chunk], "idle");
      assert.deepStrictEqual(
        failed.model.notice,
        Option.some(Chunks.failureNotice(chunk))
      );

      const reopened = update(open(failed.model), Message.WokeUp());

      assert.strictEqual(reopened.model.chunks[chunk], "loading");
      assert.include(namesOf(reopened.commands), "LoadChunk");
    }
  );

  it("asks again for a page's chunk that failed when the page is opened again", () => {
    const opened = update(onRoute(AppRoute.Settings()), Message.WokeUp());

    const failed = update(
      opened.model,
      Message.GotChunkMessage({
        message: Chunks.Message.FailedChunk({ chunk: "settings" }),
      })
    );

    assert.strictEqual(failed.model.chunks.settings, "failed");
    assert.notInclude(
      namesOf(update(failed.model, Message.WokeUp()).commands),
      "LoadChunk"
    );

    const again = update(
      failed.model,
      Message.ChangedUrl({
        url: Option.getOrThrow(
          Url.fromString("https://code.gneiss.run/settings")
        ),
      })
    );

    assert.strictEqual(again.model.chunks.settings, "loading");
    assert.include(namesOf(again.commands), "LoadChunk");
  });

  it("tells the user to open the view again, not to reload", () => {
    for (const chunk of Chunks.CHUNKS) {
      assert.notInclude(Chunks.failureNotice(chunk), "Reload");
    }
  });

  it.effect("draws the usage page only once its chunk is in", () =>
    Effect.gen(function* () {
      const usagePage = Scene.testId("usage-page");

      Scene.scene(
        frame,
        Scene.given(onRoute(AppRoute.Usage())),
        Scene.expect(Scene.testId("shell-rail")).toExist(),
        Scene.expect(usagePage).toBeAbsent()
      );

      yield* Chunks.fetchChunk("usage");

      Scene.scene(
        frame,
        Scene.given(onRoute(AppRoute.Usage())),
        Scene.expect(usagePage).toExist()
      );
    })
  );
});
