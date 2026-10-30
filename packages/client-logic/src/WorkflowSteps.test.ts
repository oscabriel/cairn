// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/subagentRuntime.test.ts
// ("projectedSubagentsToRuntime workflow expansion", "deriveWorkflowGroups over a dynamic workflow",
// and the headline case of "resolveWorkflowOpening") at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: members grouped under their phases with settled counts, a run-time phase, one phase per
// title whichever names it first, unphased members kept with their workflow and prototype names as
// ids, a member's end apart from its duration, unfinished members taking an ended workflow's ending,
// and the headline's tally. Changed: Cairn's ledger rows read from a `cairn.workflows` document, an
// ended workflow ends live nodes `stopped` or `failed`, never `done`. Added: the phase label of
// ThreadLineageWorkflowRow.tsx, refused nodes, lenient decoding, workflow order, totals and the
// log. Not ported: plain subagents, the retry count (the record's `attempt` is shown as is), the
// workflow opening's script detection.
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

import type { NodeState, WorkflowState } from "@cairn/protocol/Workflows";
import { assert, describe, it } from "@effect/vitest";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";

import {
  phaseLabel,
  workflowGroupsOf,
  workflowHeadline,
  workflowLog,
  workflowTotals,
} from "./WorkflowSteps.ts";
import type { WorkflowGroup } from "./WorkflowSteps.ts";

/** A JSON object, as a document holds one. */
interface Json {
  [key: string]: Schema.Json;
}

/** A ledger row: a JSON object keyed by its id. */
interface Row extends Json {
  id: string;
}

/** The id `overrides` set, else `fallback`. */
const idOf = (overrides: Json, fallback: string): string =>
  Predicate.isString(overrides.id) ? overrides.id : fallback;

const START = Date.UTC(2026, 7, 1, 10, 0, 0);

/** A ledger node row as the brain writes it; `overrides` replace fields. */
const node = (index: number, overrides: Json = {}): Row => ({
  workflowId: "wf-1",
  key: null,
  label: `alpha:${String(index)}`,
  phase: "Alpha",
  index,
  requestId: `wf-wf-1-n-${String(100 + index)}`,
  briefId: "launch-wf-1",
  role: "@worker",
  provider: "faux",
  modelId: "kit",
  effort: null,
  readonly: false,
  arms: "host",
  state: "running",
  stage: "submitted",
  childThreadId: null,
  conversationId: null,
  submissionId: null,
  nestedTaskId: 100 + index,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: null,
  endedAt: null,
  error: null,
  ...overrides,
  id: idOf(overrides, `n-${String(100 + index)}`),
});

const receipt = (durationMs: number): Json => ({
  answerEntry: null,
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 71_141,
  listMicros: null,
  toolCalls: 3,
  durationMs,
});

/** A ledger workflow row; `overrides` replace fields. */
const workflow = (nodes: ReadonlyArray<Row>, overrides: Json = {}): Row => ({
  name: "probe-wf",
  description: "Run the alpha workflow",
  phases: [],
  scriptHash: "hash",
  scriptRef: "script-wf-1",
  args: {},
  state: "running",
  outcome: null,
  approvalId: "launch-wf-1",
  decidedBy: { kind: "user" },
  decidedAt: START - 1000,
  sample: null,
  budget: {
    maxListMicros: null,
    maxTokens: null,
    maxTurns: null,
    maxMinutes: null,
    planGuard: null,
    warnAt: 0.8,
  },
  estimate: null,
  codemodeTaskId: 7,
  startedAt: START,
  endedAt: null,
  result: null,
  nodes: Object.fromEntries(nodes.map((row): [string, Row] => [row.id, row])),
  log: {},
  spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
  softAt: null,
  spentAt: null,
  ...overrides,
  id: idOf(overrides, "wf-1"),
});

const phases = (...titles: ReadonlyArray<string>) =>
  titles.map((title) => ({ title, detail: null }));

