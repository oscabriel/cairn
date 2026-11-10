import { readdirSync } from "node:fs";
import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

import { testSlack } from "./tools/test-slack.ts";

// One project per app and package; the `root` project holds tests that live beside judges and ops
// scripts (judges/lib, for example). An app or package without its own config runs in Node. Each
// entry is inline, so it inherits the deadlines below; the web app's entries extend its own config,
// which does not, so they name the deadlines themselves.
//
// The `slow` projects hold the tests that measure cost, run long property loops, spawn processes or
// write lint probes into the working tree. They run in a later group than every other project, so
// Vitest starts them only once the rest have finished, and on one worker, one file at a time: a cost
// ratio is never taken beside fifteen busy workers, and no file that reads the source tree (the
// footguns and composition scans) is running while a lint probe sits in it.

/** Every test deadline's factor (`tools/test-slack.ts`): 1 on a quiet machine. */
const slack = testSlack();

/** Each test's own limit, and each hook's: generous on a quiet machine, scaled under load. */
const deadlines = {
  testTimeout: 15_000 * slack,
  hookTimeout: 30_000 * slack,
};

/** Tests that run alone, after the rest, on one worker; paths from the repository root. */
const SLOW = [
  // Cost and property loops.
  "apps/server/src/brain/ThreadWindow.test.ts",
  "apps/server/src/brain/ThreadWireWorkflows.test.ts",
  // Lint probes, written into real zones of the tree.
  "judges/lint-boundaries.test.ts",
  "judges/lint-rules.test.ts",
  // Process-spawning judges' libraries.
  "judges/lib/lock-held-by-caller.test.ts",
  "judges/lib/Record.test.ts",
];

/** The web app's slow tests: what a frame and a diff render cost. */
const SLOW_WEB = ["src/diff/DiffCost.test.ts", "src/timeline/Cost.test.ts"];

/**
 * How the slow projects run: after every other project (a later group), on one worker that takes
 * their files one after another without starting afresh for each.
 */
const alone = {
  maxWorkers: 1,
  isolate: false,
  sequence: { groupOrder: 1 },
};

/** `paths` (from the repository root) that lie under `root`, relative to it. */
const under = (root: string, paths: ReadonlyArray<string>) =>
  paths.flatMap((file) =>
    file.startsWith(`${root}/`) ? [path.relative(root, file)] : []
  );

/** A Node project over an app or package folder, named after it, without its slow tests. */
const nodeProject = (root: string) => ({
  test: {
    name: path.basename(root),
    root,
    exclude: [...configDefaults.exclude, ...under(root, SLOW)],
  },
});

const WEB_CONFIG = "./apps/web/vitest.config.ts";

export default defineConfig({
  test: {
    passWithNoTests: true,
    globalSetup: ["./tools/vitest-tmpdir.ts"],
    ...deadlines,
    projects: [
      nodeProject("apps/server"),
      ...readdirSync(path.join(import.meta.dirname, "packages")).map((name) =>
        nodeProject(path.join("packages", name))
      ),
      {
        extends: WEB_CONFIG,
        test: {
          name: "web",
          root: "apps/web",
          exclude: [...configDefaults.exclude, ...SLOW_WEB],
          ...deadlines,
        },
      },
      {
        test: {
          name: "root",
          include: [
            "judges/**/*.test.ts",
            "ops/**/*.test.ts",
            "tools/**/*.test.ts",
          ],
          exclude: [
            ...configDefaults.exclude,
            "spikes/**",
            "judges/fixtures/**",
            ...SLOW,
          ],
        },
      },
      {
        test: { name: "slow", include: SLOW, ...alone },
      },
      {
        extends: WEB_CONFIG,
        test: {
          name: "web-slow",
          root: "apps/web",
          include: SLOW_WEB,
          ...alone,
          ...deadlines,
        },
      },
    ],
  },
});
