// @vitest-environment node
// Every primitive ships (U-12): the look judge (`judges/look-rules.ts`) certifies the
// catalogue's primitives, so each primitive module in `ui/` is drawn by at least one live view
// outside `ui/` and its catalogue. A primitive nothing draws is deleted, or adopted where a view
// hand-rolls a copy of it; this test fails on one left behind.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const src = path.join(import.meta.dirname, "..");

const ui = import.meta.dirname;

/** Shared helpers of the primitives, not primitives a view draws on its own. */
const HELPERS = new Set([
  "Classes",
  "Tone",
  "SceneFixture",
  "ClassNames",
  "Child",
]);

const sourcesUnder = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourcesUnder(entryPath);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [entryPath]
      : [];
  });

const primitives = readdirSync(ui)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => name.slice(0, -".ts".length))
  .filter((name) => !HELPERS.has(name));

/** The live views: every source outside `ui/` (the catalogue lives there). */
const liveSources = sourcesUnder(src)
  .filter((file) => !file.startsWith(`${ui}${path.sep}`))
  .map((file) => readFileSync(file, "utf-8"));

describe("the primitives", () => {
  it("are each drawn by a live view, not only by the catalogue", () => {
    assert.isAbove(primitives.length, 10);

    const unused = primitives.filter(
      (name) => !liveSources.some((text) => text.includes(`/ui/${name}.ts"`))
    );

    assert.deepStrictEqual(unused, []);
  });
});
