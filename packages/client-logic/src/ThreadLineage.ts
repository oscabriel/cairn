// The work panel's lineage (surfaces note S5): for the open thread, its parent chain (the way up)
// and its children, each with its state from the one thread-state function, the live ones first
// and the rest under "Previous", folded, and a window of 6 rows that grows 12 at a time. Pure, so
// the panel, the phone's sheet and the judges read a shell alike.
//
// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadRelationships.ts
// (`deriveThreadRelationshipGraph`, `immediateThreadRelationships`, `orderWebThreadLineageRows`)
// and apps/web/src/components/chat/ThreadRelationshipsControl.tsx (`resolveThreadLineageWindow`,
// the 6 and 12 row counts, the running and "Previous agents" groups) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a child is any row whose parent is the open
// thread; the first shell row of an id wins; a missing parent is still a node, shown as missing;
// a loop is walked once; siblings sort newest created first, then by id, and arriving activity
// never reorders them; a window shows the first rows and counts the hidden ones, and "Show N more"
// shows at most a page. Changed: Cairn's tree has only subagent edges, read from each shell row's
// `lineage` (ADR 0028), so the parent chain is walked to the root instead of one parent row; a
// child's state is `threadStatus`'s, and at rest the latest settlement in the parent's registry
// (done, failed or stopped), else what its row says of its last run. Not ported: forks, context
// transfers, merge back, archived snapshots and provider-native subagents.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import type { SettlementOutcome } from "@cairn/protocol/Subagents";
import { DateTime, Option } from "effect";
import type { Schema } from "effect";

import { pendingSubagentRequests } from "./SubagentRollup.ts";
import type { SubagentRequest } from "./SubagentRollup.ts";
import type { SubagentLabel, SubagentState } from "./SubagentRuntime.ts";
import {
  isTerminalSubagentState,
  registryChildrenOf,
  SUBAGENT_LABELS,
} from "./SubagentRuntime.ts";
import { threadStatus } from "./ThreadState.ts";

/** Rows a lineage group shows before its first "Show more". */
export const LINEAGE_FIRST_PAGE = 6;

/** Rows each "Show more" adds. */
export const LINEAGE_PAGE = 12;

/** The rows a group shows, and how many stay hidden behind "Show more". */
export interface LineageWindow<Row> {
  readonly visibleRows: ReadonlyArray<Row>;
  readonly hiddenCount: number;
}

/** The rows a group shows at `visibleCount`, and how many stay hidden. */
export const lineageWindow = <Row>(
  rows: ReadonlyArray<Row>,
  visibleCount: number
): LineageWindow<Row> => {
  const visibleRows = rows.slice(0, Math.max(0, visibleCount));

  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
};

/** What "Show N more" says: the hidden rows, at most one page. */
export const showMoreCount = (hiddenCount: number): number =>
  Math.min(hiddenCount, LINEAGE_PAGE);

/**
 * Where a child stands in the panel: a subagent's states, or `idle` for a child at rest that never
 * ran and has no settlement.
 */
export type ChildStatus = SubagentState | "idle";

/** Every child status's words and tone; a live one says what its own row says. */
export const CHILD_LABELS: Readonly<Record<ChildStatus, SubagentLabel>> = {
  ...SUBAGENT_LABELS,
  idle: { word: "Idle", tone: "muted" },
};

/** True once a child is at rest: it shows under "Previous" and offers no Stop. */
export const isRestingChildStatus = (status: ChildStatus): boolean =>
  status === "idle" || isTerminalSubagentState(status);

/**
 * Statuses a stop can end: a run working or held on a request. A `waiting` or `parked` child is
 * held by its own children or tasks, which a child's stop keeps, and a `limited` one has no run, so
 * none of them offers Stop.
 */
const STOPPABLE: ReadonlySet<ChildStatus> = new Set<ChildStatus>([
  "working",
  "approval",
  "input",
  "asking-parent",
]);

/** True when the panel offers Stop on the child: a stop ends its run. */
export const isStoppableChildStatus = (status: ChildStatus): boolean =>
  STOPPABLE.has(status);

const SETTLED: Readonly<Record<SettlementOutcome, ChildStatus>> = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

/**
 * A child's status: its row's thread status while it works, asks or is held; at rest, how its
 * latest settlement ended, else "done" after a run that completed, "stopped" after one that started
 * and never completed, and "idle" when it never ran.
 */
export const childStatusOf = (
  child: ThreadShell,
  request: Option.Option<SubagentRequest>,
  settled: Option.Option<SettlementOutcome>
): ChildStatus => {
  const status = threadStatus(child, request);

  if (status !== "ready") {
    return status;
  }

  if (Option.isSome(settled)) {
    return SETTLED[settled.value];
  }

  if (Option.isSome(child.latestRunCompletedAt)) {
    return "done";
  }

  return Option.isSome(child.latestRunStartedAt) ? "stopped" : "idle";
};

