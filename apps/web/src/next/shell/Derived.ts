// What the `next` shell reads off its Model: the rail's projects and their marks, the selected
// project, its project thread and the threads it manages, each with its status from the one
// thread-state function (`ThreadState.ts`), and what the chat header says about the open thread.
// Pure, so the views, the catalogue and the tests read the same answers.

import {
  managedThreadsOf,
  projectThreadOf,
} from "@cairn/client-logic/ProjectThread";
import {
  pendingSubagentRequests,
  subagentRequestFor,
} from "@cairn/client-logic/SubagentRollup";
import type { SubagentRequest } from "@cairn/client-logic/SubagentRollup";
import { THREAD_LABELS, threadState } from "@cairn/client-logic/ThreadState";
import type { ThreadCategory } from "@cairn/client-logic/ThreadState";
import { formatSidebarAge } from "@cairn/client-logic/Time";
import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option, Predicate } from "effect";

import type { Status } from "../ui/StatusChip.ts";
import { statusOfLabel } from "../ui/StatusChip.ts";
import type { Model } from "./Model.ts";

const NO_PROJECTS: ReadonlyArray<ProjectShell> = [];

const NO_THREADS: ReadonlyArray<ThreadShell> = [];

/** The shell's threads, or none before it arrives. */
export const threadsOf = (model: Model): ReadonlyArray<ThreadShell> =>
  Option.match(model.context.shell, {
    onNone: () => NO_THREADS,
    onSome: (shell) => shell.threads,
  });

/** The projects the rail shows: every folder project, oldest first. The scratch project is hidden. */
export const railProjectsOf = (model: Model): ReadonlyArray<ProjectShell> =>
  Option.match(model.context.shell, {
    onNone: () => NO_PROJECTS,
    onSome: (shell) =>
      shell.projects.filter((project) => project.kind === "folder"),
  });

/**
 * A folder as the add-project picker compares it with a project's root: trimmed, a leading `~` read
 * against the home folder when the picker knows it, and no trailing slash.
 */
export const folderOf = (
  input: string,
  home: Option.Option<string>
): string => {
  const trimmed = input.trim();

  const expanded = Option.match(home, {
    onNone: () => trimmed,
    onSome: (root) =>
      trimmed === "~" || trimmed.startsWith("~/")
        ? `${root}${trimmed.slice(1)}`
        : trimmed,
  });

  return expanded.length > 1 ? expanded.replace(/\/+$/u, "") : expanded;
};

/** The rail's project rooted at `folder`, when one is. */
export const projectAtFolder = (
  model: Model,
  folder: string
): Option.Option<ProjectShell> =>
  Array.findFirst(
    railProjectsOf(model),
    (project) => folderOf(project.workspaceRoot, Option.none()) === folder
  );

/** The thread the route opens, when it opens one the shell holds. */
export const openThreadOf = (model: Model): Option.Option<ThreadShell> =>
  Predicate.isTagged(model.context.route, "Thread")
    ? Array.findFirst(
        threadsOf(model),
        (thread) =>
          Predicate.isTagged(model.context.route, "Thread") &&
          thread.id === model.context.route.threadId
      )
    : Option.none();

/** The open thread's project, when it is a folder project the rail shows. */
const openProjectId = (model: Model): Option.Option<ProjectId> =>
  Option.flatMap(openThreadOf(model), (thread) =>
    Option.map(
      Array.findFirst(
        railProjectsOf(model),
        (project) => project.id === thread.projectId
      ),
      (project) => project.id
    )
  );

/**
 * The project the sidebar shows: the one picked on the rail, else the open thread's, else the
 * first. None when there is no folder project.
 */
export const selectedProjectOf = (
  model: Model
): Option.Option<ProjectShell> => {
  const projects = railProjectsOf(model);

  const byId = (id: ProjectId) =>
    Array.findFirst(projects, (project) => project.id === id);

  return Option.firstSomeOf([
    Option.flatMap(model.selectedProjectId, byId),
    Option.flatMap(openProjectId(model), byId),
    Array.head(projects),
  ]);
};

/** The project's one project thread, when the shell holds it. */
export const projectThreadFor = (
  model: Model,
  project: ProjectShell
): Option.Option<ThreadShell> => projectThreadOf(project, threadsOf(model));

/** The threads the project thread manages, newest first. */
export const managedThreadsFor = (
  model: Model,
  projectThread: ThreadShell
): ReadonlyArray<ThreadShell> =>
  managedThreadsOf(projectThread.id, threadsOf(model));

/** A row's status: its tone, mark and word, and its category for the rail's marks. */
export interface RowStatus {
  readonly status: Status;
  readonly category: ThreadCategory;
}

