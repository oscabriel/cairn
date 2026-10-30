// A project's project thread and the threads it manages, as the sidebar lists them (the user,
// 2026-10-29). The project row marks its one project thread; the managed threads are every row
// whose lineage roots at it (subagents, brief children, workflow nodes), newest first, so the
// running list under the project thread reads like a feed. A mark that names a thread the client
// does not hold (archived, deleted, or not yet arrived) reads as none.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option, Order } from "effect";

/** The fields of a row the project thread functions read. */
export type ManagedRow = Pick<
  ThreadShell,
  "id" | "projectId" | "lineage" | "createdAt"
>;

/** The project's project thread among `threads`, or none when it has none the client holds. */
export const projectThreadOf = <T extends ManagedRow>(
  project: Pick<ProjectShell, "id" | "projectThreadId">,
  threads: ReadonlyArray<T>
): Option.Option<T> =>
  Option.flatMap(project.projectThreadId, (threadId) =>
    Option.fromUndefinedOr(
      threads.find(
        (thread) =>
          thread.id === threadId &&
          thread.projectId === project.id &&
          Option.isNone(thread.lineage)
      )
    )
  );

const newestFirst = Order.mapInput(
  Order.flip(DateTime.Order),
  (thread: ManagedRow) => thread.createdAt
);

/** The threads `projectThreadId` manages: every row whose lineage roots at it, newest first. */
export const managedThreadsOf = <T extends ManagedRow>(
  projectThreadId: ThreadId,
  threads: ReadonlyArray<T>
): ReadonlyArray<T> =>
  threads
    .filter((thread) =>
      Option.exists(
        thread.lineage,
        (lineage) => lineage.rootThreadId === projectThreadId
      )
    )
    .toSorted(newestFirst);

/**
 * The rows the sidebar lists under `project`: its project thread, then the threads it manages.
 * None when the client holds no project thread for it.
 */
export const listedThreadsOf = <T extends ManagedRow>(
  project: Pick<ProjectShell, "id" | "projectThreadId">,
  threads: ReadonlyArray<T>
): ReadonlyArray<T> =>
  Option.match(projectThreadOf(project, threads), {
    onNone: () => [],
    onSome: (projectThread) => [
      projectThread,
      ...managedThreadsOf(projectThread.id, threads),
    ],
  });
