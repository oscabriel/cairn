// The gate's choice of row when two calls of one tool round launch the same script (L-2): the n-th
// call takes the n-th approved row of its run, whichever call reaches the gate first, and a row an
// earlier call of the round already began keeps its place. The end-to-end case, both calls in one
// message on the real Harness, is WorkflowLaunchFlow.test.ts's.

import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import { WorkflowLaunch } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import type {
  WorkflowItemState,
  WorkflowsState,
} from "../brain/WorkflowsDoc.ts";
import { proposedRecord } from "./WorkflowDocs.ts";
import { approvedRowFor } from "./WorkflowGate.ts";
import type { GateView } from "./WorkflowGate.ts";

const HASH = "sha256-abc";

/** The run both launches were proposed in, by its first entry. */
const RUN = 40;

const row = (
  workflowId: string,
  state: WorkflowItemState["state"],
  codemodeTaskId: number | null
): WorkflowItemState => ({
  ...proposedRecord({
    launch: WorkflowLaunch.make({
      type: "workflow",
      workflowId,
      name: "kit-flow",
      description: "A kit workflow",
      phases: [{ title: "Fan", detail: null }],
      scriptHash: HASH,
      scriptRef: `script-${workflowId}`,
      args: { question: workflowId },
      callSites: [],
      nodes: { count: 1, unbounded: false },
      estimate: null,
      envelope: {
        scriptHash: HASH,
        maxNodes: 1,
        maxConcurrent: 1,
        models: [
          { spec: ModelSpec.make("faux/kit"), readonly: false, arms: "host" },
        ],
        modes: [],
        writes: [],
        budget: DEFAULT_BUDGET,
      },
    }),
    approvalId: `launch-${workflowId}`,
    sample: Option.none(),
  }),
  state,
  codemodeTaskId,
});

/** Two launches of one script in one run, W1 proposed first; `earlier` as the call sees it. */
const view = (
  rows: ReadonlyArray<WorkflowItemState>,
  earlier: ReadonlyArray<number>
): GateView => {
  const ledger: WorkflowsState = {
    items: Object.fromEntries(rows.map((each) => [each.id, each])),
  };

  return {
    ledger,
    runs: {
      items: Object.fromEntries(rows.map((each) => [each.id, { run: RUN }])),
    },
    run: Option.some(RUN),
    earlier: new Set(earlier),
  };
};

const idOf = (found: Option.Option<WorkflowItemState>) =>
  Option.getOrUndefined(Option.map(found, (each) => each.id));

describe("the gate's row for each call of a round", () => {
  it("before either call began its row, the first call takes W1 and the second W2", () => {
    const both = view(
      [row("wf-1", "approved", null), row("wf-2", "approved", null)],
      []
    );

    assert.strictEqual(idOf(approvedRowFor(both, HASH, 0)), "wf-1");
    assert.strictEqual(idOf(approvedRowFor(both, HASH, 1)), "wf-2");
  });

  it("the second call, after the first (task 7) began W1, takes W2", () => {
    const after = view(
      [row("wf-1", "running", 7), row("wf-2", "approved", null)],
      [7]
    );

    assert.strictEqual(idOf(approvedRowFor(after, HASH, 1)), "wf-2");
  });

  it("the first call, after the second (task 8) began W2, takes W1", () => {
    const after = view(
      [row("wf-1", "approved", null), row("wf-2", "running", 8)],
      []
    );

    assert.strictEqual(idOf(approvedRowFor(after, HASH, 0)), "wf-1");
  });

  it("a third call of the script, with two launches approved, runs nothing", () => {
    const three = view(
      [row("wf-1", "running", 7), row("wf-2", "running", 8)],
      [7, 8]
    );

    assert.isTrue(Option.isNone(approvedRowFor(three, HASH, 2)));
  });

  it("a row an earlier round ran is not counted: the next call of the run takes W2", () => {
    const later = view(
      [row("wf-1", "finished", 5), row("wf-2", "approved", null)],
      []
    );

    assert.strictEqual(idOf(approvedRowFor(later, HASH, 0)), "wf-2");
  });
});
