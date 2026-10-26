// The durability judge's stand-in for Caddy: a loopback reverse proxy in front of one judge brain
// that adds the identity header Caddy copies (`X-Cairn-User`) and passes WebSocket upgrades
// through. The brain keeps its port across restarts, so the proxy outlives every kill, and the
// Chromium page reconnects through it exactly as it would through Caddy.
//
// Adapted from `startProxy` in `judges/load.ts` (Cairn's own code). Changed: no compression, since
// this judge measures convergence, not bytes, and an upstream that is down closes the client's
// socket at once so the page's reconnect sees the outage.

import { once } from "node:events";
import http from "node:http";
import net from "node:net";

const LOOPBACK = "127.0.0.1";

export interface Proxy {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Listens on `port` and forwards to the brain on `target`, both on loopback. */
export const startProxy = async (
  port: number,
  target: number,
  owner: string
): Promise<Proxy> => {
  const sockets = new Set<net.Socket>();

  const server = http.createServer((request, response) => {
    const upstream = http.request(
      {
        host: LOOPBACK,
        port: target,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, "x-cairn-user": owner },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on("error", () => {
          response.destroy();
        });
        answer.pipe(response);
      }
    );

    upstream.on("error", () => {
      response.destroy();
    });
    request.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const upstream = net.connect(target, LOOPBACK, () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];

      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(
          `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`
        );
      }

      lines.push(`x-cairn-user: ${owner}`, "", "");
      upstream.write(lines.join("\r\n"));
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", () => {
      socket.destroy();
    });
    upstream.on("close", () => {
      socket.destroy();
    });
    socket.on("error", () => {
      upstream.destroy();
    });
  });

  server.listen(port, LOOPBACK);
  await once(server, "listening");

  return {
    port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
      await once(server, "close");
    },
  };
};
