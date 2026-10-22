// The page and its files from the web build. Hashed `/assets/*` are cached for a year (a new build
// means new names); everything else (index.html, sw.js, the manifest, icons) is `no-cache`, so a
// deploy shows on the next load. A path with no extension whose request accepts HTML (a reload on
// `/t/<id>`) gets the page and the client routes it; `/api`, `/ws`, `/_cairn` and `/oauth` never fall
// back to the page, and a miss under `/api` is a JSON 404. The page carries the boot JSON a
// `BootJson` layer renders (none until the load package provides one, plan D46).
// Static routes and the Content-Security-Policy are ported from cairn-v1 `apps/server/src/Http.ts`
// at 1a5cd4a; the passkey and artifact paths are gone and the boot JSON hook is new.
import path from "node:path";

import { Context, Effect, FileSystem, Layer, Option } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";

import { ServerConfig } from "../Config.ts";

/** Renders the JSON the page reads before its socket opens; `None` injects nothing. */
export class BootJson extends Context.Service<
  BootJson,
  {
    /** The boot data as JSON text, rendered for one page load. */
    readonly render: Effect.Effect<Option.Option<string>>;
  }
>()("cairn/server/http/Static/BootJson") {
  /** Injects nothing: the page fetches everything over the socket. */
  static readonly layerNone = Layer.succeed(
    BootJson,
    BootJson.of({ render: Effect.succeedNone })
  );
}

/** The id of the script element carrying the boot JSON. */
export const BOOT_JSON_ELEMENT_ID = "cairn-boot";

/**
 * The page's Content-Security-Policy. Scripts, styles, fonts and workers come only from Cairn
 * itself and nothing inline runs (the boot JSON is `application/json`, which is data, not script).
 * Foldkit and shiki set inline styles through the CSSOM, which CSP does not govern. Images may be
 * Cairn's own files, composer thumbnails (blob:) and user images (data:). The socket is
 * same-origin; the ws: source is named too, for browsers whose 'self' does not cover it.
 */
export const contentSecurityPolicy = (origin: string) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${origin.replace(/^http/u, "ws")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const IMMUTABLE = "private, max-age=31536000, immutable";

/** Paths that belong to the server; the page never answers for them. */
const RESERVED_PREFIXES = ["/api", "/ws", "/_cairn", "/oauth"];

const isReserved = (pathname: string) =>
  RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

const pathnameOf = (url: string) => {
  const end = url.search(/[?#]/u);

  return end === -1 ? url : url.slice(0, end);
};

const acceptsHtml = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.accept?.toLowerCase().includes("text/html") === true;

/** A JSON 404 in the shape of the protocol's `NotFound` codes. */
const apiNotFound = HttpServerResponse.jsonUnsafe(
  {
    code: "not_found",
    message: "No such API route. Check the path; nothing ran.",
  },
  { status: 404, headers: { "cache-control": "no-store" } }
);

const notFound = HttpServerResponse.text("Not found.\n", { status: 404 });

const LINE_SEPARATOR = String.fromCodePoint(0x20_28);

const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x20_29);

/** Escapes JSON for an HTML script element, so no `</script>` or `<!--` can close it. */
const escapeForScript = (json: string) =>
  json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(LINE_SEPARATOR, "\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\u2029");

/** Puts the boot JSON just before `</head>`; a page without a head gets it first. */
export const injectBootJson = (html: string, json: string) => {
  const element = `<script id="${BOOT_JSON_ELEMENT_ID}" type="application/json">${escapeForScript(json)}</script>`;
  const head = html.indexOf("</head>");

  return head === -1
    ? `${element}${html}`
    : `${html.slice(0, head)}${element}${html.slice(head)}`;
};

/**
 * `GET /*` for the web build, and a JSON 404 for any method under `/api`. Needs `ServerConfig`,
 * `BootJson` and the platform's `FileSystem`, `Path` and `HttpPlatform`.
 */
export const StaticRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const router = yield* HttpRouter.HttpRouter;
    const fs = yield* FileSystem.FileSystem;
    const bootJson = yield* BootJson;

    const assets = yield* HttpStaticServer.make({
      root: config.webRoot,
      index: undefined,
      cacheControl: IMMUTABLE,
    });

    const files = yield* HttpStaticServer.make({
      root: config.webRoot,
      index: undefined,
      cacheControl: "no-cache",
    });

    const indexFile = path.join(config.webRoot, "index.html");

    const securityHeaders = {
      "content-security-policy": contentSecurityPolicy(config.origin),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
    };

    const page = Effect.gen(function* () {
      const html = yield* fs.readFileString(indexFile).pipe(Effect.option);

      if (Option.isNone(html)) {
        return notFound;
      }

      const json = yield* bootJson.render;

      const body = Option.match(json, {
        onNone: () => html.value,
        onSome: (text) => injectBootJson(html.value, text),
      });

      return HttpServerResponse.text(body, {
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "no-cache" },
      });
    });

    const serve = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = pathnameOf(request.url);

      if (isReserved(pathname)) {
        return pathname === "/api" || pathname.startsWith("/api/")
          ? apiNotFound
          : notFound;
      }

      if (pathname === "/" || pathname === "/index.html") {
        return yield* page;
      }

      if (pathname.startsWith("/assets/")) {
        return yield* assets;
      }

      const file = yield* files.pipe(Effect.option);

      if (Option.isSome(file)) {
        return file.value;
      }

      return path.extname(pathname) === "" && acceptsHtml(request)
        ? yield* page
        : notFound;
    }).pipe(
      Effect.catchTag("HttpServerError", HttpServerRespondable.toResponse),
      Effect.map((response) =>
        HttpServerResponse.setHeaders(response, securityHeaders)
      )
    );

    yield* router.add("GET", "/*", serve);
    yield* router.add("*", "/api/*", Effect.succeed(apiNotFound));
  })
);
