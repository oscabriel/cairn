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
});
