// J-roles, the changed-table scenario (ADR 0035's gate), with its broken control. On a real
// pi-durable Harness, a script written while `@judge` named one model dispatches a child after the
// user rebinds the role: the child runs on the new binding, the child dispatched before keeps its
// model for life, each child's `pi.agent` equals its dispatch record, and the `roles` tool shows
// the table as it is. The control resolves the role when the script is written; the verdict must
// name what it broke.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  AFTER,
  BEFORE,
  runScenario,
  verdictOf,
} from "./fixtures/roles/RoleDispatch.ts";

describe("J-roles: the changed-table scenario", () => {
  it.live(
    "resolves at dispatch: new children take the new binding, old ones keep theirs",
    () =>
      Effect.gen(function* () {
        const report = yield* runScenario("dispatch");

        assert.deepStrictEqual(verdictOf(report), []);
        assert.deepStrictEqual(report.a.agent, Option.some(BEFORE));
        assert.deepStrictEqual(report.b.agent, Option.some(AFTER));
      })
  );

  it.live(
    "catches a resolver that reads the table when the script is written",
    () =>
      Effect.gen(function* () {
        const failures = verdictOf(yield* runScenario("write"));

        assert.isTrue(
          failures.some((failure) =>
            failure.startsWith("child B was dispatched on alpha/a1")
          ),
          failures.join("\n")
        );
      })
  );
});
