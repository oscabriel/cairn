// The permission modes' table (ADR 0031, the briefs note's section 5): which actions each mode asks
// for, and "Allow for this thread" skipping the ask for the tools it named. The behaviour through
// pi-durable and the scripted harness is judged by the `mode_*` conformance scenarios; the kill
// windows by `GatedWriter.test.ts` and the durability judge's gated windows.

import { RuntimeMode } from "@cairn/protocol/Policy";
import { assert, describe, it } from "@effect/vitest";

import {
  callAsks,
  cutSummary,
  GATED_SUMMARY_MAX,
  modeAsks,
} from "./Permissions.ts";
import type { GatedAction } from "./Permissions.ts";

const ACTIONS: ReadonlyArray<GatedAction> = [
  "read",
  "edit",
  "command",
  "executor",
];

describe("permission modes", () => {
  it("asks as the table says: Supervised for all but reads, Auto-accept edits for all but edits and reads, Full access for nothing", () => {
    const table = Object.fromEntries(
      RuntimeMode.literals.map((mode) => [
        mode,
        ACTIONS.filter((action) => modeAsks(mode, action)),
      ])
    );

    assert.deepStrictEqual(table, {
      "approval-required": ["edit", "command", "executor"],
      "auto-accept-edits": ["command", "executor"],
      auto: ["command", "executor"],
      "full-access": [],
    });
  });

  it("skips the ask for a tool Allow for this thread named, and only that tool", () => {
    const permissions = {
      mode: "approval-required" as const,
      allow: ["bash"],
    };

    assert.isFalse(callAsks(permissions, "bash", "command"));
    assert.isTrue(callAsks(permissions, "write", "edit"));
    assert.isTrue(callAsks(permissions, "executor_call", "executor"));
  });

  it("cuts a long summary and says how much it cut", () => {
    const long = "a".repeat(GATED_SUMMARY_MAX + 5);

    assert.strictEqual(cutSummary("bash: ls"), "bash: ls");
    assert.isTrue(cutSummary(long).endsWith("... (5 more characters)"));
  });
});
