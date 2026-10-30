// The steps panel's data (workflows note, "The steps panel's data"; surfaces note S7): what the
// panel shows of each workflow in a thread's `cairn.workflows` ledger, read from the document as a
// client holds it. Pure, so the panel, the phone's sheet and the judges read a ledger alike.
//
// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/subagentRuntime.ts
// (`deriveWorkflowGroups`, the member status rule of `workflowMembersToRuntime`,
// `workflowOpeningHeadline`) and apps/web/src/components/chat/ThreadLineageWorkflowRow.tsx
// (`phaseStatusLabel`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: phases are the union of
// the declared ones and the ones members name, the declared title wins, a phase is `pending` with
// no members, `running` while any member is live, else `done`, with its settled count; members sort
// by index and unphased ones stay with their workflow; a member still live under an ended workflow
// takes the workflow's ending, and its end time falls back to its start plus its duration, then
// to the workflow's end; the phase label and the headline's tally. Changed: Cairn's ledger rows
// (phases are named by title, not index, so a phase only members name joins after the ledger's
// list in the order its first member was dispatched; the ledger itself is append-only); a node's
// status adds `held`, `unknown` and `refused`, and the tally counts refused nodes apart; an ended
// workflow ends its live nodes `stopped` or `failed`, never `done`, because the ledger never saw
// them finish; the headline counts "nodes". Added: the totals and the log. Not ported:
// provider-native subagents, run handles, the workflow opening's script detection.
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

import type { WorkflowEstimate } from "@cairn/protocol/Policy";
import type {
  NodeState,
  WorkflowSpent,
  WorkflowState,
} from "@cairn/protocol/Workflows";
import { NodeRecord, WorkflowRecord } from "@cairn/protocol/Workflows";
import { Option, Predicate, Schema } from "effect";

/** How a node reads in the steps panel. */
export type NodeStatus =
  | "queued"
  | "running"
  | "held"
  | "unknown"
  | "done"
  | "failed"
  | "stopped"
  | "refused";

/** One node row: its ledger record, how it reads, and when it ended. */
export interface StepsNode {
  readonly node: NodeRecord;
  readonly status: NodeStatus;
  /** The record's end, else its start plus its duration, else its workflow's end once ended. */
  readonly endedAt: Option.Option<number>;
}

/** Where a phase stands: no members yet, a member still live, or every member ended. */
export type PhaseState = "pending" | "running" | "done";

/** One phase of a workflow with the nodes that ran in it. */
export interface StepsPhase {
  /** 0-based, in the panel's order. */
  readonly index: number;
  readonly title: string;
  readonly detail: Option.Option<string>;
  readonly members: ReadonlyArray<StepsNode>;
  readonly state: PhaseState;
  /** Members that ended, whatever their ending. */
  readonly settledCount: number;
}

/** One workflow as the steps panel shows it. */
export interface WorkflowGroup {
  readonly workflow: WorkflowRecord;
  readonly phases: ReadonlyArray<StepsPhase>;
  /** Nodes dispatched before any phase, by index. */
  readonly unphasedNodes: ReadonlyArray<StepsNode>;
}

const LIVE: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  "queued",
  "running",
  "held",
  "unknown",
]);

/** True while a node may still do work: queued, running, held by a plan window, or unknown. */
export const isLiveNodeStatus = (status: NodeStatus): boolean =>
  LIVE.has(status);

/** True once a node has ended; an ended node never changes status again. */
export const isEndedNodeStatus = (status: NodeStatus): boolean =>
  !LIVE.has(status);

const STATUS_OF_STATE: Record<NodeState, NodeStatus> = {
  reserved: "queued",
  running: "running",
  held: "held",
  settled: "done",
  failed: "failed",
  stopped: "stopped",
  refused: "refused",
  start_unknown: "unknown",
  stop_unknown: "unknown",
};

/** What a live node of an ended workflow reads as; none while the workflow may still run nodes. */
const ENDING_OF: Record<WorkflowState, Option.Option<NodeStatus>> = {
  proposed: Option.none(),
  approved: Option.none(),
  running: Option.none(),
  finished: Option.some("stopped"),
  failed: Option.some("failed"),
  stopped: Option.some("stopped"),
  declined: Option.some("stopped"),
};

const stepsNode = (workflow: WorkflowRecord, node: NodeRecord): StepsNode => {
  const own = STATUS_OF_STATE[node.state];

  const status = isLiveNodeStatus(own)
    ? Option.getOrElse(ENDING_OF[workflow.state], () => own)
    : own;

  const endedAt = isEndedNodeStatus(status)
    ? Option.fromNullOr(node.endedAt).pipe(
        Option.orElse(() =>
          node.startedAt === null || node.receipt === null
            ? Option.none()
            : Option.some(node.startedAt + node.receipt.durationMs)
        ),
        Option.orElse(() => Option.fromNullOr(workflow.endedAt))
      )
    : Option.none();

  return { node, status, endedAt };
};

