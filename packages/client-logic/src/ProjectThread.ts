// A project's project thread and the threads it manages, as the sidebar lists them (the user,
// 2026-10-29). The project row marks its one project thread; the managed threads are every row
// whose lineage roots at it (subagents, brief children, workflow nodes), newest first, so the
// running list under the project thread reads like a feed. A mark that names a thread the client
// does not hold (archived, deleted, or not yet arrived) reads as none.
//
// A new top-level thread never replaces a live project thread unasked (ADR 0048): the hero and
// `chat.new` open the project thread instead, and only the header's Refresh replaces it. The hero's
// default project (the most recently updated folder project) is read here too, so the hero, the
// shell's rail and `chat.new` agree on it.

import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option, Order } from "effect";

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

const byRecentUpdate = Order.mapInput(
  Order.flip(DateTime.Order),
  (project: Pick<ProjectShell, "updatedAt">) => project.updatedAt
);

/** The folder projects a new thread can start in, most recently updated first. */
export const folderProjectsByRecent = <
  P extends Pick<ProjectShell, "kind" | "updatedAt">,
>(
  projects: ReadonlyArray<P>
): ReadonlyArray<P> =>
  projects
    .filter((project) => project.kind === "folder")
    .toSorted(byRecentUpdate);

/**
 * The hero's default project: the most recently updated folder project, where a draft that names
 * none launches. None when there is no folder project.
 */
export const defaultProjectOf = <
  P extends Pick<ProjectShell, "kind" | "updatedAt">,
>(
  projects: ReadonlyArray<P>
): Option.Option<P> => Array.head(folderProjectsByRecent(projects));

/**
 * The live project thread a new top-level thread in `project` would replace, which the hero and
 * `chat.new` open instead of launching (ADR 0048). The mark is cleared when its thread is archived or
 * deleted, so a mark is a live thread; the scratch project has none.
 */
export const projectThreadToOpen = (
  project: Pick<ProjectShell, "kind" | "projectThreadId">
): Option.Option<ThreadId> =>
  project.kind === "folder" ? project.projectThreadId : Option.none();

/**
 * Where `chat.new` goes (ADR 0048): the project thread of the project the user is in (the open
 * thread's folder project, else the hero's default), when it has one; none opens a new draft.
 */
export const newThreadOpens = (
  projects: ReadonlyArray<
    Pick<ProjectShell, "id" | "kind" | "updatedAt" | "projectThreadId">
  >,
  openProjectId: Option.Option<ProjectId>
): Option.Option<ThreadId> =>
  Option.flatMap(
    Option.orElse(
      Option.flatMap(openProjectId, (id) =>
        Array.findFirst(
          projects,
          (project) => project.id === id && project.kind === "folder"
        )
      ),
      () => defaultProjectOf(projects)
    ),
    projectThreadToOpen
  );
