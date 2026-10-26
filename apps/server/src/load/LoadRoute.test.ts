// The load report route through the router, as the page's beacon reaches it behind Caddy: one
// `load.report` line with the peer's path read from the last `X-Forwarded-For` entry, and a 400
// that logs nothing for a body that is not a report. `pathFromStatus` against recorded
// `tailscale status --json` shapes.

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { LOAD_REPORT_PATH, LoadRoute } from "./LoadRoute.ts";
import { PeerPath, pathFromStatus } from "./PeerPath.ts";

const PHONE = "100.101.102.103";

const LAPTOP = "100.90.1.2";

/** The annotations of one log line, as `Logger` hands them over. */
type Annotations = ReturnType<
  typeof References.CurrentLogAnnotations.defaultValue
>;

const logged: Array<Annotations> = [];

const capture = Logger.make((options) => {
  logged.push(options.fiber.getRef(References.CurrentLogAnnotations));
});

const app = LoadRoute.pipe(
  Layer.provide(
    PeerPath.fixed(
      new Map([
        [PHONE, "derp"],
        [LAPTOP, "direct"],
      ])
    )
  ),
  Layer.provide(NodeHttpServer.layerHttpServices)
);

const post = Effect.fnUntraced(function* (
  body: string,
  headers: Record<string, string>
) {
  const handler = yield* HttpRouter.toHttpEffect(app);

  const request = HttpServerRequest.fromWeb(
    new Request(`http://code.gneiss.run${LOAD_REPORT_PATH}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    })
  );

  const response = yield* handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
  );

  return HttpServerResponse.toWeb(response).status;
});

const REPORT = JSON.stringify({
  interactiveMs: 412.6,
  requestsBeforeInteractive: 5,
  standalone: true,
});

const reports = () => logged.filter((line) => line.event === "load.report");

describe("the load report route", () => {
  it.effect("logs one load.report line with the peer's path", () =>
    Effect.gen(function* () {
      logged.length = 0;

      const status = yield* post(REPORT, {
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)",
        "x-forwarded-for": `10.0.0.1, ${PHONE}`,
      });

      assert.strictEqual(status, 204);

      const [line] = reports();

      assert.strictEqual(reports().length, 1);
      assert.strictEqual(line?.interactiveMs, 413);
      assert.strictEqual(line?.requestsBeforeInteractive, 5);
      assert.strictEqual(line?.derp, true);
      assert.strictEqual(line?.path, "derp");
      assert.strictEqual(line?.standalone, true);
      assert.include(String(line?.userAgent), "iPhone");
      assert.match(String(line?.at), /^\d{4}-\d{2}-\d{2}T/u);
    })
  );

  it.effect("reads a direct path as not DERP", () =>
    Effect.gen(function* () {
      logged.length = 0;

      yield* post(REPORT, { "x-forwarded-for": LAPTOP });

      assert.strictEqual(reports()[0]?.derp, false);
      assert.strictEqual(reports()[0]?.path, "direct");
    })
  );

  it.effect("refuses a body that is not a report and logs nothing", () =>
    Effect.gen(function* () {
      logged.length = 0;

      const status = yield* post(
        JSON.stringify({ interactiveMs: -1, requestsBeforeInteractive: 2 }),
        { "x-forwarded-for": PHONE }
      );

      assert.strictEqual(status, 400);
      assert.strictEqual(reports().length, 0);
    })
  );
});

describe("the peer path from tailscale status", () => {
  const status = JSON.stringify({
    Self: { TailscaleIPs: ["100.64.0.1"] },
    Peer: {
      "nodekey:a": {
        TailscaleIPs: [PHONE, "fd7a:115c:a1e0::1"],
        CurAddr: "",
        Relay: "sea",
      },
      "nodekey:b": {
        TailscaleIPs: [LAPTOP],
        CurAddr: "192.168.1.20:41641",
        Relay: "nyc",
      },
    },
  });

  it("reads a relayed peer as derp and a peer with an address as direct", () => {
    assert.strictEqual(pathFromStatus(status, PHONE), "derp");
    assert.strictEqual(pathFromStatus(status, `::ffff:${LAPTOP}`), "direct");
  });

  it("reads an unknown address or unreadable output as unknown", () => {
    assert.strictEqual(pathFromStatus(status, "100.64.9.9"), "unknown");
    assert.strictEqual(pathFromStatus("not json", PHONE), "unknown");
  });
});
