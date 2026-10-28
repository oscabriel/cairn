import { ThreadId } from "@cairn/protocol/Ids";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { RuntimeMode as RuntimeModeSchema } from "@cairn/protocol/Policy";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  allowedModes,
  effectiveMode,
  lookupIn,
  narrowerMode,
  RUNTIME_MODE_ORDER,
  widensPastParent,
} from "./EffectiveMode.ts";
import type { ModeRow } from "./EffectiveMode.ts";

const id = (n: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(n).padStart(4, "0")}`
  );

const row = (
  n: number,
  runtimeMode: RuntimeMode,
  parent: Option.Option<number> = Option.none()
): ModeRow => ({
  id: id(n),
  runtimeMode,
  lineage: Option.map(parent, (p) => ({
    parentThreadId: id(p),
    relationshipToParent: "subagent" as const,
    rootThreadId: id(1),
  })),
});

describe(narrowerMode, () => {
  it("orders the modes as t3code does, Supervised narrowest and Full access widest", () => {
    assert.deepStrictEqual(RUNTIME_MODE_ORDER, RuntimeModeSchema.literals);

    for (const [i, left] of RUNTIME_MODE_ORDER.entries()) {
      for (const [j, right] of RUNTIME_MODE_ORDER.entries()) {
        assert.strictEqual(
          narrowerMode(left, right),
          RUNTIME_MODE_ORDER[Math.min(i, j)]
        );
      }
    }
  });
});

describe(effectiveMode, () => {
  it("is a top thread's own mode", () => {
    const top = row(1, "auto-accept-edits");

    assert.strictEqual(
      effectiveMode(top, lookupIn([top])),
      "auto-accept-edits"
    );
  });

  it("narrows a child to its parent's current mode and never widens it", () => {
    const parent = row(1, "full-access");
    const child = row(2, "full-access", Option.some(1));

    assert.strictEqual(
      effectiveMode(child, lookupIn([parent, child])),
      "full-access"
    );

    const supervised = { ...parent, runtimeMode: "approval-required" as const };

    assert.strictEqual(
      effectiveMode(child, lookupIn([supervised, child])),
      "approval-required"
    );

    const narrowChild = row(2, "auto-accept-edits", Option.some(1));

    assert.strictEqual(
      effectiveMode(narrowChild, lookupIn([parent, narrowChild])),
      "auto-accept-edits"
    );
  });

  it("narrows through every ancestor, so a root's Supervised reaches a grandchild", () => {
    const root = row(1, "approval-required");
    const child = row(2, "full-access", Option.some(1));
    const grandchild = row(3, "full-access", Option.some(2));

    assert.strictEqual(
      effectiveMode(grandchild, lookupIn([root, child, grandchild])),
      "approval-required"
    );
  });

  it("stops at a missing parent or a loop with what it read", () => {
    const orphan = row(2, "auto", Option.some(9));

    assert.strictEqual(effectiveMode(orphan, lookupIn([orphan])), "auto");

    const loopA = row(4, "full-access", Option.some(5));
    const loopB = row(5, "auto-accept-edits", Option.some(4));

    assert.strictEqual(
      effectiveMode(loopA, lookupIn([loopA, loopB])),
      "auto-accept-edits"
    );
  });
});

describe(widensPastParent, () => {
  it("refuses a child's mode wider than its parent's effective mode, and nothing on a top thread", () => {
    const root = row(1, "approval-required");
    const parent = row(2, "full-access", Option.some(1));
    const child = row(3, "approval-required", Option.some(2));
    const lookup = lookupIn([root, parent, child]);

    assert.isTrue(widensPastParent(child, "auto-accept-edits", lookup));
    assert.isFalse(widensPastParent(child, "approval-required", lookup));
    assert.isFalse(widensPastParent(root, "full-access", lookup));
    assert.deepStrictEqual(allowedModes(child, lookup), ["approval-required"]);
    assert.deepStrictEqual(allowedModes(root, lookup), RUNTIME_MODE_ORDER);
  });
});