/** One ancestor of the open thread: its id, and its row unless it is missing from the shell. */
export interface LineageAncestor {
  readonly threadId: ThreadId;
  readonly thread: Option.Option<ThreadShell>;
}

/** One child of the open thread as the panel lists it. */
export interface LineageChild {
  readonly thread: ThreadShell;
  readonly status: ChildStatus;
  readonly label: SubagentLabel;
}

/** The open thread's place in the tree: the way up, and its children by whether they are live. */
export interface Lineage {
  /** The parent first, then its parent, up to the root or the first missing or repeated one. */
  readonly ancestors: ReadonlyArray<LineageAncestor>;
  /** Children working, asking or held, newest created first. */
  readonly active: ReadonlyArray<LineageChild>;
  /** Children at rest, newest created first. */
  readonly previous: ReadonlyArray<LineageChild>;
}

/** The rows by id, the first row of an id winning (t3code: callers list live rows first). */
const byIdOf = (
  threads: ReadonlyArray<ThreadShell>
): ReadonlyMap<ThreadId, ThreadShell> => {
  const byId = new Map<ThreadId, ThreadShell>();

  for (const thread of threads) {
    if (!byId.has(thread.id)) {
      byId.set(thread.id, thread);
    }
  }

  return byId;
};

/** The parent chain of `threadId`, nearest first; a missing parent ends it, a loop ends it once. */
export const ancestorsOf = (
  threadId: ThreadId,
  threads: ReadonlyArray<ThreadShell>
): ReadonlyArray<LineageAncestor> => {
  const byId = byIdOf(threads);
  const seen = new Set<ThreadId>([threadId]);
  const ancestors: Array<LineageAncestor> = [];

  let parent = Option.flatMap(
    Option.fromUndefinedOr(byId.get(threadId)),
    (thread) => Option.map(thread.lineage, (lineage) => lineage.parentThreadId)
  );

  while (Option.isSome(parent) && !seen.has(parent.value)) {
    const id = parent.value;
    const thread = Option.fromUndefinedOr(byId.get(id));

    seen.add(id);
    ancestors.push({ threadId: id, thread });
    parent = Option.flatMap(thread, (found) =>
      Option.map(found.lineage, (lineage) => lineage.parentThreadId)
    );
  }

  return ancestors;
};

const createdAtOf = (thread: ThreadShell): number =>
  DateTime.toEpochMillis(thread.createdAt);

/** Newest created first, then by id, so arriving activity never reorders siblings. */
const newestFirst = (a: ThreadShell, b: ThreadShell): number =>
  createdAtOf(b) - createdAtOf(a) || a.id.localeCompare(b.id);

/**
 * The lineage of `threadId`: its parent chain and its children, each child's status from its row,
 * what its descendants ask, and at rest its outcome in `settled` (the open thread's registry,
 * `settledOutcomesOf`).
 */
export const lineageOf = (
  threadId: ThreadId,
  threads: ReadonlyArray<ThreadShell>,
  settled: ReadonlyMap<ThreadId, SettlementOutcome>
): Lineage => {
  const requests = pendingSubagentRequests(threads);

  const children = [...byIdOf(threads).values()]
    .filter((thread) =>
      Option.exists(
        thread.lineage,
        (lineage) =>
          lineage.parentThreadId === threadId && thread.id !== threadId
      )
    )
    .toSorted(newestFirst)
    .map((thread): LineageChild => {
      const status = childStatusOf(
        thread,
        Option.fromUndefinedOr(requests.get(thread.id)),
        Option.fromUndefinedOr(settled.get(thread.id))
      );

      return { thread, status, label: CHILD_LABELS[status] };
    });

  return {
    ancestors: ancestorsOf(threadId, threads),
    active: children.filter((child) => !isRestingChildStatus(child.status)),
    previous: children.filter((child) => isRestingChildStatus(child.status)),
  };
};

/** True when the thread has a place in a tree: a parent or a child. */
export const hasLineage = (lineage: Lineage): boolean =>
  lineage.ancestors.length > 0 ||
  lineage.active.length > 0 ||
  lineage.previous.length > 0;

/**
 * Each child's latest settlement in a `cairn.subagents` document as a client holds it, by the
 * child's thread; a child with no settlement yet is absent.
 */
export const settledOutcomesOf = (
  document: Schema.Json | undefined
): ReadonlyMap<ThreadId, SettlementOutcome> =>
  new Map(
    [...registryChildrenOf(document).values()].flatMap((child) => {
      const latest = child.settlements.at(-1);

      return latest === undefined
        ? []
        : [[child.threadId, latest.outcome] as const];
    })
  );
