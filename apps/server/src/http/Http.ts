// The one listener: loopback only (Caddy is the way in), `perMessageDeflate` on, and a 2 s grace
// on shutdown so a restart closes sockets with 1001 quickly instead of hanging for Node's default
// 20 s (`notes/effect.md`, measured). Logs one `listening` line with the bound port, which deploy
// scripts and judges wait for (`CAIRN_PORT=0` binds a free port). The server layer follows t3code
// `apps/server/src/server.ts` lines 295 to 314 at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, without
// its serving gate, which Cairn keeps per route (`/ws` answers 503 until ready); the forced close of
// unanswered sockets is Cairn's.
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
import { createServer } from "node:http";
import type { Duplex } from "node:stream";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { ServerConfig } from "../Config.ts";
import { Shutdown } from "../Shutdown.ts";
import { Routes } from "./Routes.ts";

// The server waits for every connection on close, and a WebSocket whose peer never answers the
// 1001 close frame (a phone asleep, a half-dead link) would hold the process until systemd's
// SIGKILL. So upgraded sockets are tracked, and whatever is still open once the 2 s grace has
// passed is destroyed: `ForceClose` is built after the server and before the router, so its
// finalizer runs after the router's graceful close and before the server's own close.
const Listener = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const server = createServer();
    const upgraded = new Set<Duplex>();

    server.on("upgrade", (_request, socket) => {
      upgraded.add(socket);
      socket.once("close", () => {
        upgraded.delete(socket);
      });
    });

    const ForceClose = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const socket of upgraded) {
            socket.destroy();
          }

          server.closeAllConnections();
        })
      )
    );

    return ForceClose.pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(() => server, {
          host: config.listenHost,
          port: config.port,
          gracefulShutdownTimeout: "2 seconds",
          websocket: { perMessageDeflate: true },
        })
      )
    );
  })
);

const Served = HttpRouter.serve(Routes, {
  disableLogger: true,
  disableListenLog: true,
});

// Built after the router is serving, so its finalizer runs first on shutdown: `closing` is logged
// and new sockets are refused before the server starts closing the open ones.
const Listening = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const shutdown = yield* Shutdown;
    const { address } = server;
    const port = "port" in address ? address.port : 0;

    yield* Effect.logInfo(
      `listening on ${HttpServer.formatAddress(address)}`
    ).pipe(Effect.annotateLogs({ event: "listening", port, pid: process.pid }));
    yield* Effect.addFinalizer(() => shutdown.begin);
  })
);

/**
 * The HTTP server with every route. Needs `ServerConfig`, `Shutdown` and whatever the routes
 * need (`Identity`, `Health`, `BootJson`, the RPC handlers).
 */
export const HttpLive = Listening.pipe(
  Layer.provide(Served),
  Layer.provideMerge(Listener)
);
