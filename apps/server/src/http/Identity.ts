// Who may use Cairn (ADR 0008 as amended): exactly one Tailscale login, from config, on an untagged
// node. Caddy's `forward_auth` asks `GET /_cairn/auth` with the peer address it saw
// (`X-Cairn-Peer`), and copies the `X-Cairn-User` this answers onto the proxied request, replacing
// any the client sent. The Beelink's own node is admitted like any other of the owner's nodes;
// loopback and LAN addresses are not tailnet peers and are refused. The accepted consequence: any
// process on the Beelink that talks to the loopback listener directly can claim the owner's header.
// Decision rules follow cairn-v1 `apps/server/src/Gate.ts` at 1a5cd4a (generic refusal body, the
// reason only in the log, a short whois cache), rewritten for a login instead of a device list.
import { isIP } from "node:net";

import { Cache, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../Config.ts";
import { isLoopbackAddress } from "./Health.ts";
import { forwardedPeer } from "./Request.ts";
import { Tailscale } from "./Tailscale.ts";

/** The header Caddy sets on the auth subrequest from its own `{remote_host}`. */
export const PEER_HEADER = "x-cairn-peer";

/** The header the auth endpoint answers and Caddy copies onto every proxied request. */
export const USER_HEADER = "x-cairn-user";

/** Why a peer was not admitted. Logged, never sent: reasons name other people's devices. */
export class IdentityRefused extends Schema.TaggedError<IdentityRefused>()(
  "IdentityRefused",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "no_peer",
      "not_an_ip",
      "not_on_tailnet",
      "tagged_node",
      "not_the_owner",
      "lookup_failed",
    ]),
  }
) {}

/** How many failed lookups in a row close an open socket on its recheck. */
export const LOOKUP_FAILURES_TO_CLOSE = 2;

/** How long an admitted peer's whois answer is reused. */
export const ADMITTED_TTL = "30 seconds";

/** How long "no such peer" is reused, so a burst of refused requests asks tailscaled once. */
export const NOT_FOUND_TTL = "5 seconds";

const fromLoopback = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(request.remoteAddress, isLoopbackAddress);

/** Decides who a request or a peer address is. */
export class Identity extends Context.Service<
  Identity,
  {
    /**
     * Admits the peer address Caddy reported, answering the owner's login; fails with
     * `IdentityRefused` for anything that is not an untagged node of the configured owner.
     */
    admit(peer: string): Effect.Effect<string, IdentityRefused>;
    /** The login a request carries through the guard, or `None` when it is not the owner's. */
    viewerOf(
      request: HttpServerRequest.HttpServerRequest
    ): Option.Option<string>;
    /**
     * Whether the peer behind an open socket is still admitted; asked every minute, so a node
     * removed from the tailnet loses its socket.
     */
    stillAdmitted(
      request: HttpServerRequest.HttpServerRequest
    ): Effect.Effect<boolean>;
  }
>()("cairn/server/http/Identity") {
  /** The real rules over `Tailscale`, with a 30 s cache and a 5 s negative cache per address. */
  static readonly layerNoDeps = Layer.effect(
    Identity,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const tailscale = yield* Tailscale;

      const whois = yield* Cache.makeWith((ip: string) => tailscale.whois(ip), {
        capacity: 1024,
        timeToLive: (exit) => {
          if (Exit.isFailure(exit)) {
            return 0;
          }

          return Option.isSome(exit.value) ? ADMITTED_TTL : NOT_FOUND_TTL;
        },
      });

      const admit = Effect.fn("Identity.admit")(function* (peer: string) {
        if (peer === "") {
          return yield* new IdentityRefused({
            message:
              "Identity refused a request with no peer address from Caddy.",
            reason: "no_peer",
          });
        }

        if (isIP(peer) === 0) {
          return yield* new IdentityRefused({
            message: "Identity refused a peer that is not an IP address.",
            reason: "not_an_ip",
          });
        }

        const found = yield* Cache.get(whois, peer).pipe(
          Effect.catchTag("TailscaleUnavailable", (error) =>
            Effect.fail(
              new IdentityRefused({
                message: `Identity could not ask tailscaled about the peer: ${error.message}`,
                reason: "lookup_failed",
              })
            )
          )
        );

        if (Option.isNone(found)) {
          return yield* new IdentityRefused({
            message: "Identity refused an address that is not a tailnet peer.",
            reason: "not_on_tailnet",
          });
        }

        if (found.value.tags.length > 0) {
          return yield* new IdentityRefused({
            message: `Identity refused tagged node ${found.value.nodeName}.`,
            reason: "tagged_node",
          });
        }

        if (found.value.loginName !== config.owner) {
          return yield* new IdentityRefused({
            message: `Identity refused node ${found.value.nodeName}, which belongs to another login.`,
            reason: "not_the_owner",
          });
        }

        return config.owner;
      });

      const viewerOf = (request: HttpServerRequest.HttpServerRequest) =>
        request.headers[USER_HEADER] === config.owner
          ? Option.some(config.owner)
          : Option.none();

      // Lookup failures in a row, per socket (its upgrade request). A tailscaled hiccup keeps an
      // admitted socket; a definite refusal, or `LOOKUP_FAILURES_TO_CLOSE` failures in a row,
      // closes it (T21).
      const lookupFailures = new WeakMap<
        HttpServerRequest.HttpServerRequest,
        number
      >();

      const stillAdmitted = Effect.fn("Identity.stillAdmitted")(function* (
        request: HttpServerRequest.HttpServerRequest
      ) {
        const peer = forwardedPeer(request);

        if (Option.isNone(peer)) {
          return false;
        }

        return yield* admit(peer.value).pipe(
          Effect.as(true),
          Effect.tap(() =>
            Effect.sync(() => {
              lookupFailures.delete(request);
            })
          ),
          Effect.catchTag("IdentityRefused", (refused) =>
            Effect.sync(() => {
              if (refused.reason !== "lookup_failed") {
                return false;
              }

              const failures = (lookupFailures.get(request) ?? 0) + 1;

              lookupFailures.set(request, failures);

              return failures < LOOKUP_FAILURES_TO_CLOSE;
            })
          )
        );
      });

      return Identity.of({ admit, viewerOf, stillAdmitted });
    })
  );

  /** The production rules: `Tailscale` over LocalAPI and the CLI. Needs `ServerConfig`. */
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(Tailscale.layer));

  /**
   * Development only: every request that reaches the loopback listener from a loopback address
   * is the owner, with no Caddy and no header. Only `dev-main.ts` composes it.
   */
  static readonly layerLoopbackOwner = Layer.effect(
    Identity,
    Effect.gen(function* () {
      const config = yield* ServerConfig;

      return Identity.of({
        admit: () => Effect.succeed(config.owner),
        viewerOf: (request) =>
          fromLoopback(request) ? Option.some(config.owner) : Option.none(),
        stillAdmitted: (request) => Effect.succeed(fromLoopback(request)),
      });
    })
  );
}

