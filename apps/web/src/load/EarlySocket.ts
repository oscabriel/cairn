// The socket opened before Foldkit mounts (plan D46, notes/edges.md section 3 "Connection order"):
// `main.ts` calls `openEarlySocket` as its first statement, so the TLS handshake and the upgrade
// run while the app's first frame is built, and the connection resource's first dial is handed
// that socket instead of opening another. Every later dial (a reconnect) opens a new one. A socket
// that closed before the app asked for it is dropped, and the app dials as usual.
import { PROTOCOL_QUERY_PARAM, PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import { Layer, Option, Predicate } from "effect";
import { Socket } from "effect/socket";

/**
 * The URL `connection/Connection.ts` dials (its `socketUrl`), rebuilt here because the connection
 * module provides this module's layer and an import back would be a cycle. `Load.test.ts` holds
 * the two equal.
 */
export const earlySocketUrl = (origin: string): string => {
  const url = new URL("/ws", origin);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));

  return url.toString();
};

// Held outside the Model on purpose: the socket is opened before Foldkit starts, and the
// connection resource takes it on its first dial. Keyed by URL; a taken socket leaves the map.
/** The pre-opened socket by URL, until the first dial takes it. */
const early = new Map<string, WebSocket>();

/** The URLs this page opened early, for the load report's request count. */
const openedUrls = new Set<string>();

/** Opens `/ws` now. Safe to call more than once: only the first call opens a socket. */
export const openEarlySocket = (): void => {
  if (openedUrls.size > 0 || !("WebSocket" in globalThis)) {
    return;
  }

  const url = earlySocketUrl(location.origin);

  openedUrls.add(url);
  early.set(url, new WebSocket(url));
};

/** True when this page opened its socket early. */
export const openedEarly = (): boolean => openedUrls.size > 0;

const CONNECTING = 0;

const OPEN = 1;

/** Takes the early socket for `url` if it is still connecting or open. */
const takeEarly = (url: string): Option.Option<WebSocket> => {
  const socket = Option.fromNullishOr(early.get(url));

  early.delete(url);

  return Option.filter(
    socket,
    (candidate) =>
      candidate.readyState === CONNECTING || candidate.readyState === OPEN
  );
};

/**
 * `Socket.WebSocketConstructor` over the global `WebSocket`, whose first dial to the early
 * socket's URL gets the early socket. Provide it where the connection provides
 * `Socket.layerWebSocketConstructorGlobal`.
 */
export const layerEarlyWebSocketConstructor = Layer.succeed(
  Socket.WebSocketConstructor
)((url, options) =>
  Option.getOrElse(
    takeEarly(url),
    () =>
      new globalThis.WebSocket(
        url,
        Predicate.isString(options) || Array.isArray(options)
          ? options
          : undefined
      )
  )
);