const IDLE: Status = { tone: "neutral", mark: "idle", word: "Idle" };

const DONE: Status = statusOfLabel(THREAD_LABELS.done);

/**
 * A thread's status, from the one thread-state function: its label when it has one; else Done
 * once a run has finished, Idle before any has.
 */
export const rowStatusOf = (
  thread: ThreadShell,
  requests: ReadonlyMap<ThreadId, SubagentRequest>,
  nowMs: number
): RowStatus => {
  const state = threadState(thread, {
    now: DateTime.makeUnsafe(nowMs),
    subagentRequest: subagentRequestFor(requests, thread.id),
  });

  return {
    category: state.category,
    status: Option.match(state.label, {
      // A parked or limited thread is not asking anything: its mark is the warning, so it does
      // not read as the needs-you dot it shares a tone with.
      onSome: (label) =>
        state.status === "parked" || state.status === "limited"
          ? { ...statusOfLabel(label), mark: "warning" as const }
          : statusOfLabel(label),
      onNone: () => (Option.isSome(thread.latestRunCompletedAt) ? DONE : IDLE),
    }),
  };
};

/** What each thread's descendants ask of the user, for the rows' states. */
export const requestsOf = (
  model: Model
): ReadonlyMap<ThreadId, SubagentRequest> =>
  pendingSubagentRequests(threadsOf(model));

/** What a rail bubble's mark says: a thread in the project needs the user, or one is working. */
export type ProjectMark = "needs" | "working" | "none";

/** The mark of `project`'s bubble, from its project thread and the threads it manages. */
export const projectMarkOf = (
  model: Model,
  project: ProjectShell,
  requests: ReadonlyMap<ThreadId, SubagentRequest>
): ProjectMark => {
  const top = projectThreadFor(model, project);

  const threads = Option.match(top, {
    onNone: () => NO_THREADS,
    onSome: (thread) => [thread, ...managedThreadsFor(model, thread)],
  });

  const categories = new Set(
    threads.map(
      (thread) => rowStatusOf(thread, requests, model.context.nowMs).category
    )
  );

  if (categories.has("waiting-on-you")) {
    return "needs";
  }

  return categories.has("active") ? "working" : "none";
};

/** The letter a bubble shows when its project has no favicon. */
export const projectLetterOf = (project: ProjectShell): string =>
  Option.getOrElse(
    Array.head(Array.fromIterable(project.title.trim())),
    () => "?"
  ).toUpperCase();

/** A managed row's quiet line: what it is and its age, or that it asks the user. */
export const managedMetaOf = (
  thread: ThreadShell,
  row: RowStatus,
  nowMs: number
): string => {
  if (row.category === "waiting-on-you") {
    return "subagent · asks you";
  }

  const at = Option.getOrElse(
    Option.orElse(thread.latestRunStartedAt, () => thread.latestRunCompletedAt),
    () => thread.createdAt
  );

  return `subagent · ${formatSidebarAge(at, nowMs)}`;
};

/** The project thread's age, from its latest run or its creation. */
export const projectThreadAgeOf = (
  thread: ThreadShell,
  nowMs: number
): string =>
  formatSidebarAge(
    Option.getOrElse(thread.latestRunStartedAt, () => thread.createdAt),
    nowMs
  );

/** What the open thread is to its project, for the chat header's quiet word. */
export type ThreadRole = "project-thread" | "managed" | "scratch" | "thread";

/** The open thread's role: the project thread, a thread it manages, a scratch thread, or neither. */
export const threadRoleOf = (model: Model, thread: ThreadShell): ThreadRole => {
  const project = Option.flatMap(model.context.shell, (shell) =>
    Array.findFirst(shell.projects, (each) => each.id === thread.projectId)
  );

  if (Option.exists(project, (found) => found.kind === "scratch")) {
    return "scratch";
  }

  if (Option.isSome(thread.lineage)) {
    return "managed";
  }

  return Option.exists(project, (found) =>
    Option.contains(found.projectThreadId, thread.id)
  )
    ? "project-thread"
    : "thread";
};

/** The project a thread belongs to, from the shell. */
export const projectOfThread = (
  model: Model,
  thread: ThreadShell
): Option.Option<ProjectShell> =>
  Option.flatMap(model.context.shell, (shell) =>
    Array.findFirst(shell.projects, (each) => each.id === thread.projectId)
  );

/** The scratch thread's row, when the overlay holds one the shell still has. */
export const scratchRowOf = (model: Model): Option.Option<ThreadShell> =>
  Option.flatMap(model.scratch.threadId, (threadId) =>
    Array.findFirst(threadsOf(model), (thread) => thread.id === threadId)
  );
