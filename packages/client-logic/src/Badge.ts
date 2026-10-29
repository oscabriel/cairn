// The app icon's badge (briefs note B7): one rule the push's notifier and the open page both count
// with, so a tap through a push does not change the number. It counts the project threads that need
// the user, each once: a top-level thread whose latest result the user has not opened, or one with
// a request waiting on it or on any of its subagents. An escalated question (the child's record and
// its parent's mirror) and a supervised child's approval fold into the thread the user talks to.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";

/** True when the thread's latest run finished after the user last opened it, and none runs now. */
export const hasUnseenResult = (thread: ThreadShell): boolean =>
  Option.isNone(thread.activeRunId) &&
  Option.match(thread.latestRunCompletedAt, {
    onNone: () => false,
    onSome: (completed) =>
      Option.match(thread.lastVisitedAt, {
        onNone: () => true,
        onSome: (visited) => DateTime.isGreaterThan(completed, visited),
      }),
  });

/** True when the row says a request waits on the thread. */
export const hasPendingRequest = (thread: ThreadShell): boolean =>
  thread.pendingCount > 0 || Option.isSome(thread.pendingRuntimeRequest);

/** The thread at the top of `thread`'s lineage: itself when it is not a subagent. */
const rootOf = (thread: ThreadShell): ThreadId =>
  Option.match(thread.lineage, {
    onNone: () => thread.id,
    onSome: (lineage) => lineage.rootThreadId,
  });

/**
 * The badge over `threads` (live rows: archived and deleted ones are skipped): the distinct root
 * threads with an unseen top-level result or a request waiting anywhere in their tree. A
 * subagent's result reaches its parent, so only its requests count.
 */
export const badgeOf = (threads: ReadonlyArray<ThreadShell>): number => {
  const roots = new Set<ThreadId>();

  for (const thread of threads) {
    if (Option.isSome(thread.archivedAt)) {
      continue;
    }

    if (
      (Option.isNone(thread.lineage) && hasUnseenResult(thread)) ||
      hasPendingRequest(thread)
    ) {
      roots.add(rootOf(thread));
    }
  }

  return roots.size;
};
