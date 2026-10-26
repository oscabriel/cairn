// `normalizeWorkspaceRoot` (T40): the same answers as before, and a long path with an empty segment
// is refused at once instead of backtracking for seconds.

import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { normalizeWorkspaceRoot } from "./ShellCommands.ts";

describe(normalizeWorkspaceRoot, () => {
  it("keeps absolute folders and drops one trailing slash", () => {
    expect(normalizeWorkspaceRoot("/")).toStrictEqual(Option.some("/"));
    expect(normalizeWorkspaceRoot("/srv/app/")).toStrictEqual(
      Option.some("/srv/app")
    );
  });

  it("refuses relative paths, dot segments and empty segments", () => {
    for (const path of [
      "srv/app",
      "/srv/../etc",
      "/srv/./app",
      "/srv//app",
      "//",
    ]) {
      expect({ path, root: normalizeWorkspaceRoot(path) }).toStrictEqual({
        path,
        root: Option.none(),
      });
    }
  });

  it("answers a long path with an empty segment quickly", () => {
    const started = performance.now();

    expect(normalizeWorkspaceRoot(`/${"a".repeat(40)}//`)).toStrictEqual(
      Option.none()
    );
    expect(performance.now() - started).toBeLessThan(10);
  });
});
