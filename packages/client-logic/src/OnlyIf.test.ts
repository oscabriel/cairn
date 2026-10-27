import { assert, describe, it } from "@effect/vitest";

import { onlyIf } from "./OnlyIf.ts";

describe(onlyIf, () => {
  it("keeps every item in order when the condition holds, and none when it does not", () => {
    assert.deepStrictEqual(
      ["a", ...onlyIf(true, "b", "c"), "d"],
      ["a", "b", "c", "d"]
    );
    assert.deepStrictEqual(["a", ...onlyIf(false, "b", "c"), "d"], ["a", "d"]);
  });
});
