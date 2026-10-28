import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";

import { ProjectId, ThreadId } from "./Ids.ts";
import {
  BARE_ROW_FIELDS,
  ShellStreamItem,
  ThreadShell,
  ThreadUpdatedItem,
} from "./Shell.ts";

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
  ...BARE_ROW_FIELDS,
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

  it("reads a phase 1 row from `threads.shell_json` with the phase 2 defaults and writes their keys back", () => {
    // A row as phase 1 stored it: no lineage, subagents, goal, spend or pendingCount, and a
    // pending request with no origin.
    const phase1Row = {
      id: "0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d5e",
      projectId: "prj_1",
      title: "Fix the sidebar",
      provider: "claude-bridge",
      modelId: "claude-haiku-5-5",
      thinkingLevel: "medium",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      activity: "waiting",
      activeRunId: null,
      latestRunRequestedAt: null,
      latestRunStartedAt: null,
      latestRunCompletedAt: "2026-10-22T08:00:00.000Z",
      queueLength: 0,
      lastError: null,
      lastErrorClass: null,
      usageLimitResetAt: null,
      waitingFor: "none",
      pendingRuntimeRequest: {
        id: "apr_1",
        kind: "executor-call",
        createdAt: "2026-10-22T08:00:00.000Z",
      },
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      createdAt: "2026-10-22T08:00:00.000Z",
      updatedAt: "2026-10-22T08:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      autoSettleDisabledAt: null,
      lastVisitedAt: null,
      parkedTaskIds: [],
    };

    const codec = Schema.fromJsonString(Schema.toCodecJson(ThreadShell));
    const row = Schema.decodeSync(codec)(JSON.stringify(phase1Row));
    const written: unknown = JSON.parse(Schema.encodeSync(codec)(row));

    assert.deepStrictEqual(
      [
        row.lineage,
        row.subagents,
        row.goal,
        row.spend,
        row.pendingCount,
        Option.map(row.pendingRuntimeRequest, (request) => request.origin),
      ],
      [
        Option.none(),
        { working: 0, asking: 0, settled: 0, failed: 0 },
        Option.none(),
        Option.none(),
        0,
        Option.some(Option.none()),
      ]
    );
    assert.deepStrictEqual(written, {
      ...phase1Row,
      pendingRuntimeRequest: {
        ...phase1Row.pendingRuntimeRequest,
        origin: null,
      },
      lineage: null,
      subagents: { working: 0, asking: 0, settled: 0, failed: 0 },
      goal: null,
      spend: null,
      pendingCount: 0,
    });
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
