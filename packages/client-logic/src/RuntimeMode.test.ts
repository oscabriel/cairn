// t3code has no test for runtimeModeConfig.ts at fe27e8e3; these cases judge the port in
// RuntimeMode.ts (its header names the source and the MIT notice).

import { RuntimeMode } from "@cairn/protocol/Policy";
import { assert, describe, it } from "@effect/vitest";

import {
  defaultRuntimeMode,
  runtimeModeOptions,
  runtimeModePresentation,
} from "./RuntimeMode.ts";

describe("runtime modes", () => {
  it("lists every protocol mode once, in t3code's order", () => {
    assert.deepStrictEqual(runtimeModeOptions, RuntimeMode.literals);
  });

  it("defaults to full access, the only mode enforced in Phase 1", () => {
    assert.strictEqual(defaultRuntimeMode, "full-access");
    assert.deepStrictEqual(
      runtimeModeOptions.filter(
        (mode) => runtimeModePresentation[mode].isEnforced
      ),
      ["full-access"]
    );
  });

  it("keeps t3code's labels", () => {
    assert.deepStrictEqual(
      runtimeModeOptions.map((mode) => runtimeModePresentation[mode].label),
      ["Supervised", "Auto-accept edits", "Auto", "Full access"]
    );
  });
});
