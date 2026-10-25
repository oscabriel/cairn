// Identity's admission table (edges note, "Gate: identity and Origin"): the owner's nodes in, every
// other kind of peer out, the login compared exactly, and the whois cache timed on `TestClock`.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, Option, Ref } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../Config.ts";
import { AuthRoute, Identity } from "./Identity.ts";
import { Tailscale, TailscaleUnavailable } from "./Tailscale.ts";
import type { Peer } from "./Tailscale.ts";

const OWNER = "oscabriel@github";

const node = (loginName: string, tags: ReadonlyArray<string> = []): Peer => ({
  stableId: `n-${loginName}-${tags.length}`,
  loginName,
  tags,
  nodeName: `${loginName}.ts.net`,
});

const table = new Map<string, Peer>([
  ["100.84.155.69", node(OWNER)],
  ["100.101.1.2", node(OWNER)],
  ["fd7a:115c:a1e0::1", node(OWNER)],
  ["100.101.1.3", node(OWNER, ["tag:server"])],
  ["100.101.1.4", node("someone@github")],
  ["100.101.1.5", node("oscabriel@githubx")],
  ["100.101.1.6", node("oscabriel@")],
  ["100.101.1.7", node("friend@shared.example")],
]);

const Config = ServerConfig.layerWith({ owner: OWNER });

const IdentityFixed = Identity.layerNoDeps.pipe(
  Layer.provide(Tailscale.fixed(table)),
  Layer.provide(Config)
);

const refusal = (peer: string) =>
  Effect.gen(function* () {
    const identity = yield* Identity;
    const refused = yield* Effect.flip(identity.admit(peer));

    return refused.reason;
  });

const requestFrom = (remote: string, headers: Record<string, string> = {}) =>
  HttpServerRequest.fromWeb(
    new Request("http://code.gneiss.run/ws", { headers })
  ).modify({ remoteAddress: Option.some(remote) });

describe("Identity.admit", () => {
  it.effect("admits the owner's untagged nodes, IPv4 and IPv6", () =>
    Effect.gen(function* () {
      const identity = yield* Identity;

      for (const peer of [
        "100.84.155.69",
        "100.101.1.2",
        "fd7a:115c:a1e0::1",
      ]) {
        assert.strictEqual(yield* identity.admit(peer), OWNER, peer);
      }
    }).pipe(Effect.provide(IdentityFixed))
  );

  it.effect("refuses every other kind of peer, with the reason", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["100.101.1.3", "tagged_node"],
        ["100.101.1.4", "not_the_owner"],
        ["100.101.1.5", "not_the_owner"],
        ["100.101.1.6", "not_the_owner"],
        ["100.101.1.7", "not_the_owner"],
        ["127.0.0.1", "not_on_tailnet"],
        ["192.168.4.20", "not_on_tailnet"],
        ["::1", "not_on_tailnet"],
        ["", "no_peer"],
        ["not-an-ip", "not_an_ip"],
        ["100.84.155.69:443", "not_an_ip"],
        ["100.84.155.69, 100.101.1.4", "not_an_ip"],
        ["[fd7a:115c:a1e0::1]", "not_an_ip"],
      ];

      for (const [peer, reason] of cases) {
        assert.strictEqual(yield* refusal(peer), reason, peer);
      }
    }).pipe(Effect.provide(IdentityFixed))
  );

  it.effect(
    "follows the configured owner: a changed owner flips every row",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* refusal("100.84.155.69"), "not_the_owner");
        assert.strictEqual(
          yield* Effect.flatMap(Effect.service(Identity), (identity) =>
            identity.admit("100.101.1.4")
          ),
          "someone@github"
        );
      }).pipe(
        Effect.provide(
          Identity.layerNoDeps.pipe(
            Layer.provide(Tailscale.fixed(table)),
            Layer.provide(ServerConfig.layerWith({ owner: "someone@github" }))
          )
        )
      )
  );
});

