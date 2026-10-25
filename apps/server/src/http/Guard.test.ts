// The guard's matrix (edges note section 4 and the gate judge's Origin list), run in memory: every
// request goes through the real `Guard` middleware and the real `Identity` rules in front of a few
// stand-in routes that answer 200.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../Config.ts";
import { Guard } from "./Guard.ts";
import { Identity } from "./Identity.ts";
import { Tailscale } from "./Tailscale.ts";

const OWNER = "oscabriel@github";

const HOST = "code.gneiss.run";

const ORIGIN = "https://code.gneiss.run";

const ok = HttpServerResponse.text("ok");

const App = Layer.mergeAll(
  Guard,
  HttpRouter.add("GET", "/", ok),
  HttpRouter.add("GET", "/ws", ok),
  HttpRouter.add("GET", "/api/thing", ok),
  HttpRouter.add(
    "GET",
    "/api/cached",
    HttpServerResponse.text("ok", {
      headers: { "cache-control": "private, max-age=31536000, immutable" },
    })
  ),
  HttpRouter.add("POST", "/api/thing", ok),
  HttpRouter.add("DELETE", "/api/thing", ok),
  HttpRouter.add("GET", "/_cairn/auth", ok),
  HttpRouter.add("GET", "/_cairn/health", ok)
).pipe(
  Layer.provide(Identity.layerNoDeps),
  Layer.provide(Tailscale.fixed(new Map())),
  Layer.provide(
    ServerConfig.layerWith({ host: HOST, origin: ORIGIN, owner: OWNER })
  )
);

/** The fetch metadata of a top-level page load. */
const pageLoad = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

/** Headers Caddy would forward for an admitted page request. */
const admitted = { host: HOST, "x-cairn-user": OWNER };

const send = Effect.fnUntraced(function* (
  method: string,
  path: string,
  headers: Record<string, string>
) {
  const handler = yield* HttpRouter.toHttpEffect(App);

  const request = HttpServerRequest.fromWeb(
    new Request(`http://${HOST}${path}`, { method, headers })
  ).modify({ remoteAddress: Option.some("127.0.0.1") });

  return yield* handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request)
  );
});

