import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";

import { ProjectId, ThreadId } from "./Ids.ts";
import { ShellStreamItem, ThreadShell, ThreadUpdatedItem } from "./Shell.ts";

const toJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ShellStreamItem))
);

const fromJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ShellStreamItem))
);

const at = DateTime.makeUnsafe("2026-10-22T08:00:00.000Z");

const thread = ThreadShell.make({
  id: ThreadId.make("0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d5e"),
  projectId: ProjectId.make("prj_1"),
  title: "Fix the sidebar",
  provider: "claude-bridge",
  modelId: "claude-haiku-5-5",
  thinkingLevel: "medium",
  runtimeMode: "full-access",
  branch: Option.none(),
  worktreePath: Option.none(),
  activity: "idle",
  activeRunId: Option.none(),
  latestRunRequestedAt: Option.none(),
  latestRunStartedAt: Option.none(),
  latestRunCompletedAt: Option.some(at),
  queueLength: 0,
  lastError: Option.none(),
  lastErrorClass: Option.none(),
  usageLimitResetAt: Option.none(),
  waitingFor: "none",
  pendingRuntimeRequest: Option.none(),
  latestVisibleMessage: Option.none(),
  latestUserMessageAt: Option.none(),
  createdAt: at,
  updatedAt: at,
  archivedAt: Option.none(),
  settledOverride: Option.none(),
  settledAt: Option.none(),
  unsettledAt: Option.none(),
  snoozedUntil: Option.none(),
  snoozedAt: Option.none(),
  pinnedAt: Option.none(),
  pinOrderKey: Option.none(),
  activeOrderKey: Option.none(),
  autoSettleDisabledAt: Option.none(),
  lastVisitedAt: Option.none(),
  parkedTaskIds: [],
});

describe("ShellStreamItem on the wire", () => {
  it("encodes Options as null and times as ISO strings, and decodes back to the same row", () => {
    const item = ThreadUpdatedItem.make({ sequence: 7, thread });
    const wire = toJson(item);

    assert.include(wire, '"_tag":"ThreadUpdated","sequence":7');
    assert.include(wire, '"branch":null');
    assert.include(wire, '"latestRunCompletedAt":"2026-10-22T08:00:00.000Z"');
    assert.deepStrictEqual(fromJson(wire), item);
  });

  it("refuses a thread id that is not a UUIDv7", () => {
    const wire = toJson(ThreadUpdatedItem.make({ sequence: 1, thread }));
    const version4 = wire.replace("0199f0c2-6a4e-7d4c", "0199f0c2-6a4e-4d4c");

    assert.notStrictEqual(version4, wire);
    assert.throws(() => {
      fromJson(version4);
    });
  });
});
