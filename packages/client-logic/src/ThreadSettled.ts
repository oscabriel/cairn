// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSettled.ts and
// apps/web/src/components/Sidebar.snooze.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: when a
// snooze ends early (a request for the user or a fresh failure, never a completed run), the
// queued-turn grace window, the snooze presets with their local calendar rules, and the wake labels.
// Changed: rows are Cairn's shell rows, so "blocked on you" is `pendingRuntimeRequest`, a failure is
// `activity: "failed"` with its run's completion time, and a queued start is `activity: "preparing"`
// or a user message no run has picked up yet; "now" is a `DateTime` the caller reads from `Clock`;
// the custom snooze dialog is not ported.
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

import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option } from "effect";

import {
  calendarDaysBetween,
  DAY_MS,
  formatShortDate,
  formatShortWeekday,
  formatTimeOfDay,
  HOUR_MS,
  MINUTE_MS,
} from "./Time.ts";

/** The fields the snooze rules read. */
export type SnoozeInput = Pick<
  ThreadShell,
  | "activity"
  | "pendingRuntimeRequest"
  | "latestUserMessageAt"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "snoozedUntil"
  | "snoozedAt"
>;

/**
 * A queued start lives at most this long: a user message still not picked up by a run after it is
 * a failed start, not pending work, or such a thread could never be snoozed or settled.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * MINUTE_MS;

const millis = DateTime.toEpochMillis;

/**
 * True while a sent message waits for its run to start. Bounded on both sides of `now`, because
 * the message time comes from the device that sent it.
 */
export const hasQueuedTurnStart = (
  thread: SnoozeInput,
  now: DateTime.Utc
): boolean => {
  if (thread.activity === "preparing") {
    return true;
  }

  if (thread.activity === "failed") {
    return false;
  }

  return Option.match(thread.latestUserMessageAt, {
    onNone: () => false,
    onSome: (messageAt) =>
      Math.abs(millis(now) - millis(messageAt)) <= QUEUED_TURN_START_GRACE_MS &&
      Array.every(
        Array.getSomes([
          thread.latestRunRequestedAt,
          thread.latestRunStartedAt,
          thread.latestRunCompletedAt,
        ]),
        (runAt) => millis(runAt) < millis(messageAt)
      ),
  });
};

/** When the latest run failed, when the thread is failed. */
const failureEdgeAt = (thread: SnoozeInput): Option.Option<DateTime.Utc> =>
  thread.activity === "failed"
    ? Option.some(
        Option.getOrElse(thread.latestRunCompletedAt, () => thread.updatedAt)
      )
    : Option.none();

const failedSinceSnooze = (thread: SnoozeInput): Option.Option<DateTime.Utc> =>
  Option.filter(failureEdgeAt(thread), (failedAt) =>
    Option.match(thread.snoozedAt, {
      onNone: () => true,
      onSome: (snoozedAt) => DateTime.isGreaterThan(failedAt, snoozedAt),
    })
  );

/**
 * Only a request for the user or a failure after the snooze ends a snooze early. A completed run
 * never does: a snoozed long-running thread stays hidden until its timer.
 */
export const threadRaisedHandWhileSnoozed = (thread: SnoozeInput): boolean =>
  Option.isSome(thread.pendingRuntimeRequest) ||
  Option.isSome(failedSinceSnooze(thread));

/** True when a snooze or settle is allowed now: nothing waits on the user or on a queued start. */
export const canSnooze = (thread: SnoozeInput, now: DateTime.Utc): boolean =>
  Option.isNone(thread.pendingRuntimeRequest) &&
  !hasQueuedTurnStart(thread, now);

/** True while the thread belongs on the snoozed shelf. */
export const effectiveSnoozed = (
  thread: SnoozeInput,
  now: DateTime.Utc
): boolean =>
  Option.exists(thread.snoozedUntil, (wakeAt) =>
    DateTime.isGreaterThan(wakeAt, now)
  ) && !threadRaisedHandWhileSnoozed(thread);

/**
 * When a snoozed thread woke: the request or failure that ended it early (authoritative even after
 * the scheduled time passes), else its scheduled time once that passed. None while still snoozed or
 * never snoozed.
 */
