// Ported in idea from github.com/pingdotgg/t3code, apps/web/src/uiStateStore.ts (`markThreadVisited`)
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: opening a thread marks it visited, and a later
// visit time never moves backwards. Changed: the visit is a server command (`thread.visit`), so every
// device agrees on unseen completions, and it is throttled: a thread already open is marked again
// only when a run completed after its last visit, at most once every few seconds. The local map of
// visit times is not ported; the server's `lastVisitedAt` is the only record.
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

import { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option, Schema } from "effect";

/** The least time between two visits sent for the same open thread. */
export const VISIT_THROTTLE_MS = 3000;

/** The last visit this client sent: for which thread, and when. */
export const VisitState = Schema.Option(
  Schema.Struct({ threadId: ThreadId, sentAtMs: Schema.Finite })
);

export type VisitState = typeof VisitState.Type;

/** A visit to send, and the state after sending it. */
export interface PlannedVisit {
  readonly state: VisitState;
  readonly visit: Option.Option<{
    readonly threadId: ThreadId;
    readonly at: DateTime.Utc;
  }>;
}

const needsVisit = (thread: ThreadShell, now: DateTime.Utc): boolean =>
  Option.exists(thread.latestRunCompletedAt, (completedAt) =>
    Option.match(thread.lastVisitedAt, {
      onNone: () => DateTime.isLessThanOrEqualTo(completedAt, now),
      onSome: (visitedAt) => DateTime.isGreaterThan(completedAt, visitedAt),
    })
  );

/**
 * Whether to send `thread.visit` now for the open thread. Opening a different thread always sends
 * one. While it stays open, another is sent when a run completed after the last visit, once the
 * throttle has passed. Nothing is sent with no open thread or no row for it yet.
 */
export const planVisit = (
  state: VisitState,
  openThread: Option.Option<ThreadShell>,
  now: DateTime.Utc
): PlannedVisit => {
  const nowMs = DateTime.toEpochMillis(now);

  return Option.match(openThread, {
    onNone: () => ({ state: Option.none(), visit: Option.none() }),
    onSome: (thread) => {
      const isNewThread = !Option.exists(
        state,
        (last) => last.threadId === thread.id
      );

      const throttled = Option.exists(
        state,
        (last) =>
          last.threadId === thread.id &&
          nowMs - last.sentAtMs < VISIT_THROTTLE_MS
      );

      if (isNewThread || (!throttled && needsVisit(thread, now))) {
        return {
          state: Option.some({ threadId: thread.id, sentAtMs: nowMs }),
          // Never before the run it acknowledges, even when this device's clock runs behind.
          visit: Option.some({
            threadId: thread.id,
            at: Option.match(thread.latestRunCompletedAt, {
              onNone: () => now,
              onSome: (completedAt) => DateTime.max(now, completedAt),
            }),
          }),
        };
      }

      return { state, visit: Option.none() };
    },
  });
};
