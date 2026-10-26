// The Node protocol client the judges share: one `RpcClient` over one WebSocket to `GET /ws?protocol=1`,
// the same wire the browser speaks (ADR 0007), with the headers a browser or Caddy would add.
//
//   const client = yield* ProtocolClient.cairn({ base: "http://127.0.0.1:3774", origin: "https://code.gneiss.run" })
//   const hello = yield* client["session.hello"]()
//
// Node's WebSocket cannot set `Origin`, so the socket comes from `NodeSocket.layerWebSocket` with handshake
// headers, which uses the `ws` package. A client never reconnects by itself (`retryPolicy: recurs(0)`): when
// its socket drops, every call fails with an `RpcClientError` and the judge decides what to do, usually
// opening a new client in a new scope. That is also the browser's rule (plan, "Client connection rules").

import {
  CairnRpcs,
  PROTOCOL_QUERY_PARAM,
  PROTOCOL_VERSION,
} from "@cairn/protocol/Rpc";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import type { Duration, Scope } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { Rpc, RpcClientError, RpcGroup } from "effect/rpc";

export interface ProtocolClientOptions {
  /** The server's base URL, `http://127.0.0.1:<port>` or `https://code.gneiss.run`. */
  readonly base: string;
  /** Sent as `Origin` on the upgrade; the guard refuses an upgrade without Cairn's own origin. */
  readonly origin: string;
  /**
   * More upgrade headers. A judge that talks to the brain's port directly, without Caddy, sends
   * `Host` and the identity header Caddy would have copied (`X-Cairn-User`).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to this checkout's `PROTOCOL_VERSION`; a judge sets another to see the 426. */
  readonly protocol?: number;
  readonly openTimeout?: Duration.Input;
  readonly pingInterval?: Duration.Input;
  readonly pingTimeout?: Duration.Input;
}

/** `GET /ws?protocol=<n>` on the base URL, with `http` turned into `ws`. */
export const socketUrl = (base: string, protocol: number): string => {
  const url = new URL("/ws", base);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  url.searchParams.set(PROTOCOL_QUERY_PARAM, String(protocol));

  return url.toString();
};

/** The client `Protocol` over one socket: JSON serialization, the browser's ping rules, no retries. */
export const layerProtocol = (
  options: ProtocolClientOptions
): Layer.Layer<RpcClient.Protocol> =>
  RpcClient.layerProtocolSocket({
    retryPolicy: Schedule.recurs(0),
    pingInterval: options.pingInterval ?? "3 seconds",
    pingTimeout: options.pingTimeout ?? "8 seconds",
  }).pipe(
    Layer.provide(
      NodeSocket.layerWebSocket(
        socketUrl(options.base, options.protocol ?? PROTOCOL_VERSION),
        {
          headers: { ...options.headers, Origin: options.origin },
          openTimeout: options.openTimeout ?? "5 seconds",
        }
      )
    ),
    Layer.provide(RpcSerialization.layerJson)
  );

/**
 * Opens a client for any RPC group. The socket lives as long as the caller's scope, so a judge that
 * wants a fresh connection closes the scope and opens another.
 */
export const make = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: ProtocolClientOptions
): Effect.fn.Return<
  RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
  never,
  Scope.Scope | Rpc.MiddlewareClient<Rpcs>
> {
  // The socket must belong to the caller's scope: providing the layer to `make` alone would close
  // the socket as soon as `make` returned.
  const protocol = yield* Layer.build(layerProtocol(options));

  return yield* RpcClient.make(group).pipe(Effect.provideContext(protocol));
});

/** A client for `CairnRpcs`, the one group the brain serves. */
export const cairn = (
  options: ProtocolClientOptions
): Effect.Effect<
  RpcClient.RpcClient<
    RpcGroup.Rpcs<typeof CairnRpcs>,
    RpcClientError.RpcClientError
  >,
  never,
  Scope.Scope
> => make(CairnRpcs, options);