describe("the guard", () => {
  it.effect("admits the owner's page load", () =>
    Effect.gen(function* () {
      const response = yield* send("GET", "/", admitted);

      assert.strictEqual(response.status, 200);
    })
  );

  it.effect("answers 421 to any other Host", () =>
    Effect.gen(function* () {
      for (const host of [
        "127.0.0.1:3774",
        "plans.gneiss.run",
        "code.gneiss.run.evil.example",
      ]) {
        const response = yield* send("GET", "/", { ...admitted, host });

        assert.strictEqual(response.status, 421, host);
      }
    })
  );

  it.effect("refuses a missing or forged identity header with 403", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Record<string, string>> = [
        { host: HOST },
        { host: HOST, "x-cairn-user": "someone@github" },
        { host: HOST, "x-cairn-user": "oscabriel@githubx" },
        { host: HOST, "x-cairn-user": "oscabriel@" },
        { host: HOST, "x-cairn-user": "" },
        {
          host: HOST,
          "x-cairn-peer": "100.84.155.69",
          "x-forwarded-for": "100.84.155.69",
        },
      ];

      for (const headers of cases) {
        const response = yield* send("GET", "/", headers);

        assert.strictEqual(response.status, 403, JSON.stringify(headers));
      }
    })
  );

  it.effect("requires Cairn's exact Origin on every non-safe method", () =>
    Effect.gen(function* () {
      const refused = [
        Option.none<string>(),
        Option.some("https://evil.example"),
        Option.some("https://code.gneiss.run.evil.example"),
        Option.some("http://code.gneiss.run"),
        Option.some("https://plans.gneiss.run"),
        Option.some("null"),
      ];

      for (const method of ["POST", "DELETE"]) {
        for (const origin of refused) {
          const headers = Option.match(origin, {
            onNone: () => admitted,
            onSome: (value) => ({ ...admitted, origin: value }),
          });

          const response = yield* send(method, "/api/thing", headers);

          assert.strictEqual(
            response.status,
            403,
            `${method} ${Option.getOrElse(origin, () => "none")}`
          );
        }

        const accepted = yield* send(method, "/api/thing", {
          ...admitted,
          origin: ORIGIN,
        });

        assert.strictEqual(accepted.status, 200, method);
      }
    })
  );

  it.effect("requires Cairn's exact Origin on a WebSocket upgrade, a GET", () =>
    Effect.gen(function* () {
      const upgrade = {
        ...admitted,
        connection: "Upgrade",
        upgrade: "websocket",
      };

      for (const origin of ["https://evil.example", "http://code.gneiss.run"]) {
        const response = yield* send("GET", "/ws", { ...upgrade, origin });

        assert.strictEqual(response.status, 403, origin);
      }

      const missing = yield* send("GET", "/ws", upgrade);

      const accepted = yield* send("GET", "/ws", {
        ...upgrade,
        origin: ORIGIN,
      });

      assert.strictEqual(missing.status, 403);
      assert.strictEqual(accepted.status, 200);
    })
  );

  it.effect("lets a plain GET through without an Origin", () =>
    Effect.gen(function* () {
      const response = yield* send("GET", "/api/thing", admitted);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers["cache-control"], "no-store");
    })
  );

  it.effect("refuses a cross-site GET on /api but not a page load", () =>
    Effect.gen(function* () {
      const crossSite = { ...admitted, "sec-fetch-site": "cross-site" };

      const api = yield* send("GET", "/api/thing", {
        ...crossSite,
        ...pageLoad,
      });

      const page = yield* send("GET", "/", { ...crossSite, ...pageLoad });

      const sameOrigin = yield* send("GET", "/api/thing", {
        ...admitted,
        "sec-fetch-site": "same-origin",
      });

      assert.strictEqual(api.status, 403);
      assert.strictEqual(page.status, 200);
      assert.strictEqual(sameOrigin.status, 200);
    })
  );

  it.effect(
    "refuses a cross-site request to /api under any spelling the router accepts",
    () =>
      Effect.gen(function* () {
        for (const path of ["/API/thing", "//api/thing", "/%61pi/thing"]) {
          const crossSite = yield* send("GET", path, {
            ...admitted,
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
          });

          const sameOrigin = yield* send("GET", path, {
            ...admitted,
            "sec-fetch-site": "same-origin",
          });

          assert.strictEqual(crossSite.status, 403, path);
          assert.strictEqual(sameOrigin.status, 200, path);
          assert.strictEqual(
            sameOrigin.headers["cache-control"],
            "no-store",
            path
          );
        }
      })
  );

  it.effect("refuses a cross-site embed or frame of the page", () =>
    Effect.gen(function* () {
      for (const dest of ["iframe", "image", "script"]) {
        const response = yield* send("GET", "/", {
          ...admitted,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": dest,
        });

        assert.strictEqual(response.status, 403, dest);
      }
    })
  );

  it.effect("keeps the cache policy an /api route set", () =>
    Effect.gen(function* () {
      const response = yield* send("GET", "/api/cached", admitted);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers["cache-control"],
        "private, max-age=31536000, immutable"
      );
    })
  );

  it.effect(
    "leaves Caddy's auth endpoint and the health check to their own rules",
    () =>
      Effect.gen(function* () {
        const auth = yield* send("GET", "/_cairn/auth", {
          host: "127.0.0.1:3774",
        });

        const health = yield* send("GET", "/_cairn/health", {
          host: "127.0.0.1:3774",
        });

        const postAuth = yield* send("POST", "/_cairn/auth", {
          host: "127.0.0.1:3774",
        });

        assert.strictEqual(auth.status, 200);
        assert.strictEqual(health.status, 200);
        assert.strictEqual(postAuth.status, 421);
      })
  );
});