const byIndex = (a: StepsNode, b: StepsNode) =>
  a.node.index - b.node.index || a.node.id.localeCompare(b.node.id);

/**
 * The phases of one workflow: the ledger's list (declared, then appearing, append-only), then any
 * phase only a node names, in the order its first node was dispatched. A phase's own node may land
 * before the `phase()` call that lists it, because the prelude does not wait for that call.
 */
const phasesOf = (
  workflow: WorkflowRecord,
  nodes: ReadonlyArray<StepsNode>
): ReadonlyArray<StepsPhase> => {
  const known = new Map<string, Option.Option<string>>();

  for (const phase of workflow.phases) {
    if (!known.has(phase.title)) {
      known.set(phase.title, Option.fromNullOr(phase.detail));
    }
  }

  for (const { node } of nodes) {
    if (node.phase !== null && !known.has(node.phase)) {
      known.set(node.phase, Option.none());
    }
  }

  return Array.from(known, ([title, detail], index) => {
    const members = nodes.filter(({ node }) => node.phase === title);

    const settledCount = members.filter((member) =>
      isEndedNodeStatus(member.status)
    ).length;

    let state: PhaseState = "done";

    if (members.length === 0) {
      state = "pending";
    } else if (members.some((member) => isLiveNodeStatus(member.status))) {
      state = "running";
    }

    return { index, title, detail, members, state, settledCount };
  });
};

/** When a workflow was first seen: its start, else its launch decision; none while proposed. */
const firstSeenAt = (workflow: WorkflowRecord) =>
  Option.orElse(Option.fromNullOr(workflow.startedAt), () =>
    Option.fromNullOr(workflow.decidedAt)
  );

const byFirstSeen = (a: WorkflowRecord, b: WorkflowRecord) => {
  const left = firstSeenAt(a);
  const right = firstSeenAt(b);

  // A workflow not yet decided sorts after every decided one.
  const time =
    Option.isSome(left) && Option.isSome(right)
      ? left.value - right.value
      : Number(Option.isNone(left)) - Number(Option.isNone(right));

  return time || a.id.localeCompare(b.id, "en", { numeric: true });
};

/**
 * The steps panel's groups: each workflow, oldest first, with its phases and the nodes in each,
 * and the nodes dispatched before any phase.
 */
export const deriveWorkflowGroups = (
  records: ReadonlyArray<WorkflowRecord>
): ReadonlyArray<WorkflowGroup> =>
  records.toSorted(byFirstSeen).map((workflow) => {
    const nodes = Object.values(workflow.nodes)
      .map((node) => stepsNode(workflow, node))
      .toSorted(byIndex);

    return {
      workflow,
      phases: phasesOf(workflow, nodes),
      unphasedNodes: nodes.filter(({ node }) => node.phase === null),
    };
  });

/** A workflow record whose nodes are read one at a time, so one bad node does not hide the rest. */
const LenientRecord = Schema.Struct({
  ...WorkflowRecord.fields,
  nodes: Schema.Record(Schema.String, Schema.Json),
});

const decodeLenient = Schema.decodeUnknownOption(LenientRecord);

const decodeNode = Schema.decodeUnknownOption(NodeRecord);

/**
 * The workflows of a `cairn.workflows` document as a client holds it (plain JSON). A workflow or
 * node that does not decode is left out rather than failing the thread; the stream's cut of a long
 * string (`truncated: true` beside it) still decodes.
 */
export const workflowRecordsOf = (
  document: Schema.Json | undefined
): ReadonlyArray<WorkflowRecord> => {
  if (!Predicate.isObject(document) || Array.isArray(document)) {
    return [];
  }

  const { items } = document;

  if (!Predicate.isObject(items) || Array.isArray(items)) {
    return [];
  }

  return Object.values(items).flatMap((raw) =>
    Option.toArray(
      Option.map(decodeLenient(raw), (record) => ({
        ...record,
        nodes: Object.fromEntries(
          Object.entries(record.nodes).flatMap(([id, node]) =>
            Option.toArray(
              Option.map(decodeNode(node), (decoded) => [id, decoded] as const)
            )
          )
        ),
      }))
    )
  );
};

/** The steps panel's groups of a `cairn.workflows` document as a client holds it. */
export const workflowGroupsOf = (
  document: Schema.Json | undefined
): ReadonlyArray<WorkflowGroup> =>
  deriveWorkflowGroups(workflowRecordsOf(document));

/** A phase's status word. */
export type PhaseLabel =
  | "running"
  | "failed"
  | "stopped"
  | "done"
  | "not started";

/**
 * A phase's status word: `running` while a member is live, else `failed` when one failed, else
 * `stopped` when one was stopped or refused, else `done`; `not started` with no members.
 */
