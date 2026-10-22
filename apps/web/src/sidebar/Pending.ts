// Ported in idea from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.ts
// (`applySidebarThreadDrop`) and the optimistic drop in apps/web/src/components/Sidebar.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a row moves the moment the user acts, with the
// fields the server will write (settling drops the pin and the snooze, un-settling stamps
// `unsettledAt`). Changed: one projection per intent rather than per drop, and each projection
// stays until the shell row shows the change or it expires.
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
import { DateTime, Option, Schema } from "effect";

import { Intent, intentThreadId } from "./Intent.ts";

/** An intent the brain has not shown back yet, and when the user made it. */
export const PendingChange = Schema.Struct({
  /** Tells two pending changes apart, so an expiry clears the right one. */
  id: Schema.Int,
  intent: Intent,
  at: Schema.DateTimeUtc,
});

export type PendingChange = typeof PendingChange.Type;

/** How long a change may wait for the brain before the row shows the brain's state again. */
export const PENDING_CHANGE_TTL_MS = 15_000;

/** The row as it will look once the brain has applied `intent` at `at`. */
export const applyIntent = (
  thread: ThreadShell,
  intent: Intent,
  at: DateTime.Utc
): ThreadShell =>
  Intent.match(intent, {
    Settle: () => ({
      ...thread,
      settledOverride: Option.some("settled" as const),
      settledAt: Option.some(at),
      unsettledAt: Option.none(),
      pinnedAt: Option.none(),
      pinOrderKey: Option.none(),
      activeOrderKey: Option.none(),
      snoozedUntil: Option.none(),
      snoozedAt: Option.none(),
    }),
    Unsettle: () => ({
      ...thread,
      settledOverride: Option.some("active" as const),
      settledAt: Option.none(),
      unsettledAt: Option.some(at),
    }),
    Pin: () => ({ ...thread, pinnedAt: Option.some(at) }),
    Unpin: () => ({
      ...thread,
      pinnedAt: Option.none(),
      pinOrderKey: Option.none(),
    }),
    Snooze: ({ until }) => ({
      ...thread,
      snoozedUntil: Option.some(until),
      snoozedAt: Option.some(at),
    }),
    Unsnooze: () => ({
      ...thread,
      snoozedUntil: Option.none(),
      snoozedAt: Option.none(),
    }),
    Rename: ({ title }) => ({ ...thread, title }),
    Visit: ({ at: visitedAt }) => ({
      ...thread,
      lastVisitedAt: Option.some(visitedAt),
    }),
    MarkUnread: () => ({
      ...thread,
      lastVisitedAt: Option.map(thread.latestRunCompletedAt, (completedAt) =>
        DateTime.subtract(completedAt, { milliseconds: 1 })
      ),
    }),
    SetAutoSettle: ({ enabled }) => ({
      ...thread,
      autoSettleDisabledAt: enabled ? Option.none() : Option.some(at),
    }),
    Archive: () => ({ ...thread, archivedAt: Option.some(at) }),
    Delete: () => ({ ...thread, archivedAt: Option.some(at) }),
    AddProject: () => thread,
  });

/** True once the brain's row shows what `intent` asked for. */
export const isIntentApplied = (thread: ThreadShell, intent: Intent): boolean =>
  Intent.match(intent, {
    Settle: () => Option.contains(thread.settledOverride, "settled"),
    Unsettle: () => !Option.contains(thread.settledOverride, "settled"),
    Pin: () => Option.isSome(thread.pinnedAt),
    Unpin: () => Option.isNone(thread.pinnedAt),
    Snooze: ({ until }) =>
      Option.exists(thread.snoozedUntil, (snoozedUntil) =>
        DateTime.Equivalence(snoozedUntil, until)
      ),
    Unsnooze: () => Option.isNone(thread.snoozedUntil),
    Rename: ({ title }) => thread.title === title,
    Visit: ({ at }) =>
      Option.exists(thread.lastVisitedAt, (visitedAt) =>
        DateTime.isGreaterThanOrEqualTo(visitedAt, at)
      ),
    MarkUnread: () =>
      Option.match(thread.latestRunCompletedAt, {
        onNone: () => true,
        onSome: (completedAt) =>
          Option.match(thread.lastVisitedAt, {
            onNone: () => true,
            onSome: (visitedAt) => DateTime.isLessThan(visitedAt, completedAt),
          }),
      }),
    SetAutoSettle: ({ enabled }) =>
      Option.isNone(thread.autoSettleDisabledAt) === enabled,
    Archive: () => Option.isSome(thread.archivedAt),
    Delete: () => Option.isSome(thread.archivedAt),
    AddProject: () => true,
  });

/** The shell's rows with every pending change laid over its thread, oldest change first. */
export const withPendingChanges = (
  threads: ReadonlyArray<ThreadShell>,
  pending: ReadonlyArray<PendingChange>
): ReadonlyArray<ThreadShell> =>
  pending.length === 0
    ? threads
    : threads.map((thread) => {
        let row = thread;

        for (const change of pending) {
          if (Option.contains(intentThreadId(change.intent), thread.id)) {
            row = applyIntent(row, change.intent, change.at);
          }
        }

        return row;
      });

/**
 * The pending changes the shell does not show yet; the rest are done. Changes to one thread clear
 * in order: a later change waits while an earlier one is outstanding, so an undo made before the
 * brain applied the original stays laid over the row until both arrive.
 */
export const outstandingChanges = (
  threads: ReadonlyArray<ThreadShell>,
  pending: ReadonlyArray<PendingChange>
): ReadonlyArray<PendingChange> => {
  const blocked = new Set<string>();

  return pending.filter((change) =>
    Option.match(intentThreadId(change.intent), {
      onNone: () => false,
      onSome: (threadId) => {
        const thread = threads.find((row) => row.id === threadId);

        if (thread === undefined) {
          return false;
        }

        const outstanding =
          blocked.has(threadId) || !isIntentApplied(thread, change.intent);

        if (outstanding) {
          blocked.add(threadId);
        }

        return outstanding;
      },
    })
  );
};