const refusal = HttpServerResponse.text(
  "Cairn admits only its owner's devices on the tailnet.\n",
  { status: 403, headers: { "cache-control": "no-store" } }
);

// Headers that may carry credentials are never logged, even on the no-peer diagnosis.
const UNLOGGED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/**
 * Whether a request reached the brain through Caddy's main proxy rather than as its auth
 * subrequest. `forward_auth` always sets `X-Cairn-Peer` (empty when Caddy has no remote host), and
 * the main proxy strips it and adds `Via` and the copied `X-Cairn-User`. A request with neither is a
 * direct loopback call, which the route still answers.
 */
const viaMainProxy = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers[PEER_HEADER] === undefined &&
  (request.headers.via !== undefined ||
    request.headers[USER_HEADER] !== undefined);

/**
 * Caddy marks a request sent in TLS early data (QUIC 0-RTT) with `Early-Data: 1` and leaves
 * `{remote_host}` empty for it, because the address cannot be trusted before the handshake ends.
 * 425 asks the browser to send it again once the handshake is done (RFC 8470), where a 403 would
 * refuse the owner's page load outright.
 */
const tooEarly = HttpServerResponse.text("Too early: send again.\n", {
  status: 425,
  headers: { "cache-control": "no-store" },
});

const notFound = HttpServerResponse.text("Not found.\n", {
  status: 404,
  headers: { "cache-control": "no-store" },
});

/**
 * `GET /_cairn/auth`, Caddy's `forward_auth` endpoint: 200 with `X-Cairn-User` for the owner's
 * nodes, otherwise a generic 403. The reason goes to the log only; an empty peer logs every
 * header (`event: no-peer`) to diagnose the first-load-after-Wi-Fi case cairn-v1 saw once. Asked
 * through the main proxy (`code.gneiss.run/_cairn/auth`) it is a plain 404 with nothing logged
 * (T25), so a page cannot fill the log with header dumps.
 */
export const AuthRoute = HttpRouter.add(
  "GET",
  "/_cairn/auth",
  Effect.gen(function* () {
    const identity = yield* Identity;
    const request = yield* HttpServerRequest.HttpServerRequest;

    if (viaMainProxy(request)) {
      return notFound;
    }

    const peer = request.headers[PEER_HEADER] ?? "";

    if (peer === "" && request.headers["early-data"] === "1") {
      yield* Effect.logInfo("auth request in early data").pipe(
        Effect.annotateLogs({ event: "auth-too-early" })
      );

      return tooEarly;
    }

    if (peer === "") {
      yield* Effect.logWarning("auth request without a peer").pipe(
        Effect.annotateLogs({
          event: "no-peer",
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              ([name]) => !UNLOGGED_HEADERS.has(name)
            )
          ),
        })
      );
    }

    return yield* identity.admit(peer).pipe(
      Effect.map((login) =>
        HttpServerResponse.empty({
          status: 200,
          headers: { [USER_HEADER]: login, "cache-control": "no-store" },
        })
      ),
      Effect.catchTag("IdentityRefused", (refused) =>
        Effect.logInfo("auth refused").pipe(
          Effect.annotateLogs({
            event: "auth-refused",
            peer,
            reason: refused.reason,
          }),
          Effect.as(refusal)
        )
      )
    );
  })
);
