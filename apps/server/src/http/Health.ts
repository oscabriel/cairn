// Readiness. The listener answers static files from the first moment and `/ws` with 503 until boot
// marks the brain ready; `GET /_cairn/health` reports it to deploy scripts and judges on the host.

import { BlockList, isIP } from "node:net";

import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** What `GET /_cairn/health` answers. */
export const HealthStatus = Schema.Struct({
  ready: Schema.Boolean,
  startedAt: Schema.DateTimeUtc,
  pid: Schema.Int,
});

export type HealthStatus = typeof HealthStatus.Type;

const encodeHealthStatus = Schema.encodeEffect(
  Schema.toCodecJson(HealthStatus)
);

/** The brain's readiness, set once by boot. */
export class Health extends Context.Service<
  Health,
  {
    /** Marks the brain ready: `/ws` starts accepting sockets. Idempotent. */
    readonly markReady: Effect.Effect<void>;
    /** Whether boot has finished. */
    readonly isReady: Effect.Effect<boolean>;
    readonly status: Effect.Effect<HealthStatus>;
  }
>()("cairn/server/http/Health") {
  /** Starts not ready, stamped with the time the layer was built. */
  static readonly layer = Layer.effect(
    Health,
    Effect.gen(function* () {
      const ready = yield* Ref.make(false);
      const startedAt = yield* DateTime.now;

      return Health.of({
        markReady: Ref.set(ready, true),
        isReady: Ref.get(ready),
        status: Effect.map(Ref.get(ready), (isReady) => ({
          ready: isReady,
          startedAt,
          pid: process.pid,
        })),
      });
    })
  );
}

const loopback = new BlockList();

loopback.addSubnet("127.0.0.0", 8, "ipv4");

loopback.addAddress("::1", "ipv6");

/** Whether `address` (IPv4, IPv6 or IPv4-mapped IPv6) is a loopback address. */
export const isLoopbackAddress = (address: string) => {
  const plain = address.replace(/^::ffff:/iu, "");
  const family = isIP(plain);

  if (family === 0) {
    return false;
  }

  return loopback.check(plain, family === 4 ? "ipv4" : "ipv6");
};

/**
 * Whether a request came straight from a process on this host, not through Caddy: a loopback
 * peer and no `X-Forwarded-For`.
 */
export const isDirectLoopback = (
  request: HttpServerRequest.HttpServerRequest
) =>
  request.headers["x-forwarded-for"] === undefined &&
  Option.exists(request.remoteAddress, isLoopbackAddress);

/** `GET /_cairn/health`: loopback only, no identity; 404 to anything that came through Caddy. */
export const HealthRoute = HttpRouter.add(
  "GET",
  "/_cairn/health",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (!isDirectLoopback(request)) {
      return HttpServerResponse.text("Not found.\n", { status: 404 });
    }

    const health = yield* Health;

    const body = yield* encodeHealthStatus(yield* health.status).pipe(
      Effect.orDie
    );

    return HttpServerResponse.jsonUnsafe(body, {
      headers: { "cache-control": "no-store" },
    });
  })
);
