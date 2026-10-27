// The pi-durable footguns brain code must never step on (docs/phase-1/notes/brain.md, "Footguns"),
// checked over the source of `brain/`:
//
// - Nothing inside a `commit(` callback reads through the Session (`snapshot`, `documentState`,
//   `watchDoc`, `getTask`): such reads can queue on the line the callback holds and hang.
// - No `extensions: [` selection: guards and tools stay in the default selection.
// - No Cairn document, entry or task kind starts with `pi.`: that namespace is pi-durable's.
//
// The checks are first shown to catch planted violations, then run over every brain module. Reading
// the wall clock (S8) is the lint rule `automation/no-ambient-nondeterminism`'s to catch.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const SESSION_READS = ["snapshot(", "documentState(", "watchDoc(", "getTask("];

/** The text of each `commit(` call's argument list. */
const commitBodies = (source: string): ReadonlyArray<string> => {
  const bodies: Array<string> = [];
  let from = 0;

  while (true) {
    const at = source.indexOf(".commit(", from);

    if (at === -1) {
      return bodies;
    }

    let depth = 0;
    let end = at + ".commit".length;

    for (; end < source.length; end += 1) {
      const char = source[end];

      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;

        if (depth === 0) {
          break;
        }
      }
    }

    bodies.push(source.slice(at, end + 1));
    from = at + 1;
  }
};

/** Every footgun in one module's source, described. */
const footguns = (source: string): ReadonlyArray<string> => {
  const found: Array<string> = [];

  for (const body of commitBodies(source)) {
    for (const read of SESSION_READS) {
      if (body.includes(`.${read}`)) {
        found.push(`calls ${read.slice(0, -1)} inside a commit`);
      }
    }
  }

  if (/extensions:\s*\[/u.test(source)) {
    found.push("writes an extension selection");
  }

  const kinds = [
    ...source.matchAll(
      /define(?:Doc|DocFamily|Task)\(\{[\s\S]*?(?:kind|name):\s*"(?<kind>[^"]+)"/gu
    ),
    ...source.matchAll(/defineEntry(?:<[^>]*>)?\(\s*"(?<kind>[^"]+)"/gu),
  ].map((match) => match.groups?.kind ?? "");

  for (const kind of kinds) {
    if (kind.startsWith("pi.")) {
      found.push(`defines the reserved kind ${kind}`);
    }
  }

  return found;
};

const brainModules = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);

    if (statSync(full).isDirectory()) {
      return brainModules(full);
    }

    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });

describe("pi-durable footguns", () => {
  it("catches each footgun when it is planted", () => {
    assert.deepStrictEqual(
      footguns(
        "await harness.commit(async (tx) => { await harness.snapshot(Doc, ctx); }, ctx);"
      ),
      ["calls snapshot inside a commit"]
    );
    assert.deepStrictEqual(
      footguns("await conversation.configure({ extensions: [guard] }, ctx);"),
      ["writes an extension selection"]
    );
    assert.deepStrictEqual(
      footguns('const D = defineDoc({ kind: "pi.mine", version: 1 });'),
      ["defines the reserved kind pi.mine"]
    );
    assert.deepStrictEqual(footguns('const E = defineEntry("pi.note");'), [
      "defines the reserved kind pi.note",
    ]);
    assert.deepStrictEqual(
      footguns(
        "await harness.commit(async (tx) => { await tx.doc(Doc); }, ctx); await harness.snapshot(Doc, ctx);"
      ),
      []
    );
  });

  it("finds none in the brain's modules", () => {
    const modules = brainModules(import.meta.dirname);

    assert.isAbove(modules.length, 10);

    const found = modules.flatMap((module) =>
      footguns(readFileSync(module, "utf-8")).map(
        (footgun) => `${path.relative(import.meta.dirname, module)}: ${footgun}`
      )
    );

    assert.deepStrictEqual(found, []);
  });
});
