import { readdirSync, readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

// The protocol is shared by the Node server, the judges and the browser bundle, so it may import
// nothing but Effect and its own modules: a Node or DOM import would break one of them.
const sourceDirectory = new URL("./", import.meta.url);

const specifiers = (source: string) =>
  Array.from(
    source.matchAll(
      /^\s*(?:import|export)\s[^"']*?from\s+["'](?<specifier>[^"']+)["']/gmu
    ),
    (match) => match.groups?.specifier ?? ""
  );

describe("packages/protocol imports", () => {
  it("imports only effect and its own modules", () => {
    const sources = readdirSync(sourceDirectory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    );

    assert.isAbove(sources.length, 10);

    for (const name of sources) {
      for (const specifier of specifiers(
        readFileSync(new URL(name, sourceDirectory), "utf-8")
      )) {
        assert.match(
          specifier,
          /^(?:effect(?:\/[a-z-]+)?|\.\/[A-Za-z]+\.ts)$/u,
          `${name} imports ${specifier}`
        );
      }
    }
  });
});
