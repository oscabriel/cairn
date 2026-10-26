// Ported from github.com/pingdotgg/t3code, apps/web/src/timestampFormat.ts (relative time,
// boundaries, short and day-aware timestamps), packages/shared/src/orchestrationTiming.ts
// (`formatDuration`) and apps/web/src/components/Sidebar.logic.ts (`formatWorkingDurationLabel`)
// and Sidebar.tsx (`compactSidebarTimeLabel`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept:
// every label's wording and rounding. Changed: times are `DateTime`s and "now" is passed in as
// epoch milliseconds (the caller reads `Clock`), so nothing here reads the system clock; local
// calendar labels take a `DateTime.Zoned` and an optional locale instead of a host bridge; the
// 12 or 24 hour setting is not ported (Cairn follows the locale).
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

import { DateTime } from "effect";

/** One minute in milliseconds. */
export const MINUTE_MS = 60_000;

/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000;

/** One day in milliseconds. */
export const DAY_MS = 86_400_000;

const relativeTimeUnitMs = (elapsedMs: number): number => {
  if (elapsedMs < HOUR_MS) {
    return MINUTE_MS;
  }

  return elapsedMs < DAY_MS ? HOUR_MS : DAY_MS;
};

/**
 * Elapsed time floored to the precision the relative label shows, so two instants with the same
 * label give the same number. A future time counts as zero.
 */
export const relativeTimeElapsedMs = (
  at: DateTime.DateTime,
  nowMs: number
): number => {
  const elapsedMs = Math.max(0, nowMs - DateTime.toEpochMillis(at));
  const unitMs = relativeTimeUnitMs(elapsedMs);

  return Math.floor(elapsedMs / unitMs) * unitMs;
};

/** Milliseconds until the relative label for `at` next changes, at most a day. */
export const msUntilRelativeTimeChange = (
  at: DateTime.DateTime,
  nowMs: number
): number => {
  const atMs = DateTime.toEpochMillis(at);
  const elapsedMs = Math.max(0, nowMs - atMs);
  const unitMs = relativeTimeUnitMs(elapsedMs);
  const nextChangeMs = atMs + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;

  return Math.min(nextChangeMs - nowMs, DAY_MS);
};

/** A relative label's parts: "3h" and "ago", or "just now" with no suffix. */
export interface RelativeTimeParts {
  readonly value: string;
  readonly suffix: "ago" | "";
}

/** The relative label of an elapsed time. */
export const formatRelativeElapsed = (elapsedMs: number): RelativeTimeParts => {
  const seconds = Math.floor(elapsedMs / 1000);

  if (seconds < 60) {
    return { value: "just now", suffix: "" };
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return { value: `${minutes}m`, suffix: "ago" };
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return { value: `${hours}h`, suffix: "ago" };
  }

  return { value: `${Math.floor(hours / 24)}d`, suffix: "ago" };
};

/** "3h ago", "just now": how long ago `at` was. */
export const formatRelativeTimeLabel = (
  at: DateTime.DateTime,
  nowMs: number
): string => {
  const { value, suffix } = formatRelativeElapsed(
    relativeTimeElapsedMs(at, nowMs)
  );

  return suffix === "" ? value : `${value} ${suffix}`;
};

/** The sidebar's short form of a relative label: "3h", "now". */
export const compactRelativeTimeLabel = (label: string): string => {
  if (label === "just now") {
    return "now";
  }

  return label.endsWith(" ago") ? label.slice(0, -4) : label;
};

/** The sidebar's relative age of `at`: "now", "4m", "3h", "2d". */
export const formatSidebarAge = (
  at: DateTime.DateTime,
  nowMs: number
): string => compactRelativeTimeLabel(formatRelativeTimeLabel(at, nowMs));

/** How long a row has been working: "42s", "12m", "1h 5m". */
export const formatWorkingDurationLabel = (elapsedMs: number): string => {
  const seconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs / 1000))
    : 0;

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** A measured duration: "250ms", "1.5s", "1h 1m 1s". Invalid durations read "0ms". */
export const formatDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0ms";
  }

  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }

  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;

    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }

  // The unit is chosen after rounding, so 59.5 seconds never reads "60s".
  const totalSeconds = Math.round(durationMs / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 ? `${seconds}s` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
};

/** "3:44 PM" or "15:44" as the locale writes a time of day, in the zone of `at`. */
export const formatTimeOfDay = (at: DateTime.Zoned, locale?: string): string =>
  DateTime.format(at, { hour: "numeric", minute: "2-digit", locale });

/** "Mon" as the locale writes a short weekday, in the zone of `at`. */
export const formatShortWeekday = (
  at: DateTime.Zoned,
  locale?: string
): string => DateTime.format(at, { weekday: "short", locale });

/** "Oct 24" as the locale writes a short date, in the zone of `at`. */
export const formatShortDate = (at: DateTime.Zoned, locale?: string): string =>
  DateTime.format(at, { month: "short", day: "numeric", locale });

/** Whole local calendar days from the day of `from` to the day of `to` (negative when earlier). */
export const calendarDaysBetween = (
  from: DateTime.Zoned,
  to: DateTime.Zoned
): number =>
  Math.round(
    (DateTime.toEpochMillis(DateTime.startOf(to, "day")) -
      DateTime.toEpochMillis(DateTime.startOf(from, "day"))) /
      DAY_MS
  );
