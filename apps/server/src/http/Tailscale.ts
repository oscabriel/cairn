// Asks tailscaled who is behind a tailnet address. LocalAPI first (`/localapi/v0/whois` over
// tailscaled's unix socket, 0.13 ms median when measured), then the `tailscale whois --json` CLI
// when the socket does not answer. Whois mechanics follow cairn-v1 `apps/server/src/Gate.ts`
// at 1a5cd4a; the cache and the admission rules live in `Identity`.

import http from "node:http";
import { isIP } from "node:net";

import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../Config.ts";

/** One tailnet node and the user who owns it. */
export interface Peer {
  /** The node's stable id. */
  readonly stableId: string;
  /** The owner's login, compared exactly (`oscabriel@github`). */
  readonly loginName: string;
  /** ACL tags; a tagged node belongs to no person and is never admitted. */
  readonly tags: ReadonlyArray<string>;
  readonly nodeName: string;
}

/** Neither LocalAPI nor the CLI answered. Nothing is cached; the next request asks again. */
export class TailscaleUnavailable extends Schema.TaggedError<TailscaleUnavailable>()(
  "TailscaleUnavailable",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

// The part of tailscaled's `WhoIsResponse` Cairn reads.
const WhoIs = Schema.Struct({
  Node: Schema.Struct({
    StableID: Schema.String,
    Name: Schema.String,
    Tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  }),
  UserProfile: Schema.Struct({ LoginName: Schema.String }),
});

const decodeWhoIs = Schema.decodeUnknownOption(Schema.fromJsonString(WhoIs));

/** Parses tailscaled's whois JSON; `None` for anything else (a "peer not found" text, say). */
const peerFromWhoIs = (body: string): Option.Option<Peer> =>
  Option.map(decodeWhoIs(body), (whois) => ({
    stableId: whois.Node.StableID,
    loginName: whois.UserProfile.LoginName,
    tags: whois.Node.Tags ?? [],
    nodeName: whois.Node.Name,
  }));

/** What LocalAPI said: a body for 200, `NotFound` for any other status. */
type LocalApiAnswer =
  | { readonly found: true; readonly body: string }
  | { readonly found: false };

const LOCAL_API_TIMEOUT_MS = 1000;

const localApiWhois = (socketPath: string, ip: string) =>
  Effect.callback<LocalApiAnswer, TailscaleUnavailable>((resume) => {
    const request = http.get(
      {
        socketPath,
        host: "local-tailscaled.sock",
        path: `/localapi/v0/whois?addr=${encodeURIComponent(`${ip}:1`)}`,
        timeout: LOCAL_API_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resume(
            Effect.succeed(
              response.statusCode === 200
                ? { found: true, body: Buffer.concat(chunks).toString("utf-8") }
                : { found: false }
            )
          );
        });
        response.on("error", (cause) => {
          resume(
            Effect.fail(
              new TailscaleUnavailable({
                message: "Tailscale LocalAPI broke off its whois answer.",
                cause,
              })
            )
          );
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("LocalAPI whois timed out"));
    });
    request.on("error", (cause) => {
      resume(
        Effect.fail(
          new TailscaleUnavailable({
            message: "Tailscale LocalAPI did not answer whois.",
            cause,
          })
        )
      );
    });

    return Effect.sync(() => request.destroy());
  });

/** Looks up tailnet peers by address. */
export class Tailscale extends Context.Service<
  Tailscale,
  {
    /**
     * The node and owner behind `ip`, or `None` when tailscaled knows no such peer (a LAN or
     * loopback address, a node that left). `ip` must already be a bare IP address.
     */
    whois(ip: string): Effect.Effect<Option.Option<Peer>, TailscaleUnavailable>;
  }
>()("cairn/server/http/Tailscale") {
  /** LocalAPI over tailscaled's socket, falling back to the CLI. */
  static readonly layerNoDeps = Layer.effect(
    Tailscale,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const cliWhois = Effect.fn("Tailscale.cliWhois")(function* (ip: string) {
        // `ip` passed isIP and is one argv entry, never a shell string. "Peer not found" exits
        // non-zero with text on stdout, which does not decode, so it reads as no peer.
        const output = yield* spawner
          .string(
            ChildProcess.make(config.tailscaleCli, ["whois", "--json", ip])
          )
          .pipe(
            Effect.timeout("2 seconds"),
            Effect.mapError(
              (cause) =>
                new TailscaleUnavailable({
                  message: "The tailscale CLI did not answer whois.",
                  cause,
                })
            )
          );

        return peerFromWhoIs(output);
      });

      const whois = Effect.fn("Tailscale.whois")(function* (ip: string) {
        if (isIP(ip) === 0) {
          return Option.none<Peer>();
        }

        const answer = yield* localApiWhois(config.tailscaleSocket, ip).pipe(
          Effect.asSome,
          Effect.catchTag("TailscaleUnavailable", (error) =>
            Effect.logWarning(
              "tailscale localapi unavailable, using the CLI"
            ).pipe(
              Effect.annotateLogs({ cause: String(error.cause) }),
              Effect.as(Option.none<LocalApiAnswer>())
            )
          )
        );

        if (Option.isNone(answer)) {
          return yield* cliWhois(ip);
        }

        return answer.value.found
          ? peerFromWhoIs(answer.value.body)
          : Option.none<Peer>();
      });

      return Tailscale.of({ whois });
    })
  );

  /** The real lookup with Node's process spawner; needs `ServerConfig`. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );

  /** A fixed table of peers by address, for tests and the judges' composition root. */
  static readonly fixed = (table: ReadonlyMap<string, Peer>) =>
    Layer.succeed(
      Tailscale,
      Tailscale.of({
        whois: (ip) => Effect.succeed(Option.fromNullishOr(table.get(ip))),
      })
    );
}
