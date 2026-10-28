// `GET /ws?protocol=2`: one WebSocket, one RPC server per socket (ADR 0007, plan D45). The guard has
// already checked host, identity and Origin. Here: an unknown protocol gets HTTP 426, a brain that
// is booting or closing gets 503, and otherwise the upgrade becomes a socket whose RPC server runs
// in the request's scope, so closing the socket ends every subscription it owns. The identity
// decided at the upgrade reaches handlers as `Viewer` through `ViewerMiddleware`; it is asked again
// every minute and the socket is closed once the peer is no longer admitted.
// The socket lifecycle follows t3code `apps/server/src/ws.ts` lines 3128 to 3270 at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (server options, `makeProtocolWithHttpEffectWebsocket`,
// `forkScoped`, the 426 answer, racing the socket against a revocation); sessions, analytics and
// t3code's service graph are not ported, and the revocation is Cairn's identity re-check.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { Unauthorized } from "@cairn/protocol/Errors";
import {
  CairnRpcs,
  PROTOCOL_QUERY_PARAM,
  PROTOCOL_VERSION,
  Viewer,
  ViewerMiddleware,
} from "@cairn/protocol/Rpc";
import { Context, Duration, Effect, Layer, Option, Ref } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { Shutdown } from "../Shutdown.ts";
import { Health } from "./Health.ts";
import { Identity } from "./Identity.ts";

/** How often an open socket's identity is asked again. */
export const IdentityRecheckInterval = Context.Reference<Duration.Duration>(
  "cairn/server/http/Ws/IdentityRecheckInterval",
  { defaultValue: () => Duration.minutes(1) }
);

// RpcServer's default sends a socket-level Defect frame instead, and the client ends every pending
// request on the socket with it (t3code `WS_RPC_SERVER_OPTIONS`).
const rpcServer = RpcServer.make(CairnRpcs, {
  disableTracing: true,
  disableFatalDefects: true,
});

/** What every socket's RPC server needs besides its protocol and its viewer: the handlers. */
type SocketServices = Exclude<
  Effect.Services<typeof rpcServer>,
  RpcServer.Protocol | ViewerMiddleware
>;

const incompatible = HttpServerResponse.jsonUnsafe(
  {
    code: "protocol_incompatible",
    message: `Reload the page: this server speaks protocol ${PROTOCOL_VERSION}.`,
    protocol: PROTOCOL_VERSION,
  },
  { status: 426, headers: { "cache-control": "no-store" } }
);

const unavailable = HttpServerResponse.jsonUnsafe(
  {
    code: "unavailable",
    message: "The brain is starting or stopping. Reconnect in a moment.",
  },
  { status: 503, headers: { "cache-control": "no-store", "retry-after": "1" } }
);

const speaksProtocol = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(
    HttpServerRequest.toURL(request),
    (url) =>
      url.searchParams.get(PROTOCOL_QUERY_PARAM) === String(PROTOCOL_VERSION)
  );

/**
 * The `/ws` route. Needs the RPC handlers (`rpc/Handlers.ts`), `Identity`, `Health` and `Shutdown`.
 */
export const WsRoute = Layer.unwrap(
  Effect.gen(function* () {
    const handlers = yield* Effect.context<SocketServices>();
    const identity = yield* Identity;
    const health = yield* Health;
    const shutdown = yield* Shutdown;

    const socket = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if (!speaksProtocol(request)) {
        return incompatible;
      }

      if (!(yield* health.isReady) || (yield* shutdown.isClosing)) {
        return unavailable;
      }

      const viewer = identity.viewerOf(request);

      if (Option.isNone(viewer)) {
        // The guard refuses these first; this is the belt to its braces.
        return HttpServerResponse.text("Forbidden.\n", { status: 403 });
      }

      const login = viewer.value;
      const revoked = yield* Ref.make(false);

      const viewerMiddleware = ViewerMiddleware.of((effect) =>
        Effect.gen(function* () {
          if (yield* Ref.get(revoked)) {
            return yield* new Unauthorized({
              message:
                "Unauthorized: this device is no longer admitted. Reload the page to sign in again.",
            });
          }

          return yield* Effect.provideService(effect, Viewer, { login });
        })
      );

      const { protocol, httpEffect } =
        yield* RpcServer.makeProtocolWithHttpEffectWebsocket;

      yield* rpcServer.pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provideService(ViewerMiddleware, viewerMiddleware),
        Effect.provideContext(handlers),
        Effect.forkScoped
      );

      const interval = yield* IdentityRecheckInterval;

      const recheck = identity
        .stillAdmitted(request)
        .pipe(
          Effect.delay(interval),
          Effect.repeat({ while: (admitted) => admitted }),
          Effect.andThen(Ref.set(revoked, true)),
          Effect.andThen(
            Effect.logInfo("socket closed: identity no longer admitted").pipe(
              Effect.annotateLogs({ event: "socket-revoked", login })
            )
          ),
          Effect.as(HttpServerResponse.empty())
        );

      return yield* Effect.raceFirst(httpEffect, recheck);
    }).pipe(
      Effect.provideService(
        RpcSerialization.RpcSerialization,
        RpcSerialization.json
      )
    );

    return HttpRouter.add("GET", "/ws", socket);
  })
);
