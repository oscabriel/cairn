// The client's routes: the inbox at `/`, a thread at `/t/<threadId>`, a new draft at
// `/new/<draftId>` and the settings page. Every link and navigation prints its path through these
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
  Inbox: {},
  Thread: { threadId: Schema.String },
  Draft: { draftId: Schema.String },
  Settings: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

/** `/`: the inbox with no thread open. */
export const inboxRouter = pipe(Route.root, Route.mapTo(AppRoute.Inbox));

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

const routeParser = oneOf(
  threadRouter,
  draftRouter,
  settingsRouter,
  inboxRouter
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
    Inbox: () => route,
    Draft: () => route,
    Settings: () => route,
    NotFound: () => route,
  });
};