const documentOf = (...rows: ReadonlyArray<Row>): Schema.Json => ({
  items: Object.fromEntries(rows.map((row): [string, Row] => [row.id, row])),
});

const groupsOf = (...rows: ReadonlyArray<Row>) =>
  workflowGroupsOf(documentOf(...rows));

const only = (groups: ReadonlyArray<WorkflowGroup>): WorkflowGroup => {
  const [group, ...rest] = groups;

  assert.isDefined(group, "no workflow group");
  assert.deepStrictEqual(rest, [], "more than one workflow group");

  return group;
};

const membersOf = (group: WorkflowGroup) => [
  ...group.phases.flatMap((phase) => phase.members),
  ...group.unphasedNodes,
];

describe("workflow nodes as the panel reads them", () => {
  it("reads each node row with its status, phase and order", () => {
    const group = only(
      groupsOf(
        workflow(
          [
            node(1, { state: "reserved", stage: "reserved" }),
            node(0, { startedAt: START }),
          ],
          { phases: phases("Alpha", "Beta") }
        )
      )
    );

    assert.deepStrictEqual(
      membersOf(group).map((member) => [
        member.node.label,
        member.status,
        member.node.phase,
      ]),
      [
        ["alpha:0", "running", "Alpha"],
        ["alpha:1", "queued", "Alpha"],
      ]
    );
    assert.isTrue(Option.isNone(membersOf(group)[1]?.endedAt ?? Option.none()));
  });

  it("uses a settled node's wall-clock end separately from its execution duration", () => {
    const group = only(
      groupsOf(
        workflow([
          node(0, {
            state: "settled",
            stage: "answered",
            startedAt: START,
            endedAt: START + 4432,
            receipt: receipt(1500),
            resultSummary: "A1",
          }),
          node(1, {
            state: "settled",
            stage: "answered",
            startedAt: START,
            receipt: receipt(1500),
          }),
        ])
      )
    );

    assert.deepStrictEqual(
      membersOf(group).map((member) => member.endedAt),
      [Option.some(START + 4432), Option.some(START + 1500)]
    );
    assert.strictEqual(membersOf(group)[0]?.node.receipt?.toolCalls, 3);
  });

  it.each([
    ["stopped", "stopped"],
    ["failed", "failed"],
    ["finished", "stopped"],
  ] satisfies ReadonlyArray<readonly [WorkflowState, string]>)(
    "ends unfinished nodes when the workflow is %s",
    (state, ending) => {
      const group = only(
        groupsOf(
          workflow(
            [
              node(0, { startedAt: START }),
              node(1, { state: "reserved", stage: "reserved" }),
              node(2, {
                state: "settled",
                startedAt: START,
                receipt: receipt(1500),
              }),
            ],
            { state, endedAt: START + 9000 }
          )
        )
      );

      assert.deepStrictEqual(
        membersOf(group).map((member) => [member.status, member.endedAt]),
        [
          [ending, Option.some(START + 9000)],
          [ending, Option.some(START + 9000)],
          ["done", Option.some(START + 1500)],
        ]
      );
      assert.strictEqual(group.phases[0]?.state, "done");
    }
  );

  it("keeps a live node live while its workflow runs, and reads every ledger state", () => {
    const states: ReadonlyArray<readonly [NodeState, string]> = [
      ["reserved", "queued"],
      ["running", "running"],
      ["held", "held"],
      ["start_unknown", "unknown"],
      ["stop_unknown", "unknown"],
      ["settled", "done"],
      ["failed", "failed"],
      ["stopped", "stopped"],
      ["refused", "refused"],
    ];

    const group = only(
      groupsOf(workflow(states.map(([state], index) => node(index, { state }))))
    );

    assert.deepStrictEqual(
      membersOf(group).map((member) => member.status),
      states.map(([, status]) => status)
    );
  });
});

