// Scene tests for the connection mark: its word and its waiting tone while the socket is not live,
// and, while live, a visually hidden mark the judges can still wait on, its state read from
// `data-state` as `judges/reconnect.ts` and the durability page read it.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { ConnectionState } from "../connection/Reconnect.ts";
import { view } from "../Frame.ts";
import { hooksOf } from "../Hooks.ts";
import type { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { AppRoute } from "../Route.ts";
import { backingOff, liveModel } from "../TestFixtures.ts";
import { appOf, given } from "../ui/SceneFixture.ts";
import { update } from "../Update.ts";
import { connectionMark, connectionWord, LIVE_WORD } from "./ConnectionMark.ts";
import { initial as initialShell } from "./Model.ts";

const markIn = (state: ConnectionState) =>
  appOf((h) => [connectionMark(h, { epoch: 1, state })]);

const mark = Scene.testId("connection-state");

describe("the connection mark", () => {
  it.each([
    [ConnectionState.Connecting({ attempt: 0 }), "Connecting"],
    [ConnectionState.Backoff({ attempt: 2 }), "Reconnecting"],
    [ConnectionState.Connecting({ attempt: 2 }), "Reconnecting"],
    [ConnectionState.Syncing({ attempt: 0 }), "Catching up"],
  ] as const)("shows %j as %s, in the waiting tone", (state, word) => {
    Scene.scene(
      markIn(state),
      given,
      Scene.expect(mark).toHaveAttr("data-state", state._tag),
      Scene.expect(mark).toHaveAttr("role", "status"),
      Scene.expect(mark).toHaveText(word),
      Scene.expect(mark).not.toHaveClass("sr-only"),
      Scene.expect(Scene.selector('[data-glyph="busy"]')).toExist()
    );
    assert.deepStrictEqual(connectionWord(state), Option.some(word));
  });

  it("stays in the document, visually hidden, while live", () => {
    Scene.scene(
      markIn(ConnectionState.Live()),
      given,
      Scene.expect(mark).toHaveAttr("data-state", "Live"),
      Scene.expect(mark).toHaveClass("sr-only"),
      Scene.expect(mark).toHaveText(LIVE_WORD),
      Scene.expect(Scene.selector('[data-glyph="busy"]')).toBeAbsent()
    );
    assert.deepStrictEqual(
      connectionWord(ConnectionState.Live()),
      Option.none()
    );
  });
});

/** `model` on `route`, its shell told the same route, as the root's sync tells it. */
const onRoute = (model: Model, route: AppRoute): Model => ({
  ...model,
  route,
  nextShell: { ...initialShell, context: { ...initialShell.context, route } },
});

const frame = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    view(model, h, { notice: () => h.empty }),
};

const headerMark = Scene.selector(
  '[data-chat-header] [data-testid="connection-state"]'
);

describe("the shell's connection mark", () => {
  it.each([AppRoute.Hero(), AppRoute.Settings(), AppRoute.Usage()])(
    "is in the chat header on %j, live or not",
    (route) => {
      Scene.scene(
        frame,
        Scene.given(onRoute(liveModel(1), route)),
        Scene.expect(headerMark).toHaveAttr("data-state", "Live"),
        Scene.tap(({ html }) => {
          assert.include(hooksOf(html), "data-testid=connection-state");
        })
      );

      Scene.scene(
        frame,
        Scene.given(onRoute(backingOff(1, 2), route)),
        Scene.expect(headerMark).toHaveText("Reconnecting")
      );
    }
  );
});
