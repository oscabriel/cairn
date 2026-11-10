// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSnoozed.test.ts and
// apps/web/src/components/Sidebar.snooze.test.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept:
// the snooze, early wake and queued start cases. Changed: rows are Cairn's shell rows, a session
// error is `activity: "failed"`, an approval or question is `pendingRuntimeRequest`, and a
// subagent's request reaches its parent through the row's tally. Removed: malformed date cases, the
// 12 or 24 hour setting, and the wake label and preset cases, which went with the classic sidebar's
// snooze menu (ADR 0050).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { ApprovalId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  effectiveSnoozed,
  hasQueuedTurnStart,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
} from "./ThreadSettled.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const some = (iso: string) => Option.some(time(iso));

const iso = (at: Option.Option<DateTime.Utc>) =>
  Option.getOrNull(Option.map(at, DateTime.formatIso));

const NOW = time("2026-04-10T12:00:00.000Z");

const SNOOZED_AT = "2026-04-10T09:00:00.000Z";

const FUTURE_WAKE = "2026-04-11T09:00:00.000Z";

const PAST_WAKE = "2026-04-10T10:00:00.000Z";

const base = ThreadShell.make({
  id: ThreadId.make("0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d01"),
  projectId: ProjectId.make("prj_1"),
  title: "A thread",
  provider: "opencode-go",
  modelId: "small",
  thinkingLevel: "off",
  runtimeMode: "full-access",
  branch: Option.none(),
  worktreePath: Option.none(),
  activity: "idle",
  activeRunId: Option.none(),
  latestRunRequestedAt: Option.none(),
  latestRunStartedAt: Option.none(),
  latestRunCompletedAt: Option.none(),
  queueLength: 0,
  lastError: Option.none(),
  lastErrorClass: Option.none(),
  usageLimitResetAt: Option.none(),
  waitingFor: "none",
  pendingRuntimeRequest: Option.none(),
  latestVisibleMessage: Option.none(),
  latestUserMessageAt: Option.none(),
  createdAt: time("2026-04-10T08:00:00Z"),
  updatedAt: time("2026-04-10T11:00:00Z"),
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

const snoozed = (until: string, at = SNOOZED_AT): ThreadShell => ({
  ...base,
  snoozedUntil: some(until),
  snoozedAt: some(at),
});

const pending = (
  thread: ThreadShell,
  kind: "tool-call" | "user-input",
  createdAt = "2026-04-10T11:00:00.000Z"
): ThreadShell => ({
  ...thread,
  pendingRuntimeRequest: Option.some({
    id: ApprovalId.make("apr_1"),
    kind,
    createdAt: time(createdAt),
    origin: Option.none(),
  }),
});

const failed = (
  thread: ThreadShell,
  completedAt = "2026-04-10T11:00:00.000Z"
): ThreadShell => ({
  ...thread,
  activity: "failed",
  latestRunRequestedAt: some("2026-04-10T07:00:00.000Z"),
  latestRunCompletedAt: some(completedAt),
});

describe(effectiveSnoozed, () => {
  it("hides a thread whose wake time is in the future", () => {
    assert.isTrue(effectiveSnoozed(snoozed(FUTURE_WAKE), NOW));
  });

  it("stops classifying as snoozed once the wake time passes", () => {
    assert.isFalse(effectiveSnoozed(snoozed(PAST_WAKE), NOW));
  });

  it("never snoozes a thread with no snooze state", () => {
    assert.isFalse(effectiveSnoozed(base, NOW));
  });

  it("wakes early when the agent is blocked on the user", () => {
    assert.isFalse(
      effectiveSnoozed(pending(snoozed(FUTURE_WAKE), "tool-call"), NOW)
    );
    assert.isFalse(
      effectiveSnoozed(pending(snoozed(FUTURE_WAKE), "user-input"), NOW)
    );
  });

  it("wakes early on a failure that happened after the snooze", () => {
    assert.isFalse(effectiveSnoozed(failed(snoozed(FUTURE_WAKE)), NOW));
  });

  it("stays snoozed when the failure predates the snooze: the user saw it", () => {
    assert.isTrue(
      effectiveSnoozed(
        failed(
          snoozed(FUTURE_WAKE, "2026-04-10T11:30:00.000Z"),
          "2026-04-10T08:00:00.000Z"
        ),
        NOW
      )
    );
  });

  it.each([
    {
      reason: "stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      request: false,
      wokeAt: null,
    },
    {
      reason: "fresh failure",
      completedAt: "2026-04-10T10:00:00.000Z",
      request: false,
      wokeAt: "2026-04-10T10:00:00.000Z",
    },
    {
      reason: "approval after a stale failure",
      completedAt: "2026-04-10T08:00:00.000Z",
      request: true,
      wokeAt: "2026-04-10T11:00:00.000Z",
    },
  ] as const)(
    "uses the wake event time for $reason",
    ({ completedAt, request, wokeAt }) => {
      const failedThread = failed(snoozed(FUTURE_WAKE), completedAt);

      const thread = request
        ? pending(failedThread, "tool-call")
        : failedThread;

      assert.strictEqual(effectiveSnoozed(thread, NOW), wokeAt === null);
      assert.strictEqual(iso(threadWokeAt(thread, NOW)), wokeAt);
    }
  );

  it("stays snoozed while the thread keeps working: a snooze never pauses the agent", () => {
    assert.isTrue(
      effectiveSnoozed({ ...snoozed(FUTURE_WAKE), activity: "running" }, NOW)
    );
  });

  it("stays snoozed when a run requested after the snooze completes", () => {
    const thread: ThreadShell = {
      ...snoozed(FUTURE_WAKE),
      latestRunRequestedAt: some("2026-04-10T09:00:00.001Z"),
      latestRunStartedAt: some("2026-04-10T09:15:00.000Z"),
      latestRunCompletedAt: some("2026-04-10T10:30:00.000Z"),
    };

    assert.isTrue(effectiveSnoozed(thread, NOW));
    assert.isTrue(Option.isNone(threadWokeAt(thread, NOW)));
  });
});

describe("a snooze and the server's rule", () => {
  it("stays snoozed on a launch failure seen before the snooze, however late the row changes", () => {
    // The launch failed with no run, was snoozed after, then renamed: only `updatedAt` moved.
    const renamed: ThreadShell = {
      ...snoozed(FUTURE_WAKE),
      activity: "failed",
      lastErrorClass: Option.some("unknown"),
      updatedAt: time("2026-04-10T11:30:00.000Z"),
    };

    assert.isTrue(effectiveSnoozed(renamed, NOW));
    assert.isTrue(Option.isNone(threadWokeAt(renamed, NOW)));
  });

  it("wakes when a subagent below asks the user", () => {
    const asking: ThreadShell = {
      ...snoozed(FUTURE_WAKE),
      subagents: { working: 0, asking: 1, settled: 0, failed: 0 },
    };

    assert.isFalse(effectiveSnoozed(asking, NOW));
    assert.isTrue(threadRaisedHandWhileSnoozed(asking));
  });
});

describe(threadRaisedHandWhileSnoozed, () => {
  it("is false for a quiet snoozed thread", () => {
    assert.isFalse(threadRaisedHandWhileSnoozed(snoozed(FUTURE_WAKE)));
  });

  it("is true for approvals, questions and failures", () => {
    assert.isTrue(
      threadRaisedHandWhileSnoozed(pending(snoozed(FUTURE_WAKE), "tool-call"))
    );
    assert.isTrue(
      threadRaisedHandWhileSnoozed(pending(snoozed(FUTURE_WAKE), "user-input"))
    );
    assert.isTrue(threadRaisedHandWhileSnoozed(failed(snoozed(FUTURE_WAKE))));
  });
});

describe(hasQueuedTurnStart, () => {
  it("expires queued state after two minutes", () => {
    assert.isFalse(
      hasQueuedTurnStart(
        { ...base, latestUserMessageAt: some("2026-04-10T11:57:59.000Z") },
        NOW
      )
    );
  });

  it("clears when a run picks the message up or the thread fails", () => {
    const messageAt = "2026-04-10T11:59:00.000Z";

    assert.isFalse(
      hasQueuedTurnStart(
        {
          ...base,
          latestUserMessageAt: some(messageAt),
          latestRunRequestedAt: some(messageAt),
        },
        NOW
      )
    );
    assert.isFalse(
      hasQueuedTurnStart(
        { ...base, activity: "failed", latestUserMessageAt: some(messageAt) },
        NOW
      )
    );
  });

  it("is true while the run is preparing", () => {
    assert.isTrue(hasQueuedTurnStart({ ...base, activity: "preparing" }, NOW));
  });

  it("bounds a sending device's clock running ahead", () => {
    assert.isFalse(
      hasQueuedTurnStart(
        { ...base, latestUserMessageAt: some("2026-04-10T12:03:00.000Z") },
        NOW
      )
    );
    assert.isTrue(
      hasQueuedTurnStart(
        { ...base, latestUserMessageAt: some("2026-04-10T12:01:00.000Z") },
        NOW
      )
    );
  });
});

describe(threadWokeAt, () => {
  it("is none for never-snoozed and still-snoozed threads", () => {
    assert.isTrue(Option.isNone(threadWokeAt(base, NOW)));
    assert.isTrue(Option.isNone(threadWokeAt(snoozed(FUTURE_WAKE), NOW)));
  });

  it("reports the timer wake even after an already-requested run completes", () => {
    const thread: ThreadShell = {
      ...snoozed(PAST_WAKE),
      latestRunCompletedAt: some("2026-04-10T09:30:00.000Z"),
    };

    assert.isFalse(effectiveSnoozed(thread, NOW));
    assert.strictEqual(iso(threadWokeAt(thread, NOW)), PAST_WAKE);
  });

  it("keeps an early wake authoritative after the scheduled time passes", () => {
    const thread = failed(snoozed(PAST_WAKE), "2026-04-10T09:30:00.000Z");

    assert.strictEqual(
      iso(threadWokeAt(thread, NOW)),
      "2026-04-10T09:30:00.000Z"
    );
  });
});
