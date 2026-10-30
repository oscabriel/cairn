// What update reads off the Model: the rows with pending changes laid over them, the shelves and the
// visible order the thread shortcuts walk.

import {
  partitionSidebarThreads,
  visibleThreadOrder,
} from "@cairn/client-logic/Sidebar";
import type { SidebarPartition } from "@cairn/client-logic/Sidebar";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option } from "effect";

import type { Model } from "./Model.ts";
import { withPendingChanges } from "./Pending.ts";

/** The time labels and shelves are computed at. */
export const nowOf = (model: Model): DateTime.Utc =>
  DateTime.makeUnsafe(model.nowMs);

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

interface PartitionMemo {
  readonly shell: Model["context"]["shell"];
  readonly pending: Model["pending"];
  readonly nowMs: number;
  readonly partition: SidebarPartition<ThreadShell>;
}

/** The last partition, so updates whose rows did not change share it. */
const partitionMemo = new Map<"last", PartitionMemo>();

/** The rows of each shelf. */
export const partitionOf = (model: Model): SidebarPartition<ThreadShell> => {
  const last = partitionMemo.get("last");

  if (
    last !== undefined &&
    last.shell === model.context.shell &&
    last.pending === model.pending &&
    last.nowMs === model.nowMs
  ) {
    return last.partition;
  }

  const partition = partitionSidebarThreads(threadsOf(model), nowOf(model));

  partitionMemo.set("last", {
    shell: model.context.shell,
    pending: model.pending,
    nowMs: model.nowMs,
    partition,
  });

  return partition;
};

/** The ids in the order the sidebar shows them now. */
export const visibleOrderOf = (model: Model): Array<string> =>
  visibleThreadOrder(partitionOf(model), model.shelves);
