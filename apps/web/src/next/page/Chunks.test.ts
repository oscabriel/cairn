// The views a cold load never draws, fetched as chunks (W-8, ADR 0021): which views are wanted,
// each chunk asked for once, a failure told and tried again, a late picker given its focus, and the
// frame drawing a page only once its chunk is in. `Budget.test.ts` judges that they are chunks.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { Popover } from "../../composer/Model.ts";
import { Message } from "../../Message.ts";
import type { Model } from "../../Model.ts";
import { AppRoute } from "../../Route.ts";
import { liveModel } from "../../TestFixtures.ts";
import { update } from "../../Update.ts";
import { view } from "../Frame.ts";
import { initial as initialShell, initialWork } from "../shell/Model.ts";
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
    // While the popover stays open the failure stands: nothing refetches on every update.
    assert.isTrue(Chunks.isServed(failed.model, ["popovers"]));

    const closed = Chunks.want(failed.model, []);

    assert.strictEqual(closed.model.popovers, "idle");

    const reopened = Chunks.want(closed.model, ["popovers"]);

    assert.strictEqual(reopened.model.popovers, "loading");
    assert.deepStrictEqual(namesOf(reopened.commands), ["LoadChunk"]);
  });

  it("puts the keyboard in a picker's field when its chunk arrives after it opened", () => {
    const arrived = Chunks.update(
      Chunks.want(Chunks.initial, ["addProject"]).model,
      Chunks.Message.LoadedChunk({ chunk: "addProject" })
    );

    assert.strictEqual(arrived.model.addProject, "loaded");
    assert.deepStrictEqual(namesOf(arrived.commands), ["FocusOnArrival"]);
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