/** A tailnet whose answers the test changes, counting every lookup. */
const countingTailnet = Effect.gen(function* () {
  const lookups = yield* Ref.make(0);
  const peers = yield* Ref.make(new Map(table));
  const failing = yield* Ref.make(false);

  const layer = Layer.succeed(
    Tailscale,
    Tailscale.of({
      whois: (ip) =>
        Effect.gen(function* () {
          yield* Ref.update(lookups, (count) => count + 1);

          if (yield* Ref.get(failing)) {
            return yield* new TailscaleUnavailable({
              message: "tailscaled is down",
              cause: new Error("down"),
            });
          }

          return Option.fromNullishOr((yield* Ref.get(peers)).get(ip));
        }),
    })
  );

  const identity = yield* Effect.provide(
    Effect.service(Identity),
    Identity.layerNoDeps.pipe(Layer.provide(layer), Layer.provide(Config))
  );

  return { identity, lookups, peers, failing };
});

describe("Identity whois cache", () => {
  it.effect("reuses an admitted peer for 30 s, then asks again", () =>
    Effect.gen(function* () {
      const { identity, lookups, peers } = yield* countingTailnet;

      yield* identity.admit("100.84.155.69");
      yield* identity.admit("100.84.155.69");
      assert.strictEqual(yield* Ref.get(lookups), 1);

      yield* Ref.update(peers, (current) => {
        const next = new Map(current);

        next.delete("100.84.155.69");

        return next;
      });
      yield* TestClock.adjust("29 seconds");
      assert.strictEqual(yield* identity.admit("100.84.155.69"), OWNER);
      assert.strictEqual(yield* Ref.get(lookups), 1);

      yield* TestClock.adjust("2 seconds");
      const refused = yield* Effect.flip(identity.admit("100.84.155.69"));

      assert.strictEqual(refused.reason, "not_on_tailnet");
      assert.strictEqual(yield* Ref.get(lookups), 2);
    })
  );

  it.effect('reuses "no such peer" for 5 s only', () =>
    Effect.gen(function* () {
      const { identity, lookups, peers } = yield* countingTailnet;

      yield* Effect.flip(identity.admit("100.64.9.9"));
      yield* Effect.flip(identity.admit("100.64.9.9"));
      assert.strictEqual(yield* Ref.get(lookups), 1);

      yield* Ref.update(
        peers,
        (current) => new Map([...current, ["100.64.9.9", node(OWNER)]])
      );
      yield* TestClock.adjust("4 seconds");
      yield* Effect.flip(identity.admit("100.64.9.9"));
      assert.strictEqual(yield* Ref.get(lookups), 1);

      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(yield* identity.admit("100.64.9.9"), OWNER);
      assert.strictEqual(yield* Ref.get(lookups), 2);
    })
  );

  it.effect("never caches a failed lookup", () =>
    Effect.gen(function* () {
      const { identity, lookups, failing } = yield* countingTailnet;

      yield* Ref.set(failing, true);
      const first = yield* Effect.flip(identity.admit("100.84.155.69"));

      yield* Ref.set(failing, false);
      const second = yield* identity.admit("100.84.155.69");

      assert.strictEqual(first.reason, "lookup_failed");
      assert.strictEqual(second, OWNER);
      assert.strictEqual(yield* Ref.get(lookups), 2);
    })
  );
});

