// Judges the wire projection of the dispatch ledger (`cairn.workflows`) the way the steps panel
// meets it: random revisions of a launching thread's ledger (workflows proposed and started, nodes
// dispatched and ended, phases appended, log lines, meters, results and arguments over the wire's
// string limit, whole-view replacements) go through the projector, and a client built on
// @cairn/client-logic's ThreadView applies the frames. After every frame the client must hold the
// projection of the newest revision, every workflow and node in it must still decode, and the
// steps panel read from the client must match the panel read from the brain's own document: the
// cut of a long result or argument changes no status, phase or count.

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import {
  workflowGroupsOf,
  workflowHeadline,
} from "@cairn/client-logic/WorkflowSteps";
import type { WorkflowGroup } from "@cairn/client-logic/WorkflowSteps";
import { ConversationId } from "@cairn/protocol/Ids";
import {
  ThreadOpsItem,
  ThreadSnapshotItem,
  TRUNCATION_MARKER,
} from "@cairn/protocol/Thread";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import type { NodeState, WorkflowState } from "@cairn/protocol/Workflows";
import type { ConversationView as PiConversationView } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import type {
  NodeItemState,
  WorkflowItemState,
  WorkflowsState,
} from "../workflows/WorkflowDocs.ts";
import { piConversationId } from "./PiIds.ts";
import { projectView, wireProjector } from "./ThreadWire.ts";

/** A small deterministic generator (Park and Miller), so a failure reproduces from its seed. */
const random = (seed: number) => {
  let state = seed % 2_147_483_647 || 1;

  return () => {
    state = (state * 48_271) % 2_147_483_647;

    return (state - 1) / 2_147_483_646;
  };
};

/** Longer than the wire's 32 KiB string limit. */
const LONG = "r".repeat(40_000);

const NODE_STATES: ReadonlyArray<NodeState> = [
  "running",
  "held",
  "settled",
  "failed",
  "stopped",
  "refused",
  "stop_unknown",
];

const WORKFLOW_ENDS: ReadonlyArray<WorkflowState> = [
  "finished",
  "failed",
  "stopped",
];

const nodeRow = (
  workflowId: string,
  index: number,
  phase: string | null
): NodeItemState => ({
  id: `n-${String(200 + index)}`,
  workflowId,
  key: null,
  label: `node ${String(index)}`,
  phase,
  index,
  requestId: `wf-${workflowId}-n-${String(200 + index)}`,
  briefId: `launch-${workflowId}`,
  role: "@worker",
  provider: "faux",
  modelId: "scripted",
  effort: null,
  readonly: false,
  arms: "host",
  state: "reserved",
  stage: "reserved",
  childThreadId: null,
  conversationId: null,
  submissionId: null,
  nestedTaskId: 200 + index,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: 1000 + index,
  endedAt: null,
  error: null,
});

const workflowRow = (id: string): WorkflowItemState => ({
  id,
  name: `flow ${id}`,
  description: "A random ledger",
  phases: [{ title: "Declared", detail: null }],
  scriptHash: "hash",
  scriptRef: `script-${id}`,
  args: { files: ["a.ts"] },
  state: "proposed",
  outcome: null,
  approvalId: `launch-${id}`,
  decidedBy: null,
  decidedAt: null,
  sample: null,
  budget: {
    maxListMicros: null,
    maxTokens: 50_000,
    maxTurns: null,
    maxMinutes: null,
    planGuard: null,
    warnAt: 0.8,
  },
  estimate: null,
  codemodeTaskId: null,
  startedAt: null,
  endedAt: null,
  result: null,
  nodes: {},
  log: {},
  spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
  softAt: null,
  spentAt: null,
});

const pick = <A>(items: ReadonlyArray<A>, draw: () => number): A | undefined =>
  items[Math.floor(draw() * items.length)];

/** One random change to the ledger; like pi-durable, never mutates a revision it handed out. */
const change = (
  ledger: WorkflowsState,
  draw: () => number,
  at: number
): WorkflowsState => {
  const next = structuredClone(ledger);
  const rows = Object.values(next.items);
  const row = pick(rows, draw);
  const choice = Math.floor(draw() * 9);

  if (row === undefined || choice === 0) {
    const id = `wf-${String(rows.length + 1)}`;

    next.items[id] = workflowRow(id);

    return next;
  }

  const { nodes, phases, log } = row;
  const node = pick(Object.values(nodes), draw);

  switch (choice) {
    case 1: {
      row.state = row.state === "proposed" ? "approved" : "running";
      row.decidedBy = { kind: "user" };
      row.decidedAt = at;
      row.startedAt ??= at;

      return next;
    }

    case 2: {
      const index = Object.keys(nodes).length;

      const phase = pick(
        [null, ...phases.map((known) => known.title), "Unlisted"],
        draw
      );

      const added = nodeRow(row.id, index, phase ?? null);

      nodes[added.id] = added;

      return next;
    }

    case 3: {
      if (node !== undefined) {
        node.state = pick(NODE_STATES, draw) ?? "running";
        node.stage = "answered";
        node.endedAt = node.state === "running" ? null : at;
      }

      return next;
    }

    case 4: {
      // A result or an argument over the wire's limit: the stream cuts it.
      if (node === undefined) {
        row.args = { brief: LONG };
      } else {
        node.result = draw() < 0.5 ? LONG : { text: LONG };
        node.resultSummary = "a long answer";
      }

      return next;
    }

    case 5: {
      phases.push({ title: `Phase ${String(phases.length)}`, detail: null });

      return next;
    }

    case 6: {
      log[String(300 + Object.keys(log).length)] = {
        at,
        text: `line at ${String(at)}`,
      };
      row.spent = {
        tokens: Math.floor(draw() * 60_000),
        listMicros: 0,
        unpricedTokens: 0,
      };

      return next;
    }

    case 7: {
      row.state = pick(WORKFLOW_ENDS, draw) ?? "finished";
      row.endedAt = at;
      row.outcome = { kind: "complete" };

      return next;
    }

    default: {
      // An overflowed watch delivers `["r", view]`: the same content as all-new objects.
      return next;
    }
  }
};

