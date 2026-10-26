// One lookup of a thread's shell row and its project, so the header, the hold banner, the page and
// the outbox read the same row the same way.

import type {
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { Array, Option } from "effect";

/** The thread's shell row, when the shell has arrived and holds it. */
export const threadRowOf = (
  shell: Option.Option<ShellSnapshot>,
  threadId: string
): Option.Option<ThreadShell> =>
  Option.flatMap(shell, (snapshot) =>
    Array.findFirst(snapshot.threads, (thread) => thread.id === threadId)
  );

/** The project a thread row belongs to. */
export const projectOf = (
  shell: Option.Option<ShellSnapshot>,
  thread: ThreadShell
): Option.Option<ProjectShell> =>
  Option.flatMap(shell, (snapshot) =>
    Array.findFirst(
      snapshot.projects,
      (project) => project.id === thread.projectId
    )
  );