export const phaseLabel = (phase: StepsPhase): PhaseLabel => {
  if (phase.state === "running") {
    return "running";
  }

  if (phase.members.some((member) => member.status === "failed")) {
    return "failed";
  }

  if (
    phase.members.some(
      (member) => member.status === "stopped" || member.status === "refused"
    )
  ) {
    return "stopped";
  }

  return phase.state === "done" ? "done" : "not started";
};

/** The panel's heading for a workflow. */
export interface WorkflowHeadline {
  readonly title: string;
  /** The description, unless it says nothing the title does not. */
  readonly description: Option.Option<string>;
  /** "4 nodes · 2 working · 1 done · 1 failed"; none before the first node. */
  readonly nodes: Option.Option<string>;
}

const TALLY_ORDER = [
  "working",
  "done",
  "failed",
  "stopped",
  "refused",
] as const;

type TallyKey = (typeof TALLY_ORDER)[number];

const TALLY_KEY: Record<NodeStatus, TallyKey> = {
  queued: "working",
  running: "working",
  held: "working",
  unknown: "working",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  refused: "refused",
};

/** The heading of a workflow: its name, what it does, and how its nodes stand. */
export const workflowHeadline = (group: WorkflowGroup): WorkflowHeadline => {
  const members = [
    ...group.phases.flatMap((phase) => phase.members),
    ...group.unphasedNodes,
  ];

  const counts = new Map<TallyKey, number>();

  for (const member of members) {
    const key = TALLY_KEY[member.status];

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const { name, description } = group.workflow;

  const tally = TALLY_ORDER.flatMap((key) => {
    const count = counts.get(key);

    return count === undefined ? [] : [`${String(count)} ${key}`];
  });

  return {
    title: name,
    description:
      description.trim() === "" || description === name
        ? Option.none()
        : Option.some(description),
    nodes:
      members.length === 0
        ? Option.none()
        : Option.some(
            [
              `${String(members.length)} ${members.length === 1 ? "node" : "nodes"}`,
              ...tally,
            ].join(" · ")
          ),
  };
};

/** One budget limit against what the run spent. */
export interface BudgetLine {
  readonly limit: number;
  /** Where the warning fires: the limit times the budget's `warnAt`, rounded down. */
  readonly soft: number;
  /** What is left, never below zero. */
  readonly remaining: number;
}

/** A workflow's totals for the panel's foot. */
export interface WorkflowTotals {
  /** Nodes by how they read, every status present with zero for none. */
  readonly nodes: Readonly<Record<NodeStatus, number>>;
  readonly spent: WorkflowSpent;
  /**
   * Dollars at list price over the priced tokens; none when tokens were spent and none of them has
   * a price, so an unknown never reads as zero (ADR 0036). `spent.unpricedTokens` names what a
   * partial sum leaves out.
   */
  readonly listMicros: Option.Option<number>;
  readonly tokenBudget: Option.Option<BudgetLine>;
  readonly listMicrosBudget: Option.Option<BudgetLine>;
  readonly estimate: Option.Option<WorkflowEstimate>;
}

const budgetLine = (
  limit: number | null,
  warnAt: number,
  spent: number
): Option.Option<BudgetLine> =>
  limit === null
    ? Option.none()
    : Option.some({
        limit,
        soft: Math.floor(limit * warnAt),
        remaining: Math.max(0, limit - spent),
      });

/** A workflow's totals: nodes by status, what it spent, its budget lines and its estimate. */
export const workflowTotals = (group: WorkflowGroup): WorkflowTotals => {
  const nodes: Record<NodeStatus, number> = {
    queued: 0,
    running: 0,
    held: 0,
    unknown: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    refused: 0,
  };

  for (const member of [
    ...group.phases.flatMap((phase) => phase.members),
    ...group.unphasedNodes,
  ]) {
    nodes[member.status] += 1;
  }

  const { budget, spent, estimate } = group.workflow;

  return {
    nodes,
    spent,
    listMicros:
      spent.tokens > 0 && spent.unpricedTokens >= spent.tokens
        ? Option.none()
        : Option.some(spent.listMicros),
    tokenBudget: budgetLine(budget.maxTokens, budget.warnAt, spent.tokens),
    listMicrosBudget: budgetLine(
      budget.maxListMicros,
      budget.warnAt,
      spent.listMicros
    ),
    estimate: Option.fromNullOr(estimate),
  };
};

/** One `log()` line of a workflow. */
export interface LogLine {
  readonly at: number;
  readonly text: string;
}

/**
 * A workflow's `log()` lines in call order: by their key, the decimal id of the task that wrote
 * each, compared as numbers (task 10 comes after task 9).
 */
export const workflowLog = (workflow: WorkflowRecord): ReadonlyArray<LogLine> =>
  Object.entries(workflow.log)
    .toSorted(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([, line]) => ({ at: line.at, text: line.text }));