const BASE_DOCS: PiConversationView["docs"] = {
  "pi.agent": { model: { provider: "faux", modelId: "scripted" } },
  "pi.live": {},
  "pi.inbox": { items: [] },
};

/** The launching thread's view: no ledger until its first workflow is proposed. */
const viewOf = (ledger: WorkflowsState | null): PiConversationView => ({
  conversation: { id: piConversationId(ConversationId.make(1)) },
  entries: [],
  docs:
    ledger === null
      ? BASE_DOCS
      : { ...BASE_DOCS, [WORKFLOWS_DOCUMENT]: ledger },
});

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  assert.isTrue(Result.isSuccess(result), "the projection was refused");

  return Result.getOrThrow(result);
};

/** What the panel shows of a ledger, without the results and arguments the stream may cut. */
const panelOf = (groups: ReadonlyArray<WorkflowGroup>) =>
  groups.map((group) => ({
    id: group.workflow.id,
    state: group.workflow.state,
    headline: workflowHeadline(group),
    phases: group.phases.map((phase) => ({
      title: phase.title,
      state: phase.state,
      settled: phase.settledCount,
      members: phase.members.map((member) => [member.node.id, member.status]),
    })),
    unphased: group.unphasedNodes.map((member) => [
      member.node.id,
      member.status,
    ]),
    log: Object.keys(group.workflow.log),
    spent: group.workflow.spent.tokens,
  }));

const countNodes = (ledger: WorkflowsState) =>
  Object.values(ledger.items).reduce(
    (count, row) => count + Object.keys(row.nodes).length,
    0
  );

describe("ThreadWire with the dispatch ledger", () => {
  it("a client applying the frames converges, and the steps panel reads what the brain wrote", () => {
    let cuts = 0;

    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const draw = random(seed);
      const projector = wireProjector();

      // The thread has no ledger until its first workflow is proposed.
      let ledger: WorkflowsState | null = null;

      let client: ThreadViewState = unwrap(
        applyThreadStreamItem(
          Option.none(),
          ThreadSnapshotItem.make({
            seq: 0,
            view: unwrap(projector.snapshot(viewOf(ledger))),
            entriesOffset: 0,
            hasMoreHistory: false,
          })
        )
      );

      for (let seq = 1; seq <= 150; seq += 1) {
        ledger = change(ledger ?? { items: {} }, draw, 2000 + seq);

        const ops = unwrap(projector.advance(viewOf(ledger)));

        client = unwrap(
          applyThreadStreamItem(
            Option.some(client),
            ThreadOpsItem.make({ seq, ops })
          )
        );

        assert.deepStrictEqual(
          client.view,
          unwrap(projectView(viewOf(ledger))),
          `seed ${String(seed)}, frame ${String(seq)}`
        );

        const wire = client.view.docs[WORKFLOWS_DOCUMENT];

        if (
          JSON.stringify(wire).includes(
            JSON.stringify(TRUNCATION_MARKER).slice(1, -1)
          )
        ) {
          cuts += 1;
        }

        const groups = workflowGroupsOf(wire);

        assert.strictEqual(
          groups.length,
          Object.keys(ledger.items).length,
          `seed ${String(seed)}, frame ${String(seq)}: a workflow did not decode`
        );
        assert.strictEqual(
          groups.reduce(
            (count, group) =>
              count +
              group.unphasedNodes.length +
              group.phases.reduce(
                (sum, phase) => sum + phase.members.length,
                0
              ),
            0
          ),
          countNodes(ledger),
          `seed ${String(seed)}, frame ${String(seq)}: a node did not decode`
        );
        assert.deepStrictEqual(
          panelOf(groups),
          panelOf(workflowGroupsOf(ledger)),
          `seed ${String(seed)}, frame ${String(seq)}`
        );
      }

      // A fresh subscription starts from a snapshot that equals what the client converged on.
      assert.deepStrictEqual(
        unwrap(wireProjector().snapshot(viewOf(ledger))),
        client.view
      );
    }

    // The cut must actually have been exercised.
    assert.isAbove(cuts, 0, "no frame carried a cut string");
  });
});
