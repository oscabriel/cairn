// J-models (ADR 0043), with its broken control. On a real pi-durable Harness, a child that names no
// model runs on its parent's model and level, a child that names `beta/b1` runs on beta, a named
// model the catalog lacks is refused with the reason, and the `models` tool tells the child that
// called it its own model and what else it may name. The control drops the parent's level; the
// verdict must name what it broke.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  NAMED,
  PARENT,
  PARENT_LEVEL,
  runScenario,
  verdictOf,
} from "./fixtures/models/ModelDispatch.ts";

describe("J-models: a child names its model or runs on its parent's", () => {
  it.live(
    "runs an unnamed child on its parent's model and level, a named one on its model",
    () =>
      Effect.gen(function* () {
        const report = yield* runScenario("parent");

        assert.deepStrictEqual(verdictOf(report), []);
        assert.deepStrictEqual(report.a.model, Option.some(PARENT));
        assert.deepStrictEqual(
          report.a.thinkingLevel,
          Option.some(PARENT_LEVEL)
        );
        assert.deepStrictEqual(report.b.model, Option.some(NAMED));
      })
  );

  it.live("catches a dispatch that drops the parent's level", () =>
    Effect.gen(function* () {
      const failures = verdictOf(yield* runScenario("model-only"));

      assert.isTrue(
        failures.some((failure) =>
          failure.startsWith("child A named no model but runs at")
        ),
        failures.join("\n")
      );
    })
  );
});