describe("deriveWorkflowGroups over a dynamic workflow", () => {
  it("groups nodes under their phases and counts the run", () => {
    const group = only(
      groupsOf(
        workflow(
          [
            node(1, { state: "settled" }),
            node(2, { state: "failed" }),
            node(3, { phase: "Beta" }),
            node(4, { phase: "Beta", state: "reserved" }),
          ],
          { phases: phases("Alpha", "Beta") }
        )
      )
    );

    assert.deepStrictEqual(
      group.phases.map((phase) => [phase.index, phase.title, phase.state]),
      [
        [0, "Alpha", "done"],
        [1, "Beta", "running"],
      ]
    );
    assert.deepStrictEqual(
      group.phases.map((phase) => phase.settledCount),
      [2, 0]
    );
    assert.strictEqual(membersOf(group).length, 4);
    assert.deepStrictEqual(group.unphasedNodes, []);
  });

  it("keeps a phase running while its only nodes wait: queued, held or unknown", () => {
    const group = only(
      groupsOf(
        workflow(
          [
            node(0, { state: "reserved", phase: "Queued" }),
            node(1, { state: "held", phase: "Held", held: { until: null } }),
            node(2, { state: "start_unknown", phase: "Unknown" }),
          ],
          { phases: phases("Queued", "Held", "Unknown") }
        )
      )
    );

    assert.deepStrictEqual(
      group.phases.map((phase) => [
        phase.title,
        phase.state,
        phase.settledCount,
      ]),
      [
        ["Queued", "running", 0],
        ["Held", "running", 0],
        ["Unknown", "running", 0],
      ]
    );
  });

  it("shows a phase the script only reached at run time", () => {
    const group = only(
      groupsOf(
        workflow([node(1, { state: "settled" }), node(2, { phase: "Gamma" })], {
          phases: phases("Alpha"),
        })
      )
    );

    assert.deepStrictEqual(
      group.phases.map((phase) => phase.title),
      ["Alpha", "Gamma"]
    );
    assert.deepStrictEqual(group.unphasedNodes, []);
  });

  it("shows a declared phase with no nodes as pending, keeping its detail", () => {
    const group = only(
      groupsOf(
        workflow([node(1)], {
          phases: [
            { title: "Alpha", detail: null },
            { title: "Review", detail: "Check each finding" },
          ],
        })
      )
    );

    assert.deepStrictEqual(
      group.phases.map((phase) => [phase.title, phase.state, phase.detail]),
      [
        ["Alpha", "running", Option.none()],
        ["Review", "pending", Option.some("Check each finding")],
      ]
    );
  });

  it.each([false, true])(
    "keeps one phase per title, a node's phase landing first=%s",
    (nodeFirst) => {
      // The prelude does not wait for phase(), so a node may name a phase the ledger lists later.
      const listed = workflow([node(1, { phase: "Review" })], {
        phases: nodeFirst
          ? phases("Alpha")
          : [
              { title: "Alpha", detail: null },
              { title: "Review", detail: "Check" },
            ],
      });

      const group = only(groupsOf(listed));

      assert.deepStrictEqual(
        group.phases.map((phase) => [phase.title, phase.members.length]),
        [
          ["Alpha", 0],
          ["Review", 1],
        ]
      );
    }
  );

  it("orders phases only nodes name by their first node, after the ledger's list", () => {
    const group = only(
      groupsOf(
        workflow(
          [
            node(3, { phase: "Late" }),
            node(1, { phase: "Early" }),
            node(2, { phase: "Late" }),
          ],
          { phases: phases("Declared") }
        )
      )
    );

    assert.deepStrictEqual(
      group.phases.map((phase) => phase.title),
      ["Declared", "Early", "Late"]
    );
    assert.deepStrictEqual(
      group.phases[2]?.members.map((member) => member.node.index),
      [2, 3]
    );
  });

  it("keeps unphased nodes with their workflow, whatever the ids are called", () => {
    const groups = groupsOf(
      workflow([node(1, { id: "__proto__", phase: null })], {
        id: "__proto__",
        startedAt: START,
      }),
      workflow([], { id: "constructor", startedAt: START + 1 })
    );

    assert.deepStrictEqual(
      groups.map((group) => group.workflow.id),
      ["__proto__", "constructor"]
    );
    assert.deepStrictEqual(groups[0]?.phases, []);
    assert.deepStrictEqual(
      groups[0]?.unphasedNodes.map((member) => member.node.label),
      ["alpha:1"]
    );
    assert.deepStrictEqual(groups[1]?.phases, []);
    assert.deepStrictEqual(groups[1]?.unphasedNodes, []);
  });

  it("orders workflows by start, then decision, an undecided one last", () => {
    const groups = groupsOf(
      workflow([], { id: "wf-10", startedAt: START + 5 }),
      workflow([], {
        id: "wf-30",
        state: "proposed",
        startedAt: null,
        decidedAt: null,
        decidedBy: null,
      }),
      workflow([], { id: "wf-9", startedAt: START + 5 }),
      workflow([], {
        id: "wf-20",
        state: "approved",
        startedAt: null,
        decidedAt: START + 1,
      })
    );

    assert.deepStrictEqual(
      groups.map((group) => group.workflow.id),
      ["wf-20", "wf-9", "wf-10", "wf-30"]
    );
  });
});

