// A reactor's handler runs inside the commit that moves its cursor (ADR 0033), so it is held to the
// commit callback's rules (spec 12, "Long transactions"; `Footguns.test.ts`), checked over the
// source of every `reactor(` call in the server and the judge fixtures:
//
// - No Session read (`snapshot`, `documentState`, `watchDoc`, `getTask`): it can queue on the line
//   the commit holds and hang.
// - No await of anything but `tx`: each awaited expression is a `tx.` call or a helper given `tx`
//   as its first argument. Outside work is a pi-durable task the handler creates.
//
// The checks are first shown to catch planted violations, then run over every module.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const SESSION_READS = ["snapshot(", "documentState(", "watchDoc(", "getTask("];

/** The text of each `reactor(` call's argument list (not `x.reactor(` or `fooReactor(`). */
const reactorBodies = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/(?<![\w.])reactor\(/gu)].map((match) => {
    let depth = 0;
    let end = match.index;

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

    return source.slice(match.index, end + 1);
  });

/** An awaited expression that stays on the commit's line: `tx.…` or `helper(tx, …)`. */
const ON_TX = /^(?:tx\.|[\w.]+\(\s*tx\b)/u;

/** Every footgun in one module's reactor handlers, described. */
const footguns = (source: string): ReadonlyArray<string> => {
  const found: Array<string> = [];

  for (const body of reactorBodies(source)) {
    for (const read of SESSION_READS) {
      if (body.includes(`.${read}`)) {
        found.push(`calls ${read.slice(0, -1)} inside a reactor`);
      }
    }

    for (const match of body.matchAll(/\bawait\s+(?<awaited>[^;]*)/gu)) {
      const awaited = match.groups?.awaited ?? "";

      if (!ON_TX.test(awaited)) {
        found.push(
          `awaits ${awaited.split("(")[0] ?? awaited} inside a reactor`
        );
      }
    }
  }

  return found;
};

const modules = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);

    if (statSync(full).isDirectory()) {
      return name === "node_modules" ? [] : modules(full);
    }

    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });

const ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("reactor handler footguns", () => {
  it("catches each footgun when it is planted", () => {
    assert.deepStrictEqual(
      footguns(
        'reactor("r", spec, async (tx, event) => { await fetch("https://x"); });'
      ),
      ["awaits fetch inside a reactor"]
    );
    assert.deepStrictEqual(
      footguns(
        'reactor("r", spec, async (tx) => { await harness.snapshot(Doc, ctx); });'
      ),
      [
        "calls snapshot inside a reactor",
        "awaits harness.snapshot inside a reactor",
      ]
    );
    assert.deepStrictEqual(
      footguns(
        'reactor("r", spec, async (tx) => { await new Promise((done) => setTimeout(done, 9)); });'
      ),
      ["awaits new Promise inside a reactor"]
    );
    assert.deepStrictEqual(
      footguns(
        'reactor("r", spec, async (tx, event) => { const doc = await tx.doc(D); await record(tx, event.id); await tx.createTask(T, {}, {}); });'
      ),
      []
    );
    // Only `reactor(` calls are handlers; other awaits are not this check's.
    assert.deepStrictEqual(
      footguns(
        "const r = state.reactor(x); await fetch(url); export const reactor = (name) => name;"
      ),
      []
    );
  });

  it("finds none in the server's or the judges' reactors", () => {
    const found = [
      path.join(ROOT, "apps/server/src"),
      path.join(ROOT, "judges"),
    ].flatMap((directory) =>
      modules(directory).flatMap((module) =>
        footguns(readFileSync(module, "utf-8")).map(
          (footgun) => `${path.relative(ROOT, module)}: ${footgun}`
        )
      )
    );

    assert.deepStrictEqual(found, []);
  });

  it("sees the judge fixture's reactors", () => {
    const source = readFileSync(
      path.join(ROOT, "judges/fixtures/events/EventsBrain.ts"),
      "utf-8"
    );

    assert.isAtLeast(reactorBodies(source).length, 3);
  });
});
