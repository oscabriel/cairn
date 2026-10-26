// Which way a tailnet peer reaches the Beelink: directly or through a DERP relay. A load report
// carries it so a slow phone load over a relay is told apart from a slow page (plan 4B; kickoff
// Targets: the MacBook's slow loads were DERP warm-up). `tailscale status --json` names each
// peer's current address, empty while the peer is relayed; it sends no packets, unlike `tailscale
// ping`, whose first pings go over DERP while NAT traversal is still finding the direct path. An
// answer is reused for a minute per peer, so a burst of reports asks tailscaled once.

import { isIP } from "node:net";

import { NodeServices } from "@effect/platform-node";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../Config.ts";

/** How a load reached the brain: a direct path, a DERP relay, not a tailnet peer, or unknown. */
export const PathKind = Schema.Literals(["direct", "derp", "local", "unknown"]);

export type PathKind = typeof PathKind.Type;

/** How long one peer's answer is reused. */
export const PATH_TTL = Duration.minutes(1);

const StatusPeer = Schema.Struct({
  TailscaleIPs: Schema.optionalKey(Schema.Array(Schema.String)),
  CurAddr: Schema.optionalKey(Schema.String),
  Relay: Schema.optionalKey(Schema.String),
});

const Status = Schema.Struct({
  Peer: Schema.optionalKey(Schema.Record(Schema.String, StatusPeer)),
});

const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(Status));

/** The tailnet's CGNAT range (100.64.0.0/10) and its IPv6 prefix. */
const isTailnetAddress = (ip: string) => {
  if (ip.toLowerCase().startsWith("fd7a:115c:a1e0:")) {
    return true;
  }

  const octets = ip.replace(/^::ffff:/u, "").split(".");
  const [first, second] = octets.map(Number);

  return (
    octets.length === 4 &&
    first === 100 &&
    second !== undefined &&
    second >= 64 &&
    second <= 127
  );
};

/**
 * The path in `tailscale status --json` output for the peer that owns `ip`: `direct` with a
 * current address, `derp` with none, `unknown` when no peer owns the address or the output does
 * not decode.
 */
export const pathFromStatus = (output: string, ip: string): PathKind => {
  const status = decodeStatus(output);
  const bare = ip.replace(/^::ffff:/u, "");

  const peer = Option.flatMap(status, ({ Peer }) =>
    Option.fromNullishOr(
      Object.values(Peer ?? {}).find((candidate) =>
        (candidate.TailscaleIPs ?? []).includes(bare)
      )
    )
  );

  return Option.match(peer, {
    onNone: (): PathKind => "unknown",
    onSome: (found): PathKind =>
      (found.CurAddr ?? "") === "" ? "derp" : "direct",
  });
};

/** Tells how a peer address reaches the brain right now. */
export class PeerPath extends Context.Service<
  PeerPath,
  {
    /** The peer's path; never fails, an unreadable tailscaled is `unknown`. */
    pathOf(ip: string): Effect.Effect<PathKind>;
  }
>()("cairn/server/load/PeerPath") {
  /** Asks `tailscale status --json`, once a minute per peer. */
  static readonly layerNoDeps = Layer.effect(
    PeerPath,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const ask = Effect.fn("PeerPath.ask")(function* (ip: string) {
        if (isIP(ip) === 0 || !isTailnetAddress(ip)) {
          return "local" satisfies PathKind;
        }

        // The CLI takes no peer argument here: the address is matched in the decoded output.
        const output = yield* spawner
          .string(ChildProcess.make(config.tailscaleCli, ["status", "--json"]))
          .pipe(Effect.timeout("2 seconds"), Effect.option);

        return Option.match(output, {
          onNone: (): PathKind => "unknown",
          onSome: (text) => pathFromStatus(text, ip),
        });
      });

      const cache = yield* Cache.make({
        lookup: ask,
        capacity: 256,
        timeToLive: PATH_TTL,
      });

      return PeerPath.of({
        pathOf: (ip) => Cache.get(cache, ip),
      });
    })
  );

  /** The real lookup with Node's process spawner; needs `ServerConfig`. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );

  /** A fixed answer per address (`local` for any other), for tests and judge brains. */
  static readonly fixed = (table: ReadonlyMap<string, PathKind>) =>
    Layer.succeed(
      PeerPath,
      PeerPath.of({
        pathOf: (ip) =>
          Effect.succeed(
            Option.getOrElse(
              Option.fromNullishOr(table.get(ip)),
              () => "local" as const
            )
          ),
      })
    );
}
