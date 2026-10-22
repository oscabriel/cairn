// The static routes against a small web build in a temporary directory: the SPA fallback only for
// HTML navigations, never for the server's own prefixes, a JSON 404 under /api, the cache split,
// the security headers, and the boot JSON hook.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../Config.ts";
import { BootJson, injectBootJson, StaticRoutes } from "./Static.ts";

const INDEX =
  '<!doctype html><html><head><meta charset="utf-8"><title>Cairn</title></head><body></body></html>';

const webRoot = mkdtempSync(path.join(os.tmpdir(), "cairn-static-"));

mkdirSync(path.join(webRoot, "assets"));

writeFileSync(path.join(webRoot, "index.html"), INDEX);

writeFileSync(
  path.join(webRoot, "assets", "main-abc123.js"),
  "console.log(1);\n"
);

writeFileSync(
  path.join(webRoot, "sw.js"),
  "self.addEventListener('push', () => {});\n"
);

const appWith = (bootJson: Layer.Layer<BootJson>) =>
  StaticRoutes.pipe(
    Layer.provide(bootJson),
    Layer.provide(ServerConfig.layerWith({ webRoot })),
    Layer.provide(NodeHttpServer.layerHttpServices)
  );

const fetchFrom = Effect.fnUntraced(function* (
  app: ReturnType<typeof appWith>,
  method: string,
  pathname: string,
  headers: Record<string, string> = {}
) {
  const handler = yield* HttpRouter.toHttpEffect(app);

  const request = HttpServerRequest.fromWeb(
    new Request(`http://code.gneiss.run${pathname}`, { method, headers })
  );

  const response = yield* handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request)
  );

  const body = yield* Effect.promise(
    async () => await HttpServerResponse.toWeb(response).text()
  );

  return { status: response.status, headers: response.headers, body };
});

const plain = appWith(BootJson.layerNone);

const decodeCode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String }))
);

const html = { accept: "text/html,application/xhtml+xml" };

describe("the static routes", () => {
  it.effect("serves the page for an HTML navigation to a client route", () =>
    Effect.gen(function* () {
      const page = yield* fetchFrom(
        plain,
        "GET",
        "/t/0190f3a4-0000-7000-8000-000000000000",
        html
      );

      assert.strictEqual(page.status, 200);
      assert.strictEqual(page.body, INDEX);
      assert.strictEqual(page.headers["cache-control"], "no-cache");
      assert.include(
        page.headers["content-security-policy"] ?? "",
        "script-src 'self'"
      );
      assert.include(
        page.headers["content-security-policy"] ?? "",
        "frame-ancestors 'none'"
      );
      assert.strictEqual(
        page.headers["cross-origin-opener-policy"],
        "same-origin"
      );
      assert.strictEqual(page.headers["x-content-type-options"], "nosniff");
    })
  );

  it.effect("answers 404 to a client route that does not ask for HTML", () =>
    Effect.gen(function* () {
      const curl = yield* fetchFrom(plain, "GET", "/t/abc", { accept: "*/*" });
      const bare = yield* fetchFrom(plain, "GET", "/settings");

      assert.strictEqual(curl.status, 404);
      assert.strictEqual(bare.status, 404);
    })
  );

  it.effect(
    "answers a JSON 404 under /api, for any method, even to a browser",
    () =>
      Effect.gen(function* () {
        for (const [method, pathname] of [
          ["GET", "/api/missing"],
          ["GET", "/api"],
          ["POST", "/api/missing"],
          ["DELETE", "/api/threads/x"],
        ] as const) {
          const response = yield* fetchFrom(plain, method, pathname, html);

          assert.strictEqual(response.status, 404, `${method} ${pathname}`);
          assert.strictEqual(
            decodeCode(response.body).code,
            "not_found",
            pathname
          );
          assert.strictEqual(response.headers["cache-control"], "no-store");
        }
      })
  );

  it.effect("never answers the server's own prefixes with the page", () =>
    Effect.gen(function* () {
      for (const pathname of [
        "/ws",
        "/_cairn/anything",
        "/oauth/executor/callback",
      ]) {
        const response = yield* fetchFrom(plain, "GET", pathname, html);

        assert.strictEqual(response.status, 404, pathname);
        assert.notInclude(response.body, "<html>", pathname);
      }
    })
  );

  it.effect(
    "caches hashed assets for a year and everything else for no time",
    () =>
      Effect.gen(function* () {
        const asset = yield* fetchFrom(plain, "GET", "/assets/main-abc123.js");
        const worker = yield* fetchFrom(plain, "GET", "/sw.js");

        const missingAsset = yield* fetchFrom(
          plain,
          "GET",
          "/assets/gone-000.js",
          html
        );

        assert.strictEqual(asset.status, 200);
        assert.strictEqual(
          asset.headers["cache-control"],
          "private, max-age=31536000, immutable"
        );
        assert.strictEqual(worker.status, 200);
        assert.strictEqual(worker.headers["cache-control"], "no-cache");
        assert.strictEqual(missingAsset.status, 404);
      })
  );

  it.effect("refuses a path that climbs out of the web root", () =>
    Effect.gen(function* () {
      const response = yield* fetchFrom(
        plain,
        "GET",
        "/..%2f..%2fetc%2fpasswd"
      );

      assert.strictEqual(response.status, 404);
    })
  );

  it.effect(
    "injects the boot JSON a layer renders, escaped for a script element",
    () =>
      Effect.gen(function* () {
        const app = appWith(
          Layer.succeed(
            BootJson,
            BootJson.of({
              render: Effect.succeedSome('{"title":"</script><b>"}'),
            })
          )
        );

        const page = yield* fetchFrom(app, "GET", "/", html);

        assert.strictEqual(page.status, 200);
        assert.include(
          page.body,
          '<script id="cairn-boot" type="application/json">{"title":"\\u003c/script\\u003e\\u003cb\\u003e"}</script></head>'
        );
        assert.notInclude(page.body, "</script><b>");
      })
  );
});

describe(injectBootJson, () => {
  it("puts the element first when the page has no head", () => {
    assert.strictEqual(
      injectBootJson("<p>x</p>", "{}"),
      '<script id="cairn-boot" type="application/json">{}</script><p>x</p>'
    );
  });
});