export const threadWokeAt = (
  thread: SnoozeInput,
  now: DateTime.Utc
): Option.Option<DateTime.Utc> =>
  Option.flatMap(thread.snoozedUntil, (wakeAt) => {
    if (threadRaisedHandWhileSnoozed(thread)) {
      return Option.orElse(failedSinceSnooze(thread), () =>
        Option.orElse(
          Option.map(
            thread.pendingRuntimeRequest,
            (request) => request.createdAt
          ),
          () => thread.snoozedAt
        )
      );
    }

    return DateTime.isLessThanOrEqualTo(wakeAt, now)
      ? Option.some(wakeAt)
      : Option.none();
  });

/** The snooze choices the menu offers. */
export type SnoozePresetId =
  | "hour"
  | "three-hours"
  | "evening"
  | "tomorrow"
  | "next-week";

/** One snooze choice: "In 3 hours (1:00 PM)". */
export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** The wake time as the menu prints it beside the label. */
  readonly whenLabel: string;
  readonly snoozedUntil: DateTime.Utc;
}

const EVENING_HOUR = 18;

const MORNING_HOUR = 9;

const atHour = (day: DateTime.Zoned, hour: number): DateTime.Zoned =>
  DateTime.setParts(day, { hour, minute: 0, second: 0, millisecond: 0 });

/**
 * The snooze choices at `now`, in its zone. Days advance on the calendar, not by 24 hours, so a
 * daylight-saving change never skips a day. "This evening" is offered only while 6 PM is more than
 * an hour away, and "Next week" (Monday 9 AM) only when it differs from "Tomorrow".
 */
export const resolveSnoozePresets = (
  now: DateTime.Zoned,
  locale?: string
): ReadonlyArray<SnoozePreset> => {
  const preset = (
    id: SnoozePresetId,
    label: string,
    wake: DateTime.Zoned,
    whenLabel = formatTimeOfDay(wake, locale)
  ): SnoozePreset => ({
    id,
    label,
    whenLabel,
    snoozedUntil: DateTime.toUtc(wake),
  });

  const evening = atHour(now, EVENING_HOUR);
  const tomorrow = atHour(DateTime.add(now, { days: 1 }), MORNING_HOUR);
  const weekDay = DateTime.getPart(now, "weekDay");
  const daysUntilMonday = (1 - weekDay + 7) % 7 || 7;

  const nextWeek = atHour(
    DateTime.add(now, { days: daysUntilMonday }),
    MORNING_HOUR
  );

  return [
    preset("hour", "In 1 hour", DateTime.add(now, { hours: 1 })),
    preset("three-hours", "In 3 hours", DateTime.add(now, { hours: 3 })),
    ...(millis(evening) - millis(now) > HOUR_MS
      ? [preset("evening", "This evening", evening)]
      : []),
    preset("tomorrow", "Tomorrow", tomorrow),
    ...(millis(nextWeek) === millis(tomorrow)
      ? []
      : [
          preset(
            "next-week",
            "Next week",
            nextWeek,
            `${formatShortWeekday(nextWeek, locale)} ${formatTimeOfDay(nextWeek, locale)}`
          ),
        ]),
  ];
};

/** How long until a snoozed thread wakes, coarsely and rounded up: "30m", "2h", "2d", or "now". */
export const snoozeWakeLabel = (
  snoozedUntil: DateTime.Utc,
  now: DateTime.Utc
): string => {
  const remainingMs = millis(snoozedUntil) - millis(now);

  if (remainingMs <= 0) {
    return "now";
  }

  if (remainingMs < HOUR_MS) {
    return `${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))}m`;
  }

  if (remainingMs < DAY_MS) {
    return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  }

  return `${Math.ceil(remainingMs / DAY_MS)}d`;
};

/**
 * When a snoozed thread wakes, in words: the bare time today, "tomorrow 9:00 AM", the weekday
 * within the week, else the date. `now` carries the zone the words are in.
 */
export const snoozeWakeDescription = (
  snoozedUntil: DateTime.Utc,
  now: DateTime.Zoned,
  locale?: string
): string => {
  const wake = DateTime.setZone(snoozedUntil, now.zone);
  const time = formatTimeOfDay(wake, locale);
  const days = calendarDaysBetween(now, wake);

  if (days <= 0) {
    return time;
  }

  if (days === 1) {
    return `tomorrow ${time}`;
  }

  if (days < 7) {
    return `${formatShortWeekday(wake, locale)} ${time}`;
  }

  return `${formatShortDate(wake, locale)}, ${time}`;
};
