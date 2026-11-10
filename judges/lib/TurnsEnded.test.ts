// Judges `TurnsEnded`: the reconnect judge's gate opens only once every turn it started has ended
// and two reads agree, whatever the demo thread does meanwhile.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { endedRows, isSettled } from "./TurnsEnded.ts";

const at = DateTime.makeUnsafe("2026-11-10T08:00:00.000Z");

const later = DateTime.makeUnsafe("2026-11-10T08:00:05.000Z");

const LAUNCHED = ThreadId.make("019a0000-0000-7000-8000-000000000001");

const DEMO = ThreadId.make("019a0000-0000-7000-8000-00000000d3e0");

const row = (id: ThreadId) =>
  ThreadShell.make({
    id,
    projectId: ProjectId.make("prj_1"),
    title: "last",
    provider: "faux",
    modelId: "faux",
    thinkingLevel: "off",
    runtimeMode: "full-access",
    branch: Option.none(),
    worktreePath: Option.none(),
    activity: "idle",
    activeRunId: Option.none(),
    latestRunRequestedAt: Option.some(at),
    latestRunStartedAt: Option.some(at),
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
    ...BARE_ROW_FIELDS,
  });

const ended = row(LAUNCHED);

const running: ThreadShell = {
  ...ended,
  activity: "running",
  latestRunCompletedAt: Option.none(),
};

const snapshot = (
  sequence: number,
  threads: ReadonlyArray<ThreadShell>
): ShellSnapshot => ({ snapshotSequence: sequence, projects: [], threads });

describe("the turns a judge started", () => {
  it("have not ended while a launched thread's run is live, or before it has a row", () => {
    assert.isTrue(Option.isNone(endedRows(snapshot(4, [running]), [LAUNCHED])));
    assert.isTrue(Option.isNone(endedRows(snapshot(4, []), [LAUNCHED])));
    assert.isTrue(
      Option.isNone(
        endedRows(snapshot(4, [{ ...ended, activity: "running" }]), [LAUNCHED])
      )
    );
  });

  it("have ended once every launched thread's run completed, or failed, and none is live", () => {
    assert.isTrue(Option.isSome(endedRows(snapshot(4, [ended]), [LAUNCHED])));
    assert.isTrue(
      Option.isSome(
        endedRows(snapshot(4, [{ ...ended, activity: "failed" }]), [LAUNCHED])
      )
    );
  });

  it("settle when two reads agree, though the demo thread moves the sequence between them", () => {
    const first = endedRows(
      snapshot(4, [ended, { ...row(DEMO), activity: "running" }]),
      [LAUNCHED]
    );

    const second = endedRows(snapshot(9, [ended, row(DEMO)]), [LAUNCHED]);

    assert.isTrue(isSettled(first, second));
  });

  it("do not settle on one read, or when a launched row changed between two", () => {
    const first = endedRows(snapshot(4, [ended]), [LAUNCHED]);

    const changed = endedRows(snapshot(5, [{ ...ended, updatedAt: later }]), [
      LAUNCHED,
    ]);

    assert.isFalse(isSettled(Option.none(), first));
    assert.isFalse(isSettled(first, changed));
    assert.isFalse(
      isSettled(first, endedRows(snapshot(5, [running]), [LAUNCHED]))
    );
  });
});
