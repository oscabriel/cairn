// "Needs you", counted one way (briefs note B7, C-4): one predicate and one counting rule that the
// favicon, the app icon's badge, the number in every push and the rail's mark all read, so a tap
// through a push does not change the number. A row needs the user when a request waits on it, or,
// for a thread the user talks to, when its latest result is unseen (a subagent's result reaches its
// parent as a note, so only its requests count). The count is the threads the user talks to that
// need them, each once: a request anywhere in a thread's tree (an escalated question's record and
// its parent's mirror, several children asking) folds into the root. Only roots the user can reach
// count (the listing rule, the user, 2026-10-30): each folder project's project thread, which the
// sidebar lists with the threads it manages, and the scratch thread the caller holds. An old
// top-level thread no list shows never counts, since the user could not open it to clear the badge.
//
// The scratch thread's identity lives in the page's localStorage (`cairn:next:scratch-thread:v1`),
// so the caller passes it. The brain cannot see it: the push's number leaves out a scratch thread
// that needs the user, which the open page's favicon and app icon count.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";

import { projectThreadOf } from "./ProjectThread.ts";

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

/**
 * The one "needs you" predicate: a request waits on the row, or it is a thread the user talks to
 * (no lineage) whose latest result they have not seen. A failure or a spent plan window the user
 * has seen does not need them again; its row still says so.
 */
export const needsYou = (thread: ThreadShell): boolean =>
  hasPendingRequest(thread) ||
  (Option.isNone(thread.lineage) && hasUnseenResult(thread));

/** The thread at the top of `thread`'s lineage: itself when it is not a subagent. */
const rootOf = (thread: ThreadShell): ThreadId =>
  Option.match(thread.lineage, {
    onNone: () => thread.id,
    onSome: (lineage) => lineage.rootThreadId,
  });

/** What the count reads: the projects and the live rows (a shell snapshot, or the brain's rows). */
export interface NeedsYouShell {
  readonly projects: ReadonlyArray<
    Pick<ProjectShell, "id" | "kind" | "projectThreadId">
  >;
  readonly threads: ReadonlyArray<ThreadShell>;
}

/**
 * The listing rule, in one place: the roots the user can reach, each folder project's project
 * thread the rows hold, and the scratch thread `scratchThreadId` names when the rows hold it.
 */
const reachableRoots = (
  shell: NeedsYouShell,
  scratchThreadId: Option.Option<ThreadId>
): ReadonlySet<ThreadId> => {
  const projectThreads = shell.projects
    .filter((project) => project.kind === "folder")
    .flatMap((project) =>
      Option.toArray(projectThreadOf(project, shell.threads))
    );

  const scratch = Option.toArray(
    Option.flatMap(scratchThreadId, (threadId) =>
      Option.fromUndefinedOr(
        shell.threads.find(
          (thread) => thread.id === threadId && Option.isNone(thread.lineage)
        )
      )
    )
  );

  return new Set(
    [...projectThreads, ...scratch].flatMap((thread) =>
      Option.isNone(thread.archivedAt) ? [thread.id] : []
    )
  );
};

/**
 * The reachable roots whose tree needs the user (`needsYou` on the root or any row under it).
 * Archived rows are skipped. The rail reads it per project; the badges count it.
 */
export const rootsNeedingYou = (
  shell: NeedsYouShell,
  scratchThreadId: Option.Option<ThreadId>
): ReadonlySet<ThreadId> => {
  const reachable = reachableRoots(shell, scratchThreadId);
  const roots = new Set<ThreadId>();

  for (const thread of shell.threads) {
    const root = rootOf(thread);

    if (
      reachable.has(root) &&
      Option.isNone(thread.archivedAt) &&
      needsYou(thread)
    ) {
      roots.add(root);
    }
  }

  return roots;
};

/**
 * The one counting rule: how many threads the user talks to need them. The favicon, the app icon
 * and the push's number all show it; the brain passes no scratch thread (module header).
 */
export const needsYouCount = (
  shell: NeedsYouShell,
  scratchThreadId: Option.Option<ThreadId>
): number => rootsNeedingYou(shell, scratchThreadId).size;
