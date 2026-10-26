// What the routes read off a request the same way: its path without the query, and the peer Caddy
// saw for it.

import { Option } from "effect";
import type { HttpServerRequest } from "effect/http";

/** A request URL's path, without its query or fragment. */
export const pathnameOf = (url: string) => {
  const end = url.search(/[?#]/u);

  return end === -1 ? url : url.slice(0, end);
};

/**
 * The address Caddy saw for a proxied request: the last `X-Forwarded-For` entry, which Caddy wrote;
 * the socket's peer for a request that did not come through Caddy.
 */
export const forwardedPeer = (request: HttpServerRequest.HttpServerRequest) => {
  const forwarded = request.headers["x-forwarded-for"];

  return forwarded === undefined
    ? request.remoteAddress
    : Option.fromNullishOr(forwarded.split(",").at(-1)?.trim());
};
