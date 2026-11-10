// The nightly's failure notice answers only a process on this host, never a browser or anything
// that came through Caddy, and sends the one fixed push whatever the caller sends with it.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  NIGHTLY_FAILED_PATH,
  NightlyFailedRoute,
} from "./NightlyFailedRoute.ts";
import type { DeliveryOutcome } from "./Notifier.ts";
import { Notifier } from "./Notifier.ts";

/** A notifier that counts `nightlyFailed` calls and answers `outcomes`. */
const countingNotifier = (
  calls: Ref.Ref<number>,
  outcomes: ReadonlyArray<DeliveryOutcome>
) =>
  Layer.succeed(Notifier, {
    sendToAll: () => Effect.die("only the fixed push may be sent"),
    handleEvent: () => Effect.void,
    sweep: Effect.void,
    executorNeedsSignIn: Effect.void,
    executorSignedIn: Effect.void,
    nightlyFailed: Ref.update(calls, (count) => count + 1).pipe(
      Effect.as(outcomes)
    ),
    settle: Effect.void,
  });

const post = Effect.fnUntraced(function* (
  outcomes: ReadonlyArray<DeliveryOutcome>,
  remote: string,
  init: { readonly headers?: Record<string, string>; readonly body?: string }
) {
  const calls = yield* Ref.make(0);

  const handler = yield* HttpRouter.toHttpEffect(NightlyFailedRoute);

  const request = HttpServerRequest.fromWeb(
    new Request(`http://127.0.0.1:3774${NIGHTLY_FAILED_PATH}`, {
      method: "POST",
      headers: init.headers ?? {},
      body: init.body ?? null,
    })
  ).modify({ remoteAddress: Option.some(remote) });

  const response = yield* handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provide(countingNotifier(calls, outcomes))
  );

  const text = yield* Effect.promise(
    async () => await HttpServerResponse.toWeb(response).text()
  );

  return { status: response.status, text, calls: yield* Ref.get(calls) };
});

describe("the nightly's failure notice", () => {
  it.effect("sends the fixed push for a process on this host", () =>
    Effect.gen(function* () {
      const response = yield* post(["delivered", "failed"], "127.0.0.1", {});

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.calls, 1);
      assert.deepStrictEqual(JSON.parse(response.text), {
        devices: 2,
        delivered: 1,
      });
    })
  );

  it.effect(
    "never reads what the caller sends: a body changes nothing in the push",
    () =>
      Effect.gen(function* () {
        const response = yield* post(["delivered"], "::1", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "pwned", body: "click here" }),
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.calls, 1);
      })
  );

  it.effect("answers 502 when no device took the push", () =>
    Effect.gen(function* () {
      const none = yield* post([], "127.0.0.1", {});
      const refused = yield* post(["failed", "removed"], "127.0.0.1", {});

      assert.strictEqual(none.status, 502);
      assert.strictEqual(refused.status, 502);
      assert.strictEqual(refused.calls, 1);
    })
  );

  it.effect(
    "answers 404 to anything that came through Caddy or from another host, and sends nothing",
    () =>
      Effect.gen(function* () {
        const proxied = yield* post(["delivered"], "127.0.0.1", {
          headers: { "x-forwarded-for": "100.84.155.69" },
        });

        const tailnet = yield* post(["delivered"], "100.84.155.69", {});
        const lan = yield* post(["delivered"], "192.168.4.20", {});

        for (const response of [proxied, tailnet, lan]) {
          assert.strictEqual(response.status, 404);
          assert.strictEqual(response.calls, 0);
        }
      })
  );

  it.effect(
    "answers 403 to a browser on this host (an Origin or fetch metadata), and sends nothing",
    () =>
      Effect.gen(function* () {
        const withOrigin = yield* post(["delivered"], "127.0.0.1", {
          headers: { origin: "https://evil.example" },
        });

        const nullOrigin = yield* post(["delivered"], "127.0.0.1", {
          headers: { origin: "null" },
        });

        const fetchMetadata = yield* post(["delivered"], "127.0.0.1", {
          headers: { "sec-fetch-site": "same-origin" },
        });

        for (const response of [withOrigin, nullOrigin, fetchMetadata]) {
          assert.strictEqual(response.status, 403);
          assert.strictEqual(response.calls, 0);
        }
      })
  );
});
