// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.ts and the
// partition in apps/web/src/components/Sidebar.tsx (`partitionSidebarThreads`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the shelves and their precedence (snoozed,
// settled, pinned, active), subagent rows left out of the shelves, and adjacent-thread traversal.
// Changed: Cairn's shell rows, one environment, an `Option` where t3code returns `null`. Not
// ported: drag and drop, sweep gestures, multi-select, pull requests, forks and the Working shelf
// (plan D27), and React hooks. Nothing draws the shelves since the 7A cutover (ADR 0050): the
// partition stays for the day an inbox comes back, and the thread-state judge reads it. Removed
// with the classic sidebar: settled paging, receding rows, search and its highlights, preferred-id
// ordering, where to go after a row leaves, the row accessibility label, and the project monogram
// and colour. Added: the sidebar's managed list in the work panel's shape, asking rows first
// and the resting ones apart (`managedGroupsOf`, U-9); the shell's Previous and Next thread walk its
// drawn rows with `resolveAdjacentThreadId`.
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

import type { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option, Order } from "effect";

import { isSubagentThread } from "./SubagentRollup.ts";
import { effectiveSnoozed } from "./ThreadSettled.ts";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "./ThreadSort.ts";
import type { ThreadCategory } from "./ThreadState.ts";

/** The shelves of the sidebar, top to bottom. */
export type SidebarSection = "pinned" | "active" | "snoozed" | "settled";

/** A thread's shelf. A snooze or a settle wins over a stale pin. */
export const resolveSidebarThreadSection = (input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection => {
  if (input.snoozed) {
    return "snoozed";
  }

  if (input.settled) {
    return "settled";
  }

  return input.pinned ? "pinned" : "active";
};

/** The rows of each shelf, each in its own order. */
export interface SidebarPartition<T> {
  readonly pinned: ReadonlyArray<T>;
  readonly active: ReadonlyArray<T>;
  readonly snoozed: ReadonlyArray<T>;
  readonly settled: ReadonlyArray<T>;
}

/** A thread's shelf at `now`. */
export const sectionOf = (
  thread: ThreadShell,
  now: DateTime.Utc
): SidebarSection =>
  resolveSidebarThreadSection({
    snoozed: effectiveSnoozed(thread, now),
    settled: Option.contains(thread.settledOverride, "settled"),
    pinned: Option.isSome(thread.pinnedAt),
  });

/**
 * Splits the shell's threads into shelves at `now`, keeping only `projectFilter`'s threads when
 * one is set, and leaving out archived threads and subagents (ADR 0028). Pinned by pin order, active by active order (activity never reorders it), snoozed by
 * wake time, settled by settle time.
 */
export const partitionSidebarThreads = <T extends ThreadShell>(
  threads: ReadonlyArray<T>,
  now: DateTime.Utc,
  projectFilter: Option.Option<ProjectId> = Option.none()
): SidebarPartition<T> => {
  const shelves: Record<SidebarSection, Array<T>> = {
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };

  // One pass: each visible thread's shelf is resolved once. A subagent has no row of its own.
  for (const thread of threads) {
    if (
      Option.isNone(thread.archivedAt) &&
      !isSubagentThread(thread) &&
      Option.match(projectFilter, {
        onNone: () => true,
        onSome: (projectId) => thread.projectId === projectId,
      })
    ) {
      shelves[sectionOf(thread, now)].push(thread);
    }
  }

  const wakeMs = (thread: T) =>
    Option.match(thread.snoozedUntil, {
      onNone: () => 0,
      onSome: DateTime.toEpochMillis,
    });

  return {
    pinned: sortPinnedThreadsByOrderKey(shelves.pinned),
    active: sortActiveThreadsByOrderKey(shelves.active),
    snoozed: Array.sort(
      shelves.snoozed,
      Order.combine(
        Order.mapInput(Order.Number, wakeMs),
        Order.mapInput(Order.String, (thread: T) => thread.id)
      )
    ),
    settled: sortSettledThreads(shelves.settled),
  };
};

/** Which way thread traversal moves. */
export type ThreadTraversalDirection = "previous" | "next";

/**
 * The neighbour of the current thread in sidebar order. With no current thread, "next" is the
 * first and "previous" the last; none past either end or for a thread not in the list.
 */
export const resolveAdjacentThreadId = <T>(input: {
  readonly threadIds: ReadonlyArray<T>;
  readonly currentThreadId: Option.Option<T>;
  readonly direction: ThreadTraversalDirection;
}): Option.Option<T> => {
  const { threadIds, currentThreadId, direction } = input;

  return Option.match(currentThreadId, {
    onNone: () =>
      direction === "previous" ? Array.last(threadIds) : Array.head(threadIds),
    onSome: (current) => {
      const index = threadIds.indexOf(current);

      if (index === -1) {
        return Option.none();
      }

      return Array.get(
        threadIds,
        direction === "previous" ? index - 1 : index + 1
      );
    },
  });
};

/** A sidebar's managed list in the work panel's shape (U-9). */
export interface ManagedGroups<Row> {
  /** Rows that ask the user first, then the other live ones (working, waiting, held). */
  readonly live: ReadonlyArray<Row>;
  /** Rows at rest or failed, folded behind their count. */
  readonly resting: ReadonlyArray<Row>;
}

/**
 * The project thread's managed rows (given newest first) as the sidebar lists them: the ones that
 * ask the user lifted to the top, the rest of the live ones under them, each group keeping its
 * order, and the resting and failed ones apart, as the work panel folds its resting children.
 */
export const managedGroupsOf = <Row>(
  rows: ReadonlyArray<Row>,
  categoryOf: (row: Row) => ThreadCategory
): ManagedGroups<Row> => {
  const isResting = (row: Row) => {
    const category = categoryOf(row);

    return category === "resting" || category === "failed";
  };

  const live = rows.filter((row) => !isResting(row));

  return {
    live: [
      ...live.filter((row) => categoryOf(row) === "waiting-on-you"),
      ...live.filter((row) => categoryOf(row) !== "waiting-on-you"),
    ],
    resting: rows.filter(isResting),
  };
};
