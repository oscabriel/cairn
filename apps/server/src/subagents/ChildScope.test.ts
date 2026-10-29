// The build scan of ADR 0034: per-scope layers under `subagents/` and `workflows/` are built only
// through `ChildScope.build`. A direct `Layer.build`, `Layer.buildWithScope`, `Layer.launch`,
// `Effect.provide` (of a layer or anything else: `provideService` and `provideContext` take values
// and stay allowed), `LayerMap.make`, or a `Layer.buildWithMemoMap` outside `ChildScope.ts` would
// build into the inherited memo map and hand a child its parent's instance
// (`brain/MemoMapIsolation.test.ts`). Comments are left out, so a module may name the rule. Tests
// are not scanned: they build their own roots. The scan is first shown to catch planted
// violations, then run over both folders.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const SCANNED = ["subagents", "workflows"];

/** The one module that may build with a memo map. */
const CHILD_SCOPE = path.join("subagents", "ChildScope.ts");

const REFUSED: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly what: string;
}> = [
  { pattern: /\bLayer\.build\b(?!WithMemoMap)/u, what: "Layer.build" },
  { pattern: /\bLayer\.buildWithScope\b/u, what: "Layer.buildWithScope" },
  { pattern: /\bLayer\.launch\b/u, what: "Layer.launch" },
  {
    pattern: /\bEffect\.provide\b(?!Service|Context)/u,
    what: "Effect.provide",
  },
  { pattern: /\bLayerMap\.make\b/u, what: "LayerMap.make" },
];

const MEMO_MAP_BUILD = /\bLayer\.buildWithMemoMap\b/u;

/** `source` without its comments, line structure kept. */
const withoutComments = (source: string) =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (block) =>
      block.replaceAll(/[^\n]/gu, " ")
    )
    .replaceAll(/(?<lead>^|[^:"'`])\/\/.*$/gmu, "$<lead>");

/** Every refused build in one module's source, described; `childScope` for `ChildScope.ts`. */
const violations = (source: string, childScope: boolean) => {
  const code = withoutComments(source);

  const found: Array<string> = REFUSED.flatMap(({ pattern, what }) =>
    pattern.test(code) ? [`calls ${what}`] : []
  );

  if (!childScope && MEMO_MAP_BUILD.test(code)) {
    found.push("builds with a memo map outside ChildScope.build");
  }

  return found;
};

const modulesUnder = (folder: string): ReadonlyArray<string> =>
  readdirSync(folder).flatMap((name) => {
    const file = path.join(folder, name);

    if (statSync(file).isDirectory()) {
      return modulesUnder(file);
    }

    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [file] : [];
  });

const root = path.join(import.meta.dirname, "..");

describe("per-scope layers go through ChildScope.build", () => {
  it("the scan catches each refused build", () => {
    assert.deepStrictEqual(
      violations("const built = yield* Layer.build(Lease.layer);", false),
      ["calls Layer.build"]
    );
    assert.deepStrictEqual(
      violations("run.pipe(Effect.provide(Budget.layer));", false),
      ["calls Effect.provide"]
    );
    assert.deepStrictEqual(
      violations(
        "const leases = yield* LayerMap.make(() => Lease.layer);",
        false
      ),
      ["calls LayerMap.make"]
    );
    assert.deepStrictEqual(
      violations("yield* Layer.buildWithScope(Lease.layer, scope);", false),
      ["calls Layer.buildWithScope"]
    );
    assert.deepStrictEqual(violations("Layer.launch(App.layer);", false), [
      "calls Layer.launch",
    ]);
    assert.deepStrictEqual(
      violations("yield* Layer.buildWithMemoMap(layer, map, scope);", false),
      ["builds with a memo map outside ChildScope.build"]
    );
  });

  it("the scan lets values, comments and ChildScope itself through", () => {
    assert.deepStrictEqual(
      violations(
        [
          "// Never call Layer.build here; use ChildScope.build.",
          "/** Not Effect.provide(layer) either. */",
          "run.pipe(Effect.provideService(Rows, rows));",
          "run.pipe(Effect.provideContext(context));",
          "const lease = yield* ChildScope.build(Lease.layer);",
        ].join("\n"),
        false
      ),
      []
    );
    assert.deepStrictEqual(
      violations(
        "yield* Layer.buildWithMemoMap(layer, yield* Layer.makeMemoMap, scope);",
        true
      ),
      []
    );
  });

  it("no module under subagents/ or workflows/ builds a layer directly", () => {
    const found = SCANNED.flatMap((folder) => {
      const at = path.join(root, folder);

      return existsSync(at) ? modulesUnder(at) : [];
    }).flatMap((file) => {
      const relative = path.relative(root, file);

      return violations(
        readFileSync(file, "utf-8"),
        relative === CHILD_SCOPE
      ).map((violation) => `${relative} ${violation}`);
    });

    assert.deepStrictEqual(found, []);
  });
});
