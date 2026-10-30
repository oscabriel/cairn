// The client's routes: the hero at `/`, a thread at `/t/<threadId>`, a new draft at
// `/new/<draftId>`, the settings page and the usage page (drawn by the `next` views only). Every link and navigation prints its path through these
// routers, so a path is written once.

import { ThreadId } from "@cairn/protocol/Ids";
import { pipe, Schema } from "effect";
import { Route } from "foldkit";
import type { Url } from "foldkit";
import {
  defineRouteUnion,
  literal,
  oneOf,
  parseUrlWithFallback,
  slash,
  string,
} from "foldkit/route";

/** Every page the client can show. Ids stay strings here; each page decodes its own. */
export const AppRoute = defineRouteUnion({
  Hero: {},
  Thread: { threadId: Schema.String },
  Draft: { draftId: Schema.String },
  Settings: {},
  Usage: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

/** `/`: the hero, with no thread open. */
export const heroRouter = pipe(Route.root, Route.mapTo(AppRoute.Hero));

/** `/t/<threadId>`: one thread. */
export const threadRouter = pipe(
  literal("t"),
  slash(string("threadId")),
  Route.mapTo(AppRoute.Thread)
);

/** `/new/<draftId>`: a thread not sent yet. */
export const draftRouter = pipe(
  literal("new"),
  slash(string("draftId")),
  Route.mapTo(AppRoute.Draft)
);

/** `/settings`. */
export const settingsRouter = pipe(
  literal("settings"),
  Route.mapTo(AppRoute.Settings)
);

/** `/usage`: what threads and workflows spent (the `next` views' foot links to it). */
export const usageRouter = pipe(literal("usage"), Route.mapTo(AppRoute.Usage));

const routeParser = oneOf(
  threadRouter,
  draftRouter,
  settingsRouter,
  usageRouter,
  heroRouter
);

const parseRoute = parseUrlWithFallback(routeParser, AppRoute.NotFound);

const isThreadId = Schema.is(ThreadId);

/**
 * The route a URL names; anything unknown is `NotFound`, and so is a thread path whose id is not a
 * thread id, which would otherwise load forever (T14).
 */
export const urlToAppRoute = (url: Url.Url): AppRoute => {
  const route = parseRoute(url);

  return AppRoute.match(route, {
    Thread: ({ threadId }) =>
      isThreadId(threadId) ? route : AppRoute.NotFound({ path: url.pathname }),
    Hero: () => route,
    Draft: () => route,
    Settings: () => route,
    Usage: () => route,
    NotFound: () => route,
  });
};
