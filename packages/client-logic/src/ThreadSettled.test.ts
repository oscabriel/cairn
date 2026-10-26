// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSnoozed.test.ts and
// apps/web/src/components/Sidebar.snooze.test.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept:
// the snooze, early wake, queued start, wake label and preset cases. Changed: rows are Cairn's shell
// rows, a session error is `activity: "failed"`, an approval or question is `pendingRuntimeRequest`,
// and dates are built in a named zone (America/Chicago) so the calendar cases do not depend on the
// machine's zone. Removed: malformed date cases, the 12 or 24 hour setting and subagent requests.
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
import { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  resolveSnoozePresets,
  snoozeWakeDescription,
  snoozeWakeLabel,
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

const ZONE = "America/Chicago";

/** A local wall-clock time in Chicago. */
const local = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
) =>
  DateTime.makeZonedUnsafe(
    { year, month, day, hour, minute },
    { timeZone: ZONE, adjustForTimeZone: true }
  );

const inChicago = (at: DateTime.Utc) =>
  DateTime.makeZonedUnsafe(at, { timeZone: ZONE });

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
  parkedTaskIds: [],
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

describe(canSnooze, () => {
  it("allows snoozing quiet and working threads alike", () => {
    assert.isTrue(canSnooze(base, NOW));
    assert.isTrue(canSnooze({ ...base, activity: "running" }, NOW));
  });

  it("refuses work blocked on the user", () => {
    assert.isFalse(canSnooze(pending(base, "tool-call"), NOW));
    assert.isFalse(canSnooze(pending(base, "user-input"), NOW));
  });

  it("refuses a queued start, the same invisible pending work rule as settle", () => {
    assert.isFalse(
      canSnooze(
        { ...base, latestUserMessageAt: some("2026-04-10T11:59:30.000Z") },
        NOW
      )
    );
    assert.isTrue(
      canSnooze(
        { ...base, latestUserMessageAt: some("2026-04-10T11:00:00.000Z") },
        NOW
      )
    );
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

describe(snoozeWakeLabel, () => {
  const now = time("2026-06-02T00:00:00.000Z");

  it("formats remaining time coarsely, rounding up", () => {
    assert.strictEqual(
      snoozeWakeLabel(time("2026-06-02T00:30:00.000Z"), now),
      "30m"
    );
    assert.strictEqual(
      snoozeWakeLabel(time("2026-06-02T01:30:00.000Z"), now),
      "2h"
    );
    assert.strictEqual(
      snoozeWakeLabel(time("2026-06-03T02:00:00.000Z"), now),
      "2d"
    );
  });

  it("never reads zero or negative while still snoozed", () => {
    assert.strictEqual(
      snoozeWakeLabel(time("2026-06-02T00:00:30.000Z"), now),
      "1m"
    );
    assert.strictEqual(
      snoozeWakeLabel(time("2026-06-01T23:59:59.000Z"), now),
      "now"
    );
  });
});

const presetIds = (now: DateTime.Zoned) =>
  resolveSnoozePresets(now, "en-US").map((preset) => preset.id);

const presetWake = (now: DateTime.Zoned, id: string) =>
  inChicago(
    Option.getOrThrow(
      Option.fromUndefinedOr(
        resolveSnoozePresets(now, "en-US").find((preset) => preset.id === id)
      )
    ).snoozedUntil
  );

describe(resolveSnoozePresets, () => {
  it("offers one hour, three hours, evening, tomorrow and next week in the morning", () => {
    const now = local(2026, 4, 8, 10);

    assert.deepStrictEqual(presetIds(now), [
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    assert.strictEqual(
      DateTime.getPart(presetWake(now, "three-hours"), "hour"),
      13
    );
    assert.strictEqual(
      DateTime.getPart(presetWake(now, "evening"), "hour"),
      18
    );
    assert.strictEqual(DateTime.getPart(presetWake(now, "tomorrow"), "day"), 9);
    assert.strictEqual(
      DateTime.getPart(presetWake(now, "tomorrow"), "hour"),
      9
    );
    assert.strictEqual(
      DateTime.getPart(presetWake(now, "next-week"), "weekDay"),
      1
    );
    assert.strictEqual(
      DateTime.getPart(presetWake(now, "next-week"), "day"),
      13
    );
  });

  it("labels each choice, with a time that complements the label", () => {
    const presets = resolveSnoozePresets(local(2026, 4, 8, 10), "en-US");

    assert.deepStrictEqual(
      presets.map((preset) => preset.label),
      ["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Next week"]
    );

    for (const preset of presets) {
      assert.notInclude(preset.whenLabel.toLowerCase(), "tomorrow");
    }

    assert.match(presets[3]?.whenLabel ?? "", /9/u);
    assert.match(presets[4]?.whenLabel ?? "", /Mon/u);
  });

  it("drops the evening choice once evening is near or past", () => {
    assert.deepStrictEqual(presetIds(local(2026, 4, 8, 17, 30)), [
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
    assert.deepStrictEqual(presetIds(local(2026, 4, 8, 21)), [
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("puts next week a full week out when today is Monday", () => {
    const nextWeek = presetWake(local(2026, 4, 6, 10), "next-week");

    assert.strictEqual(DateTime.getPart(nextWeek, "weekDay"), 1);
    assert.strictEqual(DateTime.getPart(nextWeek, "day"), 13);
  });

  it("drops next week on Sundays, when it lands on the same Monday as tomorrow", () => {
    const now = local(2026, 8, 30, 7, 1);

    assert.deepStrictEqual(presetIds(now), [
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
    ]);
    assert.strictEqual(
      DateTime.getPart(presetWake(now, "tomorrow"), "weekDay"),
      1
    );
  });

  it("keeps tomorrow at 9 AM across a daylight-saving change", () => {
    // Clocks move back in Chicago early on 1 November 2026.
    const tomorrow = presetWake(local(2026, 10, 31, 23, 30), "tomorrow");

    assert.strictEqual(DateTime.getPart(tomorrow, "day"), 1);
    assert.strictEqual(DateTime.getPart(tomorrow, "hour"), 9);
  });
});

describe(snoozeWakeDescription, () => {
  const now = local(2026, 4, 8, 10);

  const describeWake = (at: DateTime.Zoned) =>
    snoozeWakeDescription(DateTime.toUtc(at), now, "en-US");

  it("uses the bare time today, tomorrow next day, the weekday within the week", () => {
    assert.notInclude(describeWake(local(2026, 4, 8, 18)), "tomorrow");
    assert.include(describeWake(local(2026, 4, 9, 9)), "tomorrow");
    assert.match(describeWake(local(2026, 4, 13, 9)), /Mon/u);
    assert.match(describeWake(local(2026, 4, 20, 9)), /Apr 20/u);
  });
});
