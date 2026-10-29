// The close-delay check `judges/caddy-reload.ts --live` runs over `caddy adapt`'s JSON: every
// `reverse_proxy` to a required upstream must set `stream_close_delay`, however deep its subroute.

import type { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { checkCloseDelay } from "./ThrowawayCaddy.ts";

const proxy = (dial: string, delay: number | null): Schema.Json =>
  delay === null
    ? { handler: "reverse_proxy", upstreams: [{ dial }] }
    : {
        handler: "reverse_proxy",
        stream_close_delay: delay,
        upstreams: [{ dial }],
      };

/** The shape `caddy adapt` gives a `*.gneiss.run` site with handles: routes inside a subroute. */
const adapted = (
  cairnDelay: number | null,
  t3Delay: number | null
): Schema.Json => ({
  apps: {
    http: {
      servers: {
        srv0: {
          listen: [":443"],
          routes: [
            {
              match: [{ host: ["*.gneiss.run"] }],
              handle: [
                {
                  handler: "subroute",
                  routes: [
                    {
                      group: "group9",
                      match: [{ host: ["code.gneiss.run"] }],
                      handle: [
                        {
                          handler: "subroute",
                          routes: [
                            { handle: [proxy("127.0.0.1:3774", cairnDelay)] },
                          ],
                        },
                      ],
                    },
                    {
                      group: "group9",
                      match: [{ host: ["t3.gneiss.run"] }],
                      handle: [proxy("127.0.0.1:3773", t3Delay)],
                    },
                    { handle: [proxy("127.0.0.1:8096", null)] },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
});

/**
 * A `forward_auth 127.0.0.1:3774 { uri /_cairn/auth ... }` as `caddy adapt` (caddy-caddy, v2.11.2)
 * gives it: a `reverse_proxy` with a GET `rewrite` and a `handle_response`, and no close delay.
 */
const forwardAuth: Schema.Json = {
  handler: "reverse_proxy",
  handle_response: [
    {
      match: { status_code: [2] },
      routes: [{ handle: [{ handler: "vars" }] }],
    },
  ],
  headers: {
    request: {
      set: {
        "X-Cairn-Peer": ["{http.request.remote.host}"],
        "X-Forwarded-Method": ["{http.request.method}"],
        "X-Forwarded-Uri": ["{http.request.uri}"],
      },
    },
  },
  rewrite: { method: "GET", uri: "/_cairn/auth" },
  upstreams: [{ dial: "127.0.0.1:3774" }],
};

/** The live shape after the owner-only edit: a site-level forward_auth, then the handles. */
const guarded = (cairnDelay: number | null): Schema.Json => ({
  apps: {
    http: {
      servers: {
        srv0: {
          routes: [
            {
              handle: [
                {
                  handler: "subroute",
                  routes: [
                    { handle: [forwardAuth] },
                    {
                      match: [{ host: ["code.gneiss.run"] }],
                      handle: [
                        forwardAuth,
                        proxy("127.0.0.1:3774", cairnDelay),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
});

const REQUIRED = ["127.0.0.1:3774", "127.0.0.1:3773"];

const FIVE_MINUTES_NS = 300_000_000_000;

describe(checkCloseDelay, () => {
  it("passes when every required upstream's proxy sets the delay", () => {
    expect(
      checkCloseDelay(adapted(FIVE_MINUTES_NS, FIVE_MINUTES_NS), REQUIRED).ok
    ).toBeTruthy();
  });

  it("fails when one required proxy lacks it", () => {
    const verdict = checkCloseDelay(adapted(FIVE_MINUTES_NS, null), REQUIRED);

    expect(verdict.ok).toBeFalsy();
    expect(verdict.findings).toStrictEqual([
      { dial: "127.0.0.1:3774", handlers: 1, withoutDelay: 0 },
      { dial: "127.0.0.1:3773", handlers: 1, withoutDelay: 1 },
    ]);
  });

  it("fails when a required upstream has no proxy at all", () => {
    const verdict = checkCloseDelay(adapted(FIVE_MINUTES_NS, FIVE_MINUTES_NS), [
      ...REQUIRED,
      "127.0.0.1:8123",
    ]);

    expect(verdict.ok).toBeFalsy();
  });

  it("a zero delay is no delay", () => {
    expect(
      checkCloseDelay(adapted(0, FIVE_MINUTES_NS), REQUIRED).ok
    ).toBeFalsy();
  });

  it("leaves forward_auth subrequests to the same upstream out", () => {
    const verdict = checkCloseDelay(guarded(FIVE_MINUTES_NS), [
      "127.0.0.1:3774",
    ]);

    expect(verdict.ok).toBeTruthy();
    expect(verdict.findings).toStrictEqual([
      { dial: "127.0.0.1:3774", handlers: 1, withoutDelay: 0 },
    ]);
  });

  it("still fails beside forward_auth when the real proxy lacks the delay", () => {
    const verdict = checkCloseDelay(guarded(null), ["127.0.0.1:3774"]);

    expect(verdict.ok).toBeFalsy();
    expect(verdict.findings).toStrictEqual([
      { dial: "127.0.0.1:3774", handlers: 1, withoutDelay: 1 },
    ]);
  });

  it("a forward_auth alone does not count as the upstream's proxy", () => {
    const only: Schema.Json = { routes: [{ handle: [forwardAuth] }] };

    expect(checkCloseDelay(only, ["127.0.0.1:3774"]).ok).toBeFalsy();
  });
});
