// The hook contract is complete: every data attribute the behaviour judge and the landmark reader
// find elements by is in `Hooks.ts`, so a judge that starts reading a new hook fails here until the
// contract `next` keeps names it too.

import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { HOOK_ATTRIBUTES, HOOK_PREFIXES, isHook } from "./Hooks.ts";

const ROOT = path.join(import.meta.dirname, "../../../..");

/** The judges whose element lookups `next` must keep answering. */
const JUDGES = ["judges/behaviour.ts", "judges/fixtures/parity/Landmarks.ts"];

const kebab = (camel: string): string =>
  camel.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * The data attributes a judge's source reads: `[data-x]` selectors, `getByTestId`, a destructured
 * `element.dataset`, and `startsWith("data-x-")` prefixes (returned with a trailing `*`).
 */
const hooksRead = (source: string): ReadonlyArray<string> => {
  const found = new Set<string>();

  for (const match of source.matchAll(/\[(?<name>data-[a-z0-9-]+)/gu)) {
    found.add(match.groups?.name ?? "");
  }

  if (source.includes("getByTestId(")) {
    found.add("data-testid");
  }

  for (const match of source.matchAll(
    /\{(?<fields>[^{}]+)\}\s*=\s*element\.dataset/gu
  )) {
    for (const field of (match.groups?.fields ?? "").split(",")) {
      found.add(`data-${kebab(field.trim())}`);
    }
  }

  for (const match of source.matchAll(
    /startsWith\("(?<prefix>data-[a-z0-9-]+-)"\)/gu
  )) {
    found.add(`${match.groups?.prefix ?? ""}*`);
  }

  return [...found].toSorted();
};

/** The hooks in `read` the contract does not name. */
const unlisted = (read: ReadonlyArray<string>): ReadonlyArray<string> =>
  read.filter((name) =>
    name.endsWith("*")
      ? !HOOK_PREFIXES.some((prefix) => `${prefix}*` === name)
      : !isHook(name)
  );

describe("the hook contract next keeps", () => {
  it("names every hook the behaviour judge and the landmark reader read", () => {
    const read = JUDGES.flatMap((file) =>
      hooksRead(readFileSync(path.join(ROOT, file), "utf-8"))
    );

    // The scan finds what the judges are known to read, so an empty scan cannot pass.
    for (const known of [
      "data-testid",
      "data-timeline-row-kind",
      "data-chat-*",
    ]) {
      assert.include(read, known);
    }

    assert.deepStrictEqual(unlisted(read), []);
  });

  it("fails a judge that reads a hook the contract does not name", () => {
    const planted = hooksRead(
      `page.locator('[data-planted-hook="x"]'); a.name.startsWith("data-planted-")`
    );

    assert.deepStrictEqual(unlisted(planted), [
      "data-planted-*",
      "data-planted-hook",
    ]);
  });

  it("keeps the families the surfaces note names", () => {
    assert.includeMembers(
      [...HOOK_ATTRIBUTES],
      ["data-testid", "data-menu-id"]
    );
    assert.include([...HOOK_PREFIXES], "data-chat-");
  });
});
