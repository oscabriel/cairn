// The guard: one global middleware every request passes, WebSocket upgrades included (GLOSSARY
// "Guard"). In order: the configured `Host` (421), the owner's login in Caddy's copied
// `X-Cairn-User` (403), the exact `Origin` on every non-safe method and every upgrade (403, because
// `Upgrade` is hop-by-hop and Caddy's auth subrequest never sees it), no cross-site request but a
// top-level page load, and none at all on `/api` (403). `/api` answers are `no-store` unless their
// route set a cache policy. `/api` is matched as the router reads it (any case, percent-decoded,
// repeated slashes collapsed), so `/API`, `//api` and `/%61pi` get the same rules (T23). Two
// loopback routes sit outside the host and identity rules: `/_cairn/auth` (Caddy's own subrequest,
// which carries the peer it judges) and `/_cairn/health` (which refuses anything that came through
// Caddy itself).
// The Origin rule is cairn-v1 `apps/server/src/Http.ts` at 1a5cd4a, line 54.

import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../Config.ts";
import { Identity } from "./Identity.ts";
import { pathnameOf } from "./Request.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths the guard lets through without the host and identity rules; each guards itself. */
const SELF_GUARDED = new Set(["/_cairn/auth", "/_cairn/health"]);

/** A percent-decoded path, or the path itself when its escapes are malformed. */
const decoded = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/** The path as the router matches it: percent-decoded, repeated slashes collapsed, any case. */
export const routedPath = (path: string) =>
  decoded(path)
    .replaceAll(/\/{2,}/gu, "/")
    .toLowerCase();

const isApiPath = (path: string) => {
  const routed = routedPath(path);

  return routed === "/api" || routed.startsWith("/api/");
};

/** A cross-site request that is not a top-level page load: a fetch, an embed or a frame. */
const isCrossSiteSubresource = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["sec-fetch-site"] === "cross-site" &&
  !(
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document"
  );

const refuse = (status: number, text: string) =>
  HttpServerResponse.text(`${text}\n`, {
    status,
    headers: { "cache-control": "no-store" },
  });

/** Whether the request asks to become a WebSocket. */
export const isUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/** The guard, as a global `HttpRouter` middleware. Needs `ServerConfig` and `Identity`. */
export const Guard = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const identity = yield* Identity;

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = pathnameOf(request.url);

        if (SELF_GUARDED.has(path) && request.method === "GET") {
          return yield* httpEffect;
        }

        if (request.headers.host !== config.host) {
          return refuse(421, "This server answers only for its own host.");
        }

        if (Option.isNone(identity.viewerOf(request))) {
          return refuse(
            403,
            "Cairn admits only its owner's devices on the tailnet."
          );
        }

        const upgrade = isUpgrade(request);

        if (
          (upgrade || !SAFE_METHODS.has(request.method)) &&
          request.headers.origin !== config.origin
        ) {
          return refuse(403, "Origin refused.");
        }

        const api = isApiPath(path);

        if (api && request.headers["sec-fetch-site"] === "cross-site") {
          return refuse(403, "Cross-site requests to the API are refused.");
        }

        if (isCrossSiteSubresource(request)) {
          return refuse(403, "Cross-site requests are refused.");
        }

        const response = yield* httpEffect;

        return api && response.headers["cache-control"] === undefined
          ? HttpServerResponse.setHeader(response, "cache-control", "no-store")
          : response;
      });
  }),
  { global: true }
);
