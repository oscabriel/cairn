// The health route answers only processes on this host, and reports readiness once boot marks it.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Health, HealthRoute, isLoopbackAddress } from "./Health.ts";

const get = Effect.fnUntraced(function* (
  remote: string,
  headers: Record<string, string> = {}
) {
  const handler = yield* HttpRouter.toHttpEffect(HealthRoute);

  const request = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3774/_cairn/health", { headers })
  ).modify({ remoteAddress: Option.some(remote) });

  const response = yield* handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request)
  );

  const body = yield* Effect.promise(
    async () => await HttpServerResponse.toWeb(response).text()
  );

  return { status: response.status, body };
});

const decodeStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ready: Schema.Boolean,
      pid: Schema.Int,
      startedAt: Schema.String,
    })
  )
);

describe("the health route", () => {
  it.effect("reports readiness to a loopback caller", () =>
    Effect.gen(function* () {
      const response = yield* get("127.0.0.1");
      const status = decodeStatus(response.body);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(status.ready, false);
      assert.strictEqual(status.pid, process.pid);
      assert.isString(status.startedAt);
    }).pipe(Effect.provide(Health.layer))
  );

  it.effect(
    "answers 404 to anything that came through Caddy or from elsewhere",
    () =>
      Effect.gen(function* () {
        const proxied = yield* get("127.0.0.1", {
          "x-forwarded-for": "100.84.155.69",
        });

        const tailnet = yield* get("100.84.155.69");

        assert.strictEqual(proxied.status, 404);
        assert.strictEqual(tailnet.status, 404);
      }).pipe(Effect.provide(Health.layer))
  );
});

describe("readiness", () => {
  it.effect("starts not ready and stays ready once marked", () =>
    Effect.gen(function* () {
      const health = yield* Health;

      assert.isFalse(yield* health.isReady);
      yield* health.markReady;
      yield* health.markReady;
      assert.isTrue(yield* health.isReady);
      assert.isTrue((yield* health.status).ready);
    }).pipe(Effect.provide(Health.layer))
  );
});

describe(isLoopbackAddress, () => {
  it("knows loopback in every spelling Node reports", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.0.9",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      assert.isTrue(isLoopbackAddress(address), address);
    }

    for (const address of [
      "100.84.155.69",
      "192.168.4.20",
      "::2",
      "::ffff:10.0.0.1",
      "localhost",
      "",
    ]) {
      assert.isFalse(isLoopbackAddress(address), address);
    }
  });
});
