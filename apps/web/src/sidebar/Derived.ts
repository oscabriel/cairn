// What update and view both read off the Model: the rows with pending changes laid over them, the
// shelves, the search results, the visible order and each thread's menu.
import {
  partitionSidebarThreads,
  previewMatchIds,
  searchSidebarThreads,
  sectionOf,
  visibleThreadOrder,
} from "@cairn/client-logic/Sidebar";
import type {
  SidebarPartition,
  SidebarSection,
} from "@cairn/client-logic/Sidebar";
import { buildThreadActionMenuItems } from "@cairn/client-logic/ThreadMenu";
import type {
  ContextMenuItem,
  ThreadActionMenuId,
} from "@cairn/client-logic/ThreadMenu";
import {
  canSnooze,
  effectiveSnoozed,
  resolveSnoozePresets,
} from "@cairn/client-logic/ThreadSettled";
import type { SnoozePreset } from "@cairn/client-logic/ThreadSettled";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option } from "effect";

import type { Model } from "./Model.ts";
import { withPendingChanges } from "./Pending.ts";

/** The time labels and shelves are computed at. */
export const nowOf = (model: Model): DateTime.Utc =>
  DateTime.makeUnsafe(model.nowMs);

/** The same time in this device's zone, for snooze presets. */
export const zonedNowOf = (model: Model): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(model.nowMs, { timeZone: DateTime.zoneMakeLocal() });

/** Every project the shell holds. */
export const projectsOf = (model: Model): ReadonlyArray<ProjectShell> =>
  Option.match(model.context.shell, {
    onNone: () => [],
    onSome: (shell) => shell.projects,
  });

/** The shell's thread rows, each with the user's not-yet-shown changes laid over it. */
export const threadsOf = (model: Model): ReadonlyArray<ThreadShell> =>
  Option.match(model.context.shell, {
    onNone: () => [],
    onSome: (shell) => withPendingChanges(shell.threads, model.pending),
  });

/** A thread row by id, with pending changes. */
export const findThread = (
  model: Model,
  threadId: string
): Option.Option<ThreadShell> =>
  Array.findFirst(threadsOf(model), (thread) => thread.id === threadId);

/** A project by id. */
export const findProject = (
  model: Model,
  projectId: string
): Option.Option<ProjectShell> =>
  Array.findFirst(projectsOf(model), (project) => project.id === projectId);

interface PartitionMemo {
  readonly shell: Model["context"]["shell"];
  readonly pending: Model["pending"];
  readonly nowMs: number;
  readonly projectFilter: Model["projectFilter"];
  readonly partition: SidebarPartition<ThreadShell>;
}

/** The last partition, so update and view, and a render whose rows did not change, share it. */
const partitionMemo = new Map<"last", PartitionMemo>();

/** The rows of each shelf, under the project filter. */
export const partitionOf = (model: Model): SidebarPartition<ThreadShell> => {
  const last = partitionMemo.get("last");

  if (
    last !== undefined &&
    last.shell === model.context.shell &&
    last.pending === model.pending &&
    last.nowMs === model.nowMs &&
    last.projectFilter === model.projectFilter
  ) {
    return last.partition;
  }

  const partition = partitionSidebarThreads(
    threadsOf(model),
    nowOf(model),
    model.projectFilter
  );

  partitionMemo.set("last", {
    shell: model.context.shell,
    pending: model.pending,
    nowMs: model.nowMs,
    projectFilter: model.projectFilter,
    partition,
  });

  return partition;
};

/** A thread's shelf now. */
export const sectionOfThread = (
  model: Model,
  thread: ThreadShell
): SidebarSection => sectionOf(thread, nowOf(model));

/** The ids in the order the sidebar shows them now. */
export const visibleOrderOf = (model: Model): Array<string> =>
  visibleThreadOrder(partitionOf(model), model.shelves);

/** True while the search field holds a query. */
export const isSearching = (model: Model): boolean =>
  model.search.trim().length > 0;

/** The search results: title matches, then threads whose latest message matches. */
export const searchResultsOf = (model: Model): Array<ThreadShell> => {
  const threads = threadsOf(model).filter((thread) =>
    Option.match(model.projectFilter, {
      onNone: () => true,
      onSome: (projectId) => thread.projectId === projectId,
    })
  );

  return searchSidebarThreads(
    threads,
    model.search,
    previewMatchIds(threads, model.search)
  );
};

/** The snooze choices now, with this device's clock and zone. */
export const snoozePresetsOf = (model: Model): ReadonlyArray<SnoozePreset> =>
  resolveSnoozePresets(zonedNowOf(model));

/** A thread's context menu. */
export const threadMenuOf = (
  model: Model,
  thread: ThreadShell
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> => {
  const now = nowOf(model);

  return buildThreadActionMenuItems({
    hasBranch: Option.isSome(thread.branch),
    projectFilter: Option.map(
      findProject(model, thread.projectId),
      (project) => ({
        label: project.title,
        isActive: Option.contains(model.projectFilter, thread.projectId),
      })
    ),
    isPinned: Option.isSome(thread.pinnedAt),
    isSettled: Option.contains(thread.settledOverride, "settled"),
    autoSettleEnabled: Option.isNone(thread.autoSettleDisabledAt),
    isSnoozed: effectiveSnoozed(thread, now),
    canSnoozeNow: canSnooze(thread, now),
    isRunning: thread.activity === "preparing" || thread.activity === "running",
    snoozePresets: snoozePresetsOf(model),
  });
};
