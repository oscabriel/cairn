// Only one process may hold the Executor grant, so only the deployed brain composes the real link:
// `main.ts` never composes `ExecutorLink.layerFake`, and no other file composes `ExecutorLink.layer`.
// A grep over the server, the judges and the tools, comments left out.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const server = path.join(import.meta.dirname, "..");

const repo = path.join(server, "..", "..", "..");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(full);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });

/** The file's code, with line and block comment lines removed. */
const code = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
    .join("\n");

const REAL_LINK = /\bExecutorLink\.layer(?![A-Za-z])/u;

const FAKE_LINK = /\bExecutorLink\.layerFake\b/u;

const MAIN = path.join(server, "main.ts");

describe("the Executor link's composition", () => {
  it("main.ts never composes the fake link", () => {
    assert.notMatch(code(MAIN), FAKE_LINK);
  });

  it("no file but main.ts composes the real link", () => {
    const files = [
      ...sourceFiles(server),
      ...sourceFiles(path.join(repo, "judges")),
      ...sourceFiles(path.join(repo, "tools")),
    ];

    const composing = files.flatMap((file) =>
      file !== MAIN && REAL_LINK.test(code(file))
        ? [path.relative(repo, file)]
        : []
    );

    assert.deepStrictEqual(composing, []);
  });

  // Until the integrator wires the link into main.ts (3D's hand-off), main.ts names no Executor
  // link at all; from then on it must be the real one.
  it.skipIf(!code(MAIN).includes("ExecutorLink"))(
    "main.ts composes the real link",
    () => {
      assert.match(code(MAIN), REAL_LINK);
    }
  );
});
