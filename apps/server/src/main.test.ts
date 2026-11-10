// The deployed brain never treats loopback as the owner: `Identity.layerLoopbackOwner` is composed
// by the dev entry point only. A grep, with the dev entry point as its control. And the deployed
// brain loads no test double: `main.ts`'s import closure holds no file named like a fake, faux
// model, fixture, kit or scripted harness, and no file in it declares one (a `Fake*`, `Faux*`,
// `Scripted*`, `Stub*` or `Mock*` name), so a fake kept as a static on a production module is
// caught too. The dev and judge entry points are the control that the walk finds both. Out of the
// rule's reach: a `layerTest` that builds the real service over an in-memory or temporary edge
// (`Database.layerTest`, `SettingsStore.layerTest`, Effect's convention), which imitates nothing,
// and the bridge's scripted Claude Code in `packages/bridge` (`SCRIPTED_ELSEWHERE`).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { closure, isTestDouble, REPO } from "./ImportGraphTestKit.ts";

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

/** The test doubles `entry` loads, each with the file that loads it. */
const doublesLoadedBy = (entry: string) =>
  [...closure(path.join(source, entry))]
    .flatMap(([file, by]) =>
      isTestDouble(file)
        ? [`${path.relative(REPO, file)} loaded by ${path.relative(REPO, by)}`]
        : []
    )
    .toSorted();

/** A declaration that names a double: a fake, faux model, scripted stand-in, stub or mock. */
const DOUBLE_DECLARATION =
  /\b(?:const|let|function\*?|class|interface|type|readonly)\s+(?<name>\w*(?:Fake|Faux|Scripted|Stub|Mock)\w*)/gu;

/**
 * Files outside the server that the deployed brain loads and that declare a double, and why they
 * stay. The rule's reach ends at `apps/server`.
 */
const SCRIPTED_ELSEWHERE: ReadonlyMap<string, string> = new Map([
  [
    path.join("packages", "bridge", "src", "ClaudeSdk.ts"),
    "the bridge's scripted Claude Code (`ClaudeSdk.layerTest`) lives beside the real SDK in packages/bridge, which `BridgeProvider` loads",
  ],
]);

/** The doubles the files `entry` loads declare, each file with its names. */
const doublesDeclaredIn = (entry: string) =>
  [...closure(path.join(source, entry)).keys()]
    .flatMap((file) => {
      const names = [
        ...readFileSync(file, "utf-8").matchAll(DOUBLE_DECLARATION),
      ].map((match) => match.groups?.name ?? "");

      return names.length === 0
        ? []
        : [{ file: path.relative(REPO, file), names: names.join(" ") }];
    })
    .toSorted((a, b) => a.file.localeCompare(b.file));

describe("what the deployed brain loads", () => {
  it("main.ts loads no test double", () => {
    assert.deepStrictEqual(doublesLoadedBy("main.ts"), []);
  });

  it("no file main.ts loads declares a double, but the listed ones", () => {
    assert.deepStrictEqual(
      doublesDeclaredIn("main.ts")
        .filter(({ file }) => !SCRIPTED_ELSEWHERE.has(file))
        .map(({ file, names }) => `${file}: ${names}`),
      []
    );
  });

  it("the walk finds the doubles the dev and judge brains load", () => {
    assert.isNotEmpty(doublesLoadedBy("dev-main.ts"));
    assert.isNotEmpty(doublesLoadedBy("judge-main.ts"));
    assert.isTrue(
      doublesDeclaredIn("dev-main.ts").some(
        ({ file }) =>
          file === path.join("apps", "server", "src", "reach", "FakePorch.ts")
      )
    );

    for (const listed of SCRIPTED_ELSEWHERE.keys()) {
      assert.isTrue(
        doublesDeclaredIn("main.ts").some(({ file }) => file === listed),
        `${listed} is still loaded and still declares a double`
      );
    }
  });
});