describe("reading the document", () => {
  it("leaves out a node or workflow that does not decode and keeps the rest", () => {
    const group = only(
      groupsOf(workflow([node(0), node(1, { state: "exploded" })]), {
        id: "wf-2",
        name: "",
      })
    );

    assert.deepStrictEqual(
      membersOf(group).map((member) => member.node.label),
      ["alpha:0"]
    );
  });

  it("reads a node and a workflow whose long strings the stream cut", () => {
    const group = only(
      groupsOf(
        workflow(
          [
            node(0, {
              state: "settled",
              result: "x… output truncated for transport",
              truncated: true,
            }),
          ],
          { args: "y… output truncated for transport", truncated: true }
        )
      )
    );

    assert.strictEqual(membersOf(group)[0]?.status, "done");
  });

  it("reads no workflows from a missing or malformed document", () => {
    const docs: Record<string, Schema.Json> = {};

    assert.deepStrictEqual(workflowGroupsOf(docs["cairn.workflows"]), []);
    assert.deepStrictEqual(workflowGroupsOf([]), []);
    assert.deepStrictEqual(workflowGroupsOf({ items: [] }), []);
    assert.deepStrictEqual(workflowGroupsOf({ items: {} }), []);
  });
});

const labelOf = (rows: ReadonlyArray<Row>) =>
  only(groupsOf(workflow(rows, { phases: phases("Alpha") }))).phases.map(
    phaseLabel
  );

describe(phaseLabel, () => {
  it("names a phase by how its nodes stand", () => {
    assert.deepStrictEqual(labelOf([]), ["not started"]);
    assert.deepStrictEqual(labelOf([node(0, { state: "failed" }), node(1)]), [
      "running",
    ]);
    assert.deepStrictEqual(
      labelOf([node(0, { state: "failed" }), node(1, { state: "stopped" })]),
      ["failed"]
    );
    assert.deepStrictEqual(
      labelOf([node(0, { state: "settled" }), node(1, { state: "refused" })]),
      ["stopped"]
    );
    assert.deepStrictEqual(labelOf([node(0, { state: "settled" })]), ["done"]);
  });
});

