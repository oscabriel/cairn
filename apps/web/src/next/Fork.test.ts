// The fork behind the root view (ADR 0040, plan L0): the same Model drawn by the root view with the
// `ui` setting classic and next. Classic carries no `next` mark; next draws the `next` frame once
// its chunk has loaded, and keeps every hook the classic views show on each route, so the judges
// that read them run on both.

import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Option, Predicate } from "effect";
import type { Html } from "foldkit/html";

// Foldkit's own lazy test harness renders this way; neither is in its public entrypoints.
import {
  __clearRuntime,
  __htmlBuilder,
  __setRuntime,
} from "../../node_modules/foldkit/dist/html/index.js";
import type { Model } from "../Model.ts";
import { AppRoute } from "../Route.ts";
import { DEFAULT_CLIENT_SETTINGS } from "../settings/ClientSettings.ts";
import { emptySnapshot, liveModel } from "../TestFixtures.ts";
import { view } from "../View.ts";
import { fetchNextFrame } from "./FrameLoad.ts";
import { hooksOf } from "./Hooks.ts";

const ROUTES = [
  AppRoute.Hero(),
  AppRoute.Draft({ draftId: "d1" }),
  AppRoute.Thread({ threadId: "01890a5d-ac96-774b-bcce-b302099a0001" }),
  AppRoute.Settings(),
  AppRoute.NotFound({ path: "/nowhere" }),
];

const withUi = (
  route: AppRoute,
  ui: "classic" | "next",
  nextFrame: Model["settings"]["nextFrame"]
): Model => {
  const live = liveModel(1);

  return {
    ...live,
    route,
    shell: Option.some(emptySnapshot),
    // The root's sync tells the shell the route and the shell on every update.
    nextShell: {
      ...live.nextShell,
      context: {
        ...live.nextShell.context,
        route,
        shell: Option.some(emptySnapshot),
      },
    },
    settings: {
      ...live.settings,
      clientLoaded: true,
      client: { ...DEFAULT_CLIENT_SETTINGS, ui },
      nextFrame,
    },
  };
};

const dispatch = () => {
  // The renders are inspected, not clicked.
};

/** The root view's body for `model`, rendered once as the runtime does. */
const render = (model: Model): Html => {
  __setRuntime(dispatch, Context.empty());

  try {
    return view(model, __htmlBuilder()).body;
  } finally {
    __clearRuntime();
  }
};

/**
 * The root view's hooks for `model`, those outside its sidebar (the wrapper and the page beside
 * it), and whether it drew the `next` frame. The classic sidebar is the body's first child; `next`
 * draws its own shell there (L6), whose hooks `behaviour.ts`'s shell checks judge.
 */
const drawn = (model: Model) => {
  const body = render(model);

  if (body === null) {
    throw new Error("The root view drew nothing.");
  }

  const [, ...rest] = body.children ?? [];

  const outside = rest.flatMap((child) =>
    Predicate.isString(child) ? [] : hooksOf(child)
  );

  return {
    hooks: hooksOf(body),
    outsideSidebar: [
      ...new Set([...outside, ...hooksOf({ ...body, children: [] })]),
    ],
    next: body.data?.attrs?.["data-ui"] === "next",
  };
};

describe("the fork behind the root view", () => {
  it.effect(
    "draws next, with every classic hook outside the sidebar, once the chunk has loaded",
    () =>
      Effect.gen(function* () {
        yield* fetchNextFrame;

        for (const route of ROUTES) {
          const classic = drawn(withUi(route, "classic", "loaded"));
          const next = drawn(withUi(route, "next", "loaded"));

          assert.isFalse(classic.next, `${route._tag}: classic is unmarked`);
          assert.isTrue(next.next, `${route._tag}: next draws the next frame`);
          assert.notInclude(classic.hooks, "data-ui", route._tag);
          assert.isAbove(classic.hooks.length, 3, route._tag);
          assert.deepStrictEqual(
            classic.outsideSidebar.filter((hook) => !next.hooks.includes(hook)),
            [],
            `${route._tag}: next keeps the classic hooks outside the sidebar`
          );
        }
      })
  );

  it.effect("draws classic while the chunk loads and after it failed", () =>
    Effect.gen(function* () {
      yield* fetchNextFrame;

      for (const nextFrame of ["idle", "loading", "failed"] as const) {
        assert.isFalse(
          drawn(withUi(AppRoute.Hero(), "next", nextFrame)).next,
          nextFrame
        );
      }
    })
  );
});
