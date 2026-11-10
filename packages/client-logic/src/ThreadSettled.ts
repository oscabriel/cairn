// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSettled.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: when a snooze ends early (a request for the user or
// a fresh failure, never a completed run) and the queued-turn grace window. The snooze presets and
// wake labels (apps/web/src/components/Sidebar.snooze.ts) went with the classic sidebar's menu: no
// view snoozes since the 7A cutover (ADR 0050). Changed: rows are Cairn's shell rows, so "blocked
// on you" is `pendingRuntimeRequest` or a subagent below asking (the row's tally, as t3code counts
// `pendingSubagentRequest`), a failure is `activity: "failed"` with its run's completion time, and a
// queued start is `activity: "preparing"` or a user message no run has picked up yet; "now" is a
// `DateTime` the caller reads from `Clock`; the custom snooze dialog is not ported. The server's
// settlement rules read `effectiveSnoozed` too, so the two sides cannot disagree, and the brain records an early wake on the row when it
// happens (`ThreadActivityUpdate`), so answering the request that woke a thread does not put it
// back to sleep: the rules here only cover the moment before that commit.
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

import { MINUTE_MS } from "./Time.ts";

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
  | "subagents"
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

/**
 * True when the thread failed after it was snoozed (or carries no snooze time). The failure's time
 * is its run's completion; a launch failure has none, so only the brain's recorded wake ends a
 * snooze for it, never a later change that moves `updatedAt`.
 */
const failedSinceSnooze = (thread: SnoozeInput): boolean =>
  thread.activity === "failed" &&
  Option.match(thread.snoozedAt, {
    onNone: () => true,
    onSome: (snoozedAt) =>
      Option.exists(thread.latestRunCompletedAt, (failedAt) =>
        DateTime.isGreaterThan(failedAt, snoozedAt)
      ),
  });

/** When the failure that ended a snooze happened, when one did and its time is known. */
const failureWakeAt = (thread: SnoozeInput): Option.Option<DateTime.Utc> =>
  failedSinceSnooze(thread) ? thread.latestRunCompletedAt : Option.none();

/** True while a subagent somewhere below the thread waits on the user. */
const subagentAsks = (thread: SnoozeInput): boolean =>
  thread.subagents.asking > 0;

/**
 * Only a request for the user (the thread's own or a subagent's below it) or a failure after the
 * snooze ends a snooze early. A completed run never does: a snoozed long-running thread stays
 * hidden until its timer.
 */
export const threadRaisedHandWhileSnoozed = (thread: SnoozeInput): boolean =>
  Option.isSome(thread.pendingRuntimeRequest) ||
  subagentAsks(thread) ||
  failedSinceSnooze(thread);

/** True while the thread belongs on the snoozed shelf. The brain's settlement sweep reads it too. */
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
      return Option.orElse(failureWakeAt(thread), () =>
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