describe(workflowHeadline, () => {
  it("heads a workflow with its name, description and node tally", () => {
    const group = only(
      groupsOf(
        workflow(
          [
            node(1),
            node(2, { state: "settled" }),
            node(3, { state: "failed", phase: null }),
          ],
          { phases: phases("Alpha") }
        )
      )
    );

    assert.deepStrictEqual(workflowHeadline(group), {
      title: "probe-wf",
      description: Option.some("Run the alpha workflow"),
      nodes: Option.some("3 nodes · 1 working · 1 done · 1 failed"),
    });
  });

  it("says nothing of nodes before the first, nor a description that repeats the name", () => {
    assert.deepStrictEqual(
      workflowHeadline(
        only(groupsOf(workflow([], { description: "probe-wf" })))
      ),
      { title: "probe-wf", description: Option.none(), nodes: Option.none() }
    );
  });

  it("counts one node, and stopped and refused nodes apart", () => {
    assert.deepStrictEqual(
      workflowHeadline(only(groupsOf(workflow([node(0)])))).nodes,
      Option.some("1 node · 1 working")
    );
    assert.deepStrictEqual(
      workflowHeadline(
        only(
          groupsOf(
            workflow([
              node(0, { state: "stopped" }),
              node(1, { state: "refused" }),
              node(2, { state: "held" }),
            ])
          )
        )
      ).nodes,
      Option.some("3 nodes · 1 working · 1 stopped · 1 refused")
    );
  });
});

const spentOn = (spent: Json) =>
  workflowTotals(only(groupsOf(workflow([], { spent })))).listMicros;

describe(workflowTotals, () => {
  it("counts nodes by status and draws the budget lines", () => {
    const totals = workflowTotals(
      only(
        groupsOf(
          workflow(
            [
              node(0),
              node(1, { state: "settled" }),
              node(2, { state: "settled" }),
            ],
            {
              budget: {
                maxListMicros: 2_000_000,
                maxTokens: 10_000,
                maxTurns: null,
                maxMinutes: null,
                planGuard: null,
                warnAt: 0.75,
              },
              spent: { tokens: 12_000, listMicros: 500_000, unpricedTokens: 0 },
              estimate: {
                nodes: 3,
                tokensLow: 6000,
                tokensHigh: 9000,
                listMicrosLow: null,
                listMicrosHigh: null,
                basis: "from the last 3 @worker nodes",
              },
            }
          )
        )
      )
    );

    assert.strictEqual(totals.nodes.running, 1);
    assert.strictEqual(totals.nodes.done, 2);
    assert.strictEqual(totals.nodes.failed, 0);
    assert.deepStrictEqual(totals.listMicros, Option.some(500_000));
    assert.deepStrictEqual(
      totals.tokenBudget,
      Option.some({ limit: 10_000, soft: 7500, remaining: 0 })
    );
    assert.deepStrictEqual(
      totals.listMicrosBudget,
      Option.some({ limit: 2_000_000, soft: 1_500_000, remaining: 1_500_000 })
    );
    assert.strictEqual(Option.getOrThrow(totals.estimate).tokensHigh, 9000);
  });

  it("never reads unpriced spend as zero dollars", () => {
    assert.deepStrictEqual(
      spentOn({ tokens: 900, listMicros: 0, unpricedTokens: 900 }),
      Option.none()
    );
    assert.deepStrictEqual(
      spentOn({ tokens: 900, listMicros: 40, unpricedTokens: 300 }),
      Option.some(40)
    );
    assert.deepStrictEqual(
      spentOn({ tokens: 0, listMicros: 0, unpricedTokens: 0 }),
      Option.some(0)
    );
  });

  it("draws no budget line for a limit the budget does not set", () => {
    const totals = workflowTotals(only(groupsOf(workflow([]))));

    assert.isTrue(Option.isNone(totals.tokenBudget));
    assert.isTrue(Option.isNone(totals.listMicrosBudget));
    assert.isTrue(Option.isNone(totals.estimate));
  });
});

describe(workflowLog, () => {
  it("lists log lines in call order, task ids compared as numbers", () => {
    const [group] = groupsOf(
      workflow([], {
        log: {
          "10": { at: 3, text: "third" },
          "9": { at: 2, text: "second" },
          "1": { at: 1, text: "first" },
        },
      })
    );

    assert.isDefined(group);
    assert.deepStrictEqual(
      workflowLog(group.workflow).map((line) => line.text),
      ["first", "second", "third"]
    );
  });
});
