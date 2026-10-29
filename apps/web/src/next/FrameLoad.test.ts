// The `ui` client setting and the `next` views' chunk (ADR 0040, plan L0): `?ui=` in the address
// over the saved choice, the default classic, the chunk asked for once and only for `next`, and the
// classic views kept while it loads or after it failed.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { KeyValueStore } from "effect/persistence";

import {
  CLIENT_SETTINGS_STORAGE_KEY,
  DEFAULT_CLIENT_SETTINGS,
  chooseSetting,
  loadClientSettings,
  parseClientSettings,
  uiFromSearch,
  withSearchUi,
} from "../settings/ClientSettings.ts";
import {
  ApplyClientSettings,
  LoadNextFrame,
  SaveClientSettings,
} from "../settings/Command.ts";
import { Message } from "../settings/Message.ts";
import { initial } from "../settings/Model.ts";
import type { Model } from "../settings/Model.ts";
import { update } from "../settings/Update.ts";
import { liveModel } from "../TestFixtures.ts";
import { nextFrameOf } from "./FrameLoad.ts";

const NEXT = { ...DEFAULT_CLIENT_SETTINGS, ui: "next" as const };

const namesOf = (commands: ReadonlyArray<{ readonly name: string }> = []) =>
  commands.map((command) => command.name);

describe("the ui setting", () => {
  it("is classic by default and for a phase 1 saved value without it", () => {
    assert.strictEqual(DEFAULT_CLIENT_SETTINGS.ui, "classic");
    assert.strictEqual(
      parseClientSettings('{"theme":"dark","chatWidth":"wide"}').ui,
      "classic"
    );
    assert.strictEqual(parseClientSettings('{"ui":"next"}').ui, "next");
    // An unknown interface is a corrupt value: the defaults, as for any other field.
    assert.strictEqual(parseClientSettings('{"ui":"neon"}').ui, "classic");
  });

  it("reads ?ui=next and ?ui=classic from the address and ignores anything else", () => {
    assert.deepStrictEqual(uiFromSearch("?ui=next"), Option.some("next"));
    assert.deepStrictEqual(uiFromSearch("ui=classic"), Option.some("classic"));
    assert.deepStrictEqual(
      uiFromSearch("?minui=true&ui=next"),
      Option.some("next")
    );
    assert.deepStrictEqual(uiFromSearch(""), Option.none());
    assert.deepStrictEqual(uiFromSearch("?ui=neon"), Option.none());
    assert.deepStrictEqual(uiFromSearch("?ui="), Option.none());
  });

  it("lets the address override the saved choice, and keeps the same settings otherwise", () => {
    assert.strictEqual(
      withSearchUi(DEFAULT_CLIENT_SETTINGS, "?ui=next").ui,
      "next"
    );
    assert.strictEqual(withSearchUi(NEXT, "?ui=classic").ui, "classic");
    assert.strictEqual(withSearchUi(NEXT, ""), NEXT);
    assert.strictEqual(withSearchUi(NEXT, "?ui=next"), NEXT);
    assert.strictEqual(withSearchUi(NEXT, "?ui=neon"), NEXT);
  });

  it("is a choice a select can set", () => {
    assert.deepStrictEqual(
      Option.map(
        chooseSetting(DEFAULT_CLIENT_SETTINGS, "ui", "next"),
        (s) => s.ui
      ),
      Option.some("next")
    );
    assert.isTrue(
      Option.isNone(chooseSetting(DEFAULT_CLIENT_SETTINGS, "ui", "neon"))
    );
  });

  it.effect("round-trips through storage", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(CLIENT_SETTINGS_STORAGE_KEY, '{"ui":"next"}');

      const settings = yield* loadClientSettings;

      assert.strictEqual(settings.ui, "next");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("the next views' chunk", () => {
  it("is not asked for when the saved choice is classic", () => {
    const result = update(
      initial,
      Message.LoadedClientSettings({ settings: DEFAULT_CLIENT_SETTINGS })
    );

    assert.deepStrictEqual(namesOf(result.commands), [
      ApplyClientSettings.name,
    ]);
    assert.strictEqual(result.model.nextFrame, "idle");
  });

  it("is asked for once when the saved choice is next", () => {
    const result = update(
      initial,
      Message.LoadedClientSettings({ settings: NEXT })
    );

    assert.deepStrictEqual(namesOf(result.commands), [
      ApplyClientSettings.name,
      LoadNextFrame.name,
    ]);
    assert.strictEqual(result.model.nextFrame, "loading");

    // Choosing next again while it loads asks for nothing more.
    const again = update(
      { ...result.model, client: DEFAULT_CLIENT_SETTINGS },
      Message.SelectedClientSetting({ key: "ui", value: "next" })
    );

    assert.deepStrictEqual(namesOf(again.commands), [
      ApplyClientSettings.name,
      SaveClientSettings.name,
    ]);
  });

  it("is asked for when the settings page switches to next", () => {
    const result = update(
      { ...initial, clientLoaded: true },
      Message.SelectedClientSetting({ key: "ui", value: "next" })
    );

    assert.deepStrictEqual(namesOf(result.commands), [
      ApplyClientSettings.name,
      SaveClientSettings.name,
      LoadNextFrame.name,
    ]);
  });

  it("keeps the classic views and says so when it could not load", () => {
    const loading: Model = { ...initial, client: NEXT, nextFrame: "loading" };
    const failed = update(loading, Message.FailedNextFrame()).model;

    assert.strictEqual(failed.nextFrame, "failed");
    assert.isTrue(Option.isSome(failed.notice));
    assert.isTrue(
      Option.isNone(nextFrameOf({ ...liveModel(1), settings: failed }))
    );
  });

  it.effect(
    "draws with next only once loaded and while the setting is next",
    () =>
      Effect.gen(function* () {
        const loading: Model = {
          ...initial,
          client: NEXT,
          nextFrame: "loading",
        };

        // Still loading: classic.
        assert.isTrue(
          Option.isNone(nextFrameOf({ ...liveModel(1), settings: loading }))
        );

        const message = yield* LoadNextFrame().effect;

        assert.deepStrictEqual(message, Message.LoadedNextFrame());

        const loaded = update(loading, message).model;

        assert.strictEqual(loaded.nextFrame, "loaded");
        assert.isTrue(
          Option.isSome(nextFrameOf({ ...liveModel(1), settings: loaded }))
        );

        // Switched back to classic: the chunk stays loaded but classic draws.
        const back = update(
          loaded,
          Message.SelectedClientSetting({ key: "ui", value: "classic" })
        ).model;

        assert.isTrue(
          Option.isNone(nextFrameOf({ ...liveModel(1), settings: back }))
        );
      })
  );
});
