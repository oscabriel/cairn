// The mutation check is spread over `mutation-check/`, one file per side and mutation set
// (`MutationCheck.ts`). These tests hold the folder to `MUTATION_CHECK_FILES`, so a mutation or a
// side added without its file fails here instead of quietly going unjudged.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { MUTATION_CHECK_FILES } from "./MutationCheck.ts";

const folder = path.join(import.meta.dirname, "mutation-check");

/** Code without whitespace, since the formatter wraps a long call over several lines. */
const compact = (text: string) => text.replaceAll(/\s+/gu, "");

describe("the mutation check's files", () => {
  it("are exactly one per side and mutation set", () => {
    assert.deepStrictEqual(
      readdirSync(folder).toSorted(),
      MUTATION_CHECK_FILES.map((file) => file.name).toSorted()
    );
  });

  it("each register the check their name says", () => {
    for (const file of MUTATION_CHECK_FILES) {
      const calls = compact(
        readFileSync(path.join(folder, file.name), "utf-8")
      ).match(/registerMutationCheck\(.*?\);/gu);

      assert.deepStrictEqual(calls, [compact(file.call)], file.name);
    }
  });
});
