// The routes a URL names (T14): a thread path whose id is not a thread id is NotFound, so the page
// never waits on a thread that cannot exist.
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { Url } from "foldkit";

import { AppRoute, urlToAppRoute } from "./Route.ts";

const routeAt = (path: string) =>
  urlToAppRoute(
    Option.getOrThrow(Url.fromString(`https://code.gneiss.run${path}`))
  );

describe(urlToAppRoute, () => {
  it("names a thread for a well-formed thread id", () => {
    expect(routeAt("/t/0190f0c0-0000-7000-8000-0000000000a1")._tag).toBe(
      "Thread"
    );
  });

  it("is NotFound for a thread path with a malformed id", () => {
    expect(routeAt("/t/not-an-id")).toStrictEqual(
      AppRoute.NotFound({ path: "/t/not-an-id" })
    );
  });
});
