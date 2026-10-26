// Ported from github.com/pingdotgg/t3code, apps/web/src/timestampFormat.test.ts ("relative time
// boundaries", "formatShortTimestamp") and packages/shared/src/orchestrationTiming.test.ts
// ("formatDuration") at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the boundary, duration and
// locale cases. Removed: the host-locale and 12 or 24 hour setting cases (not ported), and the
// invalid-input cases (Cairn's times are decoded `DateTime`s). Added: the sidebar's compact age and
// working duration labels.
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

import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";

import {
  calendarDaysBetween,
  formatDuration,
  formatRelativeTimeLabel,
  formatSidebarAge,
  formatTimeOfDay,
  formatWorkingDurationLabel,
  msUntilRelativeTimeChange,
  relativeTimeElapsedMs,
} from "./Time.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const nowMs = Date.parse("2026-04-07T12:00:00.000Z");

// ICU can separate the day period with a narrow no-break space.
const plainSpaces = (text: string) => text.replaceAll(/[  ]/gu, " ");

describe("relative time boundaries", () => {
  it("waits for the label to change instead of the next second", () => {
    // "just now" turns into "1m ago" at the one-minute mark.
    assert.strictEqual(
      msUntilRelativeTimeChange(time("2026-04-07T11:59:40.000Z"), nowMs),
      40_000
    );
    // "2m ago" turns into "3m ago" a minute after the 2m mark.
    assert.strictEqual(
      msUntilRelativeTimeChange(time("2026-04-07T11:57:30.000Z"), nowMs),
      30_000
    );
    // "3h ago" holds until the 4h mark.
    assert.strictEqual(
      msUntilRelativeTimeChange(time("2026-04-07T08:30:00.000Z"), nowMs),
      30 * 60_000
    );
    // "2d ago" holds until the 3d mark.
    assert.strictEqual(
      msUntilRelativeTimeChange(time("2026-04-05T00:00:00.000Z"), nowMs),
      12 * 3_600_000
    );
    // A future time reads "just now" until a minute after it.
    assert.strictEqual(
      msUntilRelativeTimeChange(time("2026-04-07T12:00:10.000Z"), nowMs),
      70_000
    );
    // A far-future time stays within a day.
    assert.strictEqual(
      msUntilRelativeTimeChange(time("2026-06-01T00:00:00.000Z"), nowMs),
      86_400_000
    );
  });

  it("keeps the elapsed snapshot stable while the label is unchanged", () => {
    const at = time("2026-04-07T11:57:30.000Z");

    assert.strictEqual(relativeTimeElapsedMs(at, nowMs), 2 * 60_000);
    assert.strictEqual(relativeTimeElapsedMs(at, nowMs + 29_999), 2 * 60_000);
    assert.strictEqual(relativeTimeElapsedMs(at, nowMs + 30_000), 3 * 60_000);
  });
});

describe(formatRelativeTimeLabel, () => {
  it("reads just now, then minutes, hours and days ago", () => {
    assert.strictEqual(
      formatRelativeTimeLabel(time("2026-04-07T11:59:30.000Z"), nowMs),
      "just now"
    );
    assert.strictEqual(
      formatRelativeTimeLabel(time("2026-04-07T11:45:00.000Z"), nowMs),
      "15m ago"
    );
    assert.strictEqual(
      formatRelativeTimeLabel(time("2026-04-07T06:00:00.000Z"), nowMs),
      "6h ago"
    );
    assert.strictEqual(
      formatRelativeTimeLabel(time("2026-04-03T12:00:00.000Z"), nowMs),
      "4d ago"
    );
  });

  it("compacts to the sidebar's form", () => {
    assert.strictEqual(
      formatSidebarAge(time("2026-04-07T11:59:30.000Z"), nowMs),
      "now"
    );
    assert.strictEqual(
      formatSidebarAge(time("2026-04-07T09:00:00.000Z"), nowMs),
      "3h"
    );
  });
});

describe(formatWorkingDurationLabel, () => {
  it.each([
    [0, "0s"],
    [42_000, "42s"],
    [12 * 60_000, "12m"],
    [65 * 60_000, "1h 5m"],
    [Number.NaN, "0s"],
  ])("formats %d ms as %s", (elapsedMs, expected) => {
    assert.strictEqual(formatWorkingDurationLabel(elapsedMs), expected);
  });
});

describe(formatDuration, () => {
  it.each([
    [0, "1ms"],
    [250, "250ms"],
    [1500, "1.5s"],
    [9950, "10s"],
    [22_000, "22s"],
    [59_499, "59s"],
    [59_500, "1m"],
    [59_999, "1m"],
    [60_000, "1m"],
    [65_000, "1m 5s"],
    [119_500, "2m"],
    [3_599_499, "59m 59s"],
    [3_599_500, "1h"],
    [3_600_000, "1h"],
    [3_601_000, "1h 1s"],
    [3_660_000, "1h 1m"],
    [3_661_000, "1h 1m 1s"],
    [7_199_500, "2h"],
    [25_190_000, "6h 59m 50s"],
    [90_061_000, "25h 1m 1s"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    assert.strictEqual(formatDuration(durationMs), expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "handles invalid durations: %s",
    (durationMs) => {
      assert.strictEqual(formatDuration(durationMs), "0ms");
    }
  );
});

describe(formatTimeOfDay, () => {
  it.each([
    ["en-GB", "15:44"],
    ["en-US", "3:44 PM"],
  ])("honours %s", (locale, expected) => {
    const at = DateTime.makeZonedUnsafe("2026-04-07T15:44:00.000Z", {
      timeZone: "UTC",
    });

    assert.strictEqual(plainSpaces(formatTimeOfDay(at, locale)), expected);
  });
});

describe(calendarDaysBetween, () => {
  it("counts local calendar days, not 24 hour spans", () => {
    const zone = { timeZone: "America/Chicago" };

    const lateEvening = DateTime.makeZonedUnsafe(
      "2026-04-08T04:30:00.000Z",
      zone
    );

    const nextMorning = DateTime.makeZonedUnsafe(
      "2026-04-08T14:00:00.000Z",
      zone
    );

    assert.strictEqual(calendarDaysBetween(lateEvening, nextMorning), 1);
    assert.strictEqual(calendarDaysBetween(nextMorning, lateEvening), -1);
  });
});