describe("Identity on requests", () => {
  it.effect("reads the copied header exactly", () =>
    Effect.gen(function* () {
      const identity = yield* Identity;

      const owner = identity.viewerOf(
        requestFrom("127.0.0.1", { "x-cairn-user": OWNER })
      );

      const near = identity.viewerOf(
        requestFrom("127.0.0.1", { "x-cairn-user": `${OWNER}x` })
      );

      const none = identity.viewerOf(requestFrom("127.0.0.1"));

      assert.deepStrictEqual(owner, Option.some(OWNER));
      assert.isTrue(Option.isNone(near));
      assert.isTrue(Option.isNone(none));
    }).pipe(Effect.provide(IdentityFixed))
  );

  it.effect("re-checks an open socket against the peer Caddy forwarded", () =>
    Effect.gen(function* () {
      const identity = yield* Identity;

      const viaCaddy = (forwarded: string) =>
        identity.stillAdmitted(
          requestFrom("127.0.0.1", { "x-forwarded-for": forwarded })
        );

      assert.isTrue(yield* viaCaddy("100.84.155.69"));
      assert.isTrue(yield* viaCaddy("100.101.1.4, 100.84.155.69"));
      assert.isFalse(yield* viaCaddy("100.84.155.69, 100.101.1.4"));
      assert.isFalse(yield* identity.stillAdmitted(requestFrom("127.0.0.1")));
    }).pipe(Effect.provide(IdentityFixed))
  );

  it.effect("treats only loopback requests as the owner in development", () =>
    Effect.gen(function* () {
      const identity = yield* Identity;

      for (const remote of [
        "127.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "127.8.9.10",
      ]) {
        assert.deepStrictEqual(
          identity.viewerOf(requestFrom(remote)),
          Option.some(OWNER),
          remote
        );
        assert.isTrue(
          yield* identity.stillAdmitted(requestFrom(remote)),
          remote
        );
      }

      for (const remote of ["100.84.155.69", "192.168.4.20", "::2"]) {
        assert.isTrue(
          Option.isNone(identity.viewerOf(requestFrom(remote))),
          remote
        );
        assert.isFalse(
          yield* identity.stillAdmitted(requestFrom(remote)),
          remote
        );
      }
    }).pipe(
      Effect.provide(Identity.layerLoopbackOwner.pipe(Layer.provide(Config)))
    )
  );
});

const logged: Array<string> = [];

const capture = Logger.make((options) => {
  logged.push(String(options.message));
});

/** Asks the real auth route, as Caddy would, and returns its status and what it logged. */
const askAuth = Effect.fnUntraced(function* (headers: Record<string, string>) {
  logged.length = 0;

  const handler = yield* HttpRouter.toHttpEffect(AuthRoute);

  const request = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3774/_cairn/auth", { headers })
  ).modify({ remoteAddress: Option.some("127.0.0.1") });

  const response = yield* handler.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    Effect.provide(
      Layer.merge(
        IdentityFixed,
        Logger.layer([capture], { mergeWithExisting: false })
      )
    )
  );

  return { status: response.status, logged: [...logged] };
});

/** What Caddy's `forward_auth` sends, from a logged subrequest (2026-10-23). */
const subrequest = (peer: string) => ({
  "x-cairn-peer": peer,
  via: "3.0 Caddy",
  "x-forwarded-for": "100.84.155.69",
  "x-forwarded-method": "GET",
  "x-forwarded-uri": "/_cairn/auth",
});

describe("the auth route", () => {
  it.effect("admits the owner's peer on Caddy's subrequest", () =>
    Effect.gen(function* () {
      const answer = yield* askAuth(subrequest("100.84.155.69"));

      assert.deepStrictEqual(answer, { status: 200, logged: [] });
    })
  );

  it.effect("still dumps the headers of a subrequest with no peer", () =>
    Effect.gen(function* () {
      const answer = yield* askAuth(subrequest(""));

      assert.strictEqual(answer.status, 403);
      assert.include(answer.logged, "auth request without a peer");
    })
  );

  it.effect("asks for a resend when the subrequest came in early data", () =>
    Effect.gen(function* () {
      // The shape of the 16 refused page loads logged in the week to 2026-10-25.
      const answer = yield* askAuth({ ...subrequest(""), "early-data": "1" });

      assert.deepStrictEqual(answer, {
        status: 425,
        logged: ["auth request in early data"],
      });
    })
  );

  it.effect(
    "answers 404 and logs nothing when asked through the main proxy",
    () =>
      Effect.gen(function* () {
        const answer = yield* askAuth({
          via: "3.0 Caddy",
          "x-cairn-user": OWNER,
          "x-forwarded-for": "100.84.155.69",
        });

        assert.deepStrictEqual(answer, { status: 404, logged: [] });
      })
  );

  it.effect("refuses a direct call with no peer, as before", () =>
    Effect.gen(function* () {
      const answer = yield* askAuth({});

      assert.strictEqual(answer.status, 403);
    })
  );
});
