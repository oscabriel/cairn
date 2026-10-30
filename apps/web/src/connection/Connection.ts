// Ported from cairn-v1, apps/web/src/rpc.ts at 1a5cd4a. Kept: one RpcClient per connection, held as
// a Foldkit ManagedResource keyed on the Model's epoch, with the socket's own retry turned off and
// the client built with `Layer.build` inside `acquire` (`Effect.provide` would close the socket as
// soon as the client is made). Changed: Cairn's v2 protocol group, the protocol version on the URL,
// and the plan's ping timings (every 3 s, dropped after 8 s with no frame).

import { Internal } from "@cairn/protocol/Errors";
import {
  CairnRpcs,
  PROTOCOL_QUERY_PARAM,
  PROTOCOL_VERSION,
} from "@cairn/protocol/Rpc";
import { Cause, Effect, Layer, Schedule, Schema } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc";
import { Socket } from "effect/socket";
import { ManagedResource } from "foldkit";

import { layerEarlyWebSocketConstructor } from "../load/EarlySocket.ts";

/** The typed client for every Cairn RPC. Transport failures arrive as `RpcClientError`. */
export type CairnClient = RpcClient.FromGroup<
  typeof CairnRpcs,
  RpcClientError.RpcClientError
>;

/** The connection resource: Commands and Subscriptions read the current client from it. */
export const CairnConnection =
  ManagedResource.tag<CairnClient>()("CairnConnection");

/** The service a Command or Subscription needs in order to read `CairnConnection`. */
export type CairnConnectionService = ManagedResource.ServiceOf<
  typeof CairnConnection
>;

/** The WebSocket URL for a page served from `origin`, carrying the protocol version. */
export const socketUrl = (origin: string): string => {
  const url = new URL("/ws", origin);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));

  return url.toString();
};

const ProtocolLive = RpcClient.layerProtocolSocket({
  retryPolicy: Schedule.recurs(0),
  pingInterval: "3 seconds",
  pingTimeout: "8 seconds",
}).pipe(
  Layer.provide(
    Socket.layerWebSocket(Effect.sync(() => socketUrl(location.origin)))
  ),
  Layer.provide(layerEarlyWebSocketConstructor),
  Layer.provide(RpcSerialization.layerJson)
);

/** What a defect or an undecodable answer from the brain becomes. */
export const BRAIN_INTERNAL_TEXT =
  "The brain answered with an internal error. Reload if it keeps happening.";

/** What a call cut off by a dropped connection says. */
export const CUT_OFF_TEXT =
  "The connection dropped before Cairn answered. Try again once it is back.";

/**
 * A call cut off by a dropped connection: the connection's client was let go while the call was
 * out, which interrupts it. It carries no `retryable` verdict, so it reads as the transport's
 * (`connection/Failure.ts`): nothing known ran, and an outbox item stays at the head.
 */
export class CutOff extends Schema.TaggedError<CutOff>()("CutOff", {
  message: Schema.String,
}) {}

/**
 * The client boundary every Command's call goes through (T19): a server defect or an answer the
 * protocol cannot decode becomes a non-retryable `Internal` failure, which the Command reports,
 * instead of a defect that crashes the page (and, from a saved outbox item, every reload); and a
 * call cut off by an epoch bump becomes a `CutOff` failure, instead of an interruption that ends
 * the page ("All fibers interrupted", wave 6b). Only interruption alone is caught; a defect still
 * becomes `Internal`.
 */
export const withBoundary = <A, E, R>(
  call: Effect.Effect<A, E, R>
): Effect.Effect<A, E | Internal | CutOff, R> =>
  call.pipe(
    Effect.catchDefect(() =>
      Effect.fail(new Internal({ message: BRAIN_INTERNAL_TEXT }))
    ),
    Effect.catchCauseIf(Cause.hasInterruptsOnly, () =>
      Effect.fail(new CutOff({ message: CUT_OFF_TEXT }))
    )
  );

/** Opens one client. Its socket closes when the resource's scope does. */
export const acquireClient = Effect.gen(function* () {
  const context = yield* Layer.build(ProtocolLive);

  return yield* RpcClient.make(CairnRpcs).pipe(Effect.provide(context));
});
