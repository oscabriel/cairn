// A shell for the look catalogue's shell specimens and the shell's tests: three folder projects (one
// with a project thread managing a thread in each state), the hidden scratch project with a scratch
// thread, and the shell Model over it on a route. Never imported by the app's own views.

import {
  EARLIER,
  NOW,
  rowId,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { ApprovalId, ProjectId, TaskId } from "@cairn/protocol/Ids";
import type {
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";

import { AppRoute } from "../../Route.ts";
import type { Model } from "./Model.ts";
import { initial } from "./Model.ts";

/** The project with a project thread. */
export const CAIRN = ProjectId.make("prj_cairn");

/** A project whose favicon the catalogue shows as loaded. */
export const DEV = ProjectId.make("prj_dev");

/** A project with neither favicon nor project thread. */
export const MYR = ProjectId.make("prj_myr");

/** The hidden scratch project. */
export const SCRATCH = ProjectId.make("prj_scratch");

/** The project thread of `CAIRN`. */
export const PROJECT_THREAD = rowId(1);

/** The scratch thread. */
export const SCRATCH_THREAD = rowId(90);

const minutesAgo = (minutes: number) => DateTime.subtract(NOW, { minutes });

const project = (
  id: ProjectId,
  title: string,
  projectThreadId: Option.Option<ThreadShell["id"]>,
  kind: ProjectShell["kind"] = "folder"
): ProjectShell => ({
  id,
  title,
  kind,
  workspaceRoot: `/home/owner/Developer/projects/${title}`,
  repository: Option.none(),
  defaultModel: Option.none(),
  projectThreadId,
  createdAt: EARLIER,
  updatedAt: EARLIER,
});

const lineage = Option.some({
  parentThreadId: PROJECT_THREAD,
  relationshipToParent: "subagent" as const,
  rootThreadId: PROJECT_THREAD,
});

const managed = (
  n: number,
  title: string,
  createdMinutesAgo: number,
  overrides: Partial<ThreadShell>
): ThreadShell =>
  shellRow(n, {
    projectId: CAIRN,
    title,
    lineage,
    createdAt: minutesAgo(createdMinutesAgo),
    latestRunStartedAt: Option.some(minutesAgo(createdMinutesAgo)),
    ...overrides,
  });

/** The managed threads, one per state the list shows, newest first by creation. */
export const MANAGED: ReadonlyArray<ThreadShell> = [
  managed(2, "Pick the budget meter's thresholds", 2, {
    activity: "waiting",
    pendingRuntimeRequest: Option.some({
      id: ApprovalId.make("approval-1"),
      kind: "tool-call",
      createdAt: minutesAgo(1),
      origin: Option.none(),
    }),
    pendingCount: 1,
  }),
  managed(3, "Read the porch CLI's error codes", 4, { activity: "running" }),
  managed(4, "Probe the bridge usage endpoint", 12, {
    activity: "failed",
    lastError: Option.some("The provider answered 500."),
    lastErrorClass: Option.some("provider_error"),
  }),
  managed(5, "Steps panel projection", 21, {
    activity: "parked",
    parkedTaskIds: [TaskId.make(7)],
  }),
  managed(6, "Brief: port the fold line tallies", 60, {
    latestRunCompletedAt: Option.some(minutesAgo(50)),
  }),
  managed(7, "Map the favicon resolver", 180, {
    latestRunStartedAt: Option.none(),
  }),
];

/** The fixture shell. */
export const SHELL: ShellSnapshot = {
  snapshotSequence: 1,
  projects: [
    project(CAIRN, "cairn", Option.some(PROJECT_THREAD)),
    project(DEV, "oscargabriel-dev", Option.none()),
    project(MYR, "myr", Option.none()),
    project(SCRATCH, "No project", Option.none(), "scratch"),
  ],
  threads: [
    shellRow(1, {
      projectId: CAIRN,
      title: "Redo the look as Stone",
      activity: "running",
      latestRunStartedAt: Option.some(minutesAgo(0)),
    }),
    ...MANAGED,
    shellRow(90, { projectId: SCRATCH, title: "What does fsync promise?" }),
  ],
};

/** The shell Model over the fixture, on `route`. */
export const shellModelOn = (route: AppRoute): Model => ({
  ...initial,
  context: {
    ...initial.context,
    shell: Option.some(SHELL),
    route,
    hasClient: true,
    nowMs: DateTime.toEpochMillis(NOW),
  },
  favicons: { [DEV]: "loaded", [MYR]: "missing", [CAIRN]: "missing" },
});

/** The shell Model on the project thread. */
export const onProjectThread: Model = shellModelOn(
  AppRoute.Thread({ threadId: PROJECT_THREAD })
);
