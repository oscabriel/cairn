// The build route through the router: the build id `session.hello` reports, as JSON, never cached,
// so a page refused by the socket can tell it belongs to another build. The path and the body are
// written out, not imported: the web app asks for exactly these (`apps/web/src/load/Load.test.ts`).

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { FALLBACK_DEFAULTS, SessionHello } from "../rpc/SessionHandlers.ts";
import { BuildRoute } from "./Build.ts";

const app = BuildRoute.pipe(
  Layer.provide(
    Layer.succeed(
      SessionHello,
      SessionHello.of({
        build: "abc123def456",
        defaults: Effect.succeed(FALLBACK_DEFAULTS),
        vapidPublicKey: Effect.succeedNone,
      })
    )
  ),
  Layer.provide(NodeHttpServer.layerHttpServices)
);

describe("the build route", () => {
  it.effect("answers the served build, never cached", () =>
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(app);

      const response = HttpServerResponse.toWeb(
        yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://code.gneiss.run/api/build")
            )
          )
        )
      );

      const body = yield* Effect.promise(async () => await response.json());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      assert.deepStrictEqual(body, { build: "abc123def456" });
    })
  );
});
