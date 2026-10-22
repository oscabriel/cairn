// The deployed brain never treats loopback as the owner: `Identity.layerLoopbackOwner` is composed
// by the dev entry point only. A grep, with the dev entry point as its control.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const source = import.meta.dirname;

const read = (file: string) => readFileSync(path.join(source, file), "utf-8");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(full);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });

describe("entry points", () => {
  it("main.ts never composes the loopback-owner identity", () => {
    assert.notInclude(read("main.ts"), "layerLoopbackOwner");
    assert.notInclude(read("judge-main.ts"), "layerLoopbackOwner");
    assert.include(read("dev-main.ts"), "Identity.layerLoopbackOwner");
  });

  it("only the dev entry point and Identity itself name it", () => {
    const naming = sourceFiles(source)
      .filter((file) =>
        readFileSync(file, "utf-8").includes("layerLoopbackOwner")
      )
      .map((file) => path.relative(source, file))
      .toSorted();

    assert.deepStrictEqual(naming, [
      "dev-main.ts",
      path.join("http", "Identity.ts"),
    ]);
  });

  it("main.ts composes the real identity and the deployed settings", () => {
    const main = read("main.ts");

    assert.include(main, "Identity.layer)");
    assert.include(main, "ServerConfig.layer)");
  });
});
