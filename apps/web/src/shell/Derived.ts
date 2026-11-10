// What the shell reads off its Model: the rail's projects and their marks, the selected
// project, its project thread and the threads it manages, each with its status from the one
// thread-state function (`ThreadState.ts`), and what the chat header says about the open thread.
// On the hero and a draft's page the selected project is the draft's, so the rail, the list and the
// hero name one project (U-21). An earlier project thread the route opens is read from the
// "Previous" fold or the brain's answer for it, since archived rows are not in the shell (ADR 0048). Pure, so the views, the
// catalogue and the tests read the same answers.

import { rootsNeedingYou } from "@cairn/client-logic/Badge";
import {
  defaultProjectOf,
  listedThreadsOf,
  managedThreadsOf,
  projectThreadOf,
} from "@cairn/client-logic/ProjectThread";
import {
  pendingSubagentRequests,
  subagentRequestFor,
} from "@cairn/client-logic/SubagentRollup";
import type { SubagentRequest } from "@cairn/client-logic/SubagentRollup";
import { STATE_LOOKS, threadState } from "@cairn/client-logic/ThreadState";
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
 * The earlier project thread the route opens, however the page was reached (a fold click, Back, a
 * reload or a link): a thread the shell does not hold that the fold's rows hold, or that was opened
 * last (from the fold, or as the brain answered for it).
 */
export const openEarlierThreadOf = (
  model: Model
): Option.Option<ThreadShell> => {
  const { route } = model.context;

  if (
    !Predicate.isTagged(route, "Thread") ||
    Option.isSome(openThreadOf(model))
  ) {
    return Option.none();
  }

  const isRouted = (thread: ThreadShell) => thread.id === route.threadId;

  return Option.orElse(Option.filter(model.previous.opened, isRouted), () =>
    Option.flatMap(model.previous.rows, (rows) =>
      Array.findFirst(rows.threads, isRouted)
    )
  );
};

/**
 * The project the sidebar shows. On the hero and a draft's page it is the draft's project, the one
 * the hero names and launches in; elsewhere the one picked on the rail, else the open thread's
 * (or the earlier project thread's), else the hero's default. None when there is no folder project.
 */
export const selectedProjectOf = (
  model: Model
): Option.Option<ProjectShell> => {
  const projects = railProjectsOf(model);
  const { route } = model.context;

  const byId = (id: ProjectId) =>
    Array.findFirst(projects, (project) => project.id === id);

  const onDraft =
    Predicate.isTagged(route, "Hero") || Predicate.isTagged(route, "Draft");

  return Option.firstSomeOf([
    onDraft
      ? Option.flatMap(model.context.draftProjectId, byId)
      : Option.none(),
    Option.flatMap(model.selectedProjectId, byId),
    Option.flatMap(openProjectId(model), byId),
    Option.flatMap(openEarlierThreadOf(model), (thread) =>
      byId(thread.projectId)
    ),
    defaultProjectOf(projects),
  ]);
};

/**
 * What the "Previous" fold reads for the selected project: its id and its project thread, so a
 * refresh (which moves the mark) reads the fold again. None when no project is selected.
 */
export const previousKeyOf = (
  model: Model
): Option.Option<{ readonly key: string; readonly projectId: ProjectId }> =>
  Option.map(selectedProjectOf(model), (project) => ({
    key: `${project.id} ${Option.getOrElse(project.projectThreadId, () => "none")}`,
    projectId: project.id,
  }));

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

const IDLE: Status = statusOfLabel(STATE_LOOKS.idle);

const DONE: Status = statusOfLabel(STATE_LOOKS.done);

/**
 * A thread's status, from the one thread-state function in the one state table's word, tone and
 * mark (U-14): its label when it has one; else Done once a run has finished, Idle before any has.
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
      onSome: statusOfLabel,
      onNone: () => (Option.isSome(thread.latestRunCompletedAt) ? DONE : IDLE),
    }),
  };
};

/** What each thread's descendants ask of the user, for the rows' states. */
export const requestsOf = (
  model: Model
): ReadonlyMap<ThreadId, SubagentRequest> =>
  pendingSubagentRequests(threadsOf(model));

/** What a rail bubble's mark says: the project's thread needs the user, or one is working. */
export type ProjectMark = "needs" | "working" | "none";

/**
 * The mark of `project`'s bubble: "needs" exactly when the one counting rule counts its project
 * thread (`rootsNeedingYou`, the favicon's and the push's rule, C-4; the open thread's result the
 * user watches land does not light it), else "working" while a thread it lists is at work.
 */
export const projectMarkOf = (
  model: Model,
  project: ProjectShell,
  requests: ReadonlyMap<ThreadId, SubagentRequest>
): ProjectMark => {
  const threads = threadsOf(model);

  const page = {
    scratchThreadId: Option.none(),
    openThreadId: Option.map(openThreadOf(model), (thread) => thread.id),
  };

  if (rootsNeedingYou({ projects: [project], threads }, page).size > 0) {
    return "needs";
  }

  return listedThreadsOf(project, threads).some(
    (thread) => rowStatusOf(thread, requests, model.nowMs).category === "active"
  )
    ? "working"
    : "none";
};

/** The letter a bubble shows when its project has no favicon. */
export const projectLetterOf = (project: ProjectShell): string =>
  Option.getOrElse(
    Array.head(Array.fromIterable(project.title.trim())),
    () => "?"
  ).toUpperCase();

/**
 * A managed row's quiet line: its status word, the same word its mark and the header say (U-9,
 * U-14), and its age, so a phone with no hover tells Failed, Done and Idle apart.
 */
export const managedMetaOf = (
  thread: ThreadShell,
  row: RowStatus,
  nowMs: number
): string => {
  const at = Option.getOrElse(
    Option.orElse(thread.latestRunStartedAt, () => thread.latestRunCompletedAt),
    () => thread.createdAt
  );

  return `${row.status.word} · ${formatSidebarAge(at, nowMs)}`;
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
