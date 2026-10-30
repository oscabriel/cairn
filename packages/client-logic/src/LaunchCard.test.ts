import type { WorkflowEstimate, WorkflowLaunch } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  argsText,
  callSiteRows,
  coversText,
  estimateCostText,
  estimateText,
  launchNumbers,
  nodesText,
} from "./LaunchCard.ts";

const estimate = (fields: Partial<WorkflowEstimate>): WorkflowEstimate => ({
  nodes: 5,
  tokensLow: 800_000,
  tokensHigh: 1_200_000,
  listMicrosLow: 400_000,
  listMicrosHigh: 900_000,
  basis: "5 nodes; @scout: from its last 9 nodes.",
  ...fields,
});

const launch: WorkflowLaunch = {
  type: "workflow",
  workflowId: "wf-1",
  name: "review-fan",
  description: "Four readers and one judge.",
  phases: [
    { title: "Read", detail: null },
    { title: "Judge", detail: null },
  ],
  scriptHash: "abc",
  scriptRef: "entry-1",
  args: { paths: ["src"] },
  callSites: [
    {
      spec: RoleSpec.make("@scout"),
      label: "Read a file",
      phase: "Read",
      schemaName: null,
      readonly: true,
      arms: "host",
      maxCount: 4,
    },
    {
      spec: RoleSpec.make("@judge"),
      label: "",
      phase: null,
      schemaName: "Verdict",
      readonly: false,
      arms: "host",
      maxCount: null,
    },
  ],
  nodes: { count: 5, unbounded: false },
  estimate: null,
  envelope: {
    scriptHash: "abc",
    maxNodes: 5,
    maxConcurrent: 2,
    roles: [
      { spec: RoleSpec.make("@scout"), readonly: true, arms: "host" },
      { spec: RoleSpec.make("@judge"), readonly: false, arms: "host" },
    ],
    modes: [],
    writes: [],
    budget: { ...DEFAULT_BUDGET, maxListMicros: Micros.make(2_000_000) },
  },
  roleOverrides: {},
};

describe("the launch card's numbers", () => {
  it("counts nodes, saying at least when the dry run reached its cap", () => {
    assert.strictEqual(nodesText({ count: 5, unbounded: false }), "5");
    assert.strictEqual(
      nodesText({ count: 12, unbounded: true }),
      "At least 12"
    );
  });

  it("never reads an unknown cost as zero", () => {
    assert.strictEqual(
      estimateText(Option.none()),
      "No estimate yet: cost unknown"
    );
    // An estimate with no tokens in it is no estimate.
    assert.strictEqual(
      estimateText(
        Option.some(
          estimate({
            tokensLow: 0,
            tokensHigh: 0,
            listMicrosLow: 0,
            listMicrosHigh: 0,
          })
        )
      ),
      "No estimate yet: cost unknown"
    );
    // A model with no list price: tokens known, dollars unknown.
    assert.strictEqual(
      estimateText(
        Option.some(estimate({ listMicrosLow: null, listMicrosHigh: null }))
      ),
      "Cost unknown (a model it runs on has no list price); about 800k to 1.2M tokens"
    );

    for (const text of [
      estimateText(Option.none()),
      estimateCostText(Option.none()),
      estimateCostText(
        Option.some(estimate({ tokensHigh: 0, listMicrosHigh: 0 }))
      ),
    ]) {
      assert.notInclude(text, "$0.00");
    }
  });

  it("gives a priced estimate as a range at API list price", () => {
    assert.strictEqual(
      estimateText(Option.some(estimate({}))),
      "$0.40 to $0.90 at API list price; about 800k to 1.2M tokens"
    );
    assert.strictEqual(
      estimateText(
        Option.some(
          estimate({
            tokensLow: 50_000,
            tokensHigh: 50_000,
            listMicrosLow: 120_000,
            listMicrosHigh: 120_000,
          })
        )
      ),
      "$0.12 at API list price; about 50k tokens"
    );
  });

  it("puts the numbers first: nodes, estimate, budget, what Go covers, roles, phases", () => {
    assert.deepStrictEqual(launchNumbers(launch), [
      ["Nodes", "5"],
      ["Estimate", "No estimate yet: cost unknown"],
      ["Budget", "$2.00 at API list price"],
      ["Go covers", "Up to 5 nodes, 2 at once"],
      ["Roles", "@scout, reads only; @judge, may write"],
      ["Phases", "Read, Judge"],
    ]);
    assert.strictEqual(
      coversText({ ...launch.envelope, maxNodes: 1, maxConcurrent: 1 }),
      "Up to 1 node, 1 at once"
    );
  });
});

describe("the launch card's roles and arguments", () => {
  it("draws each call site with its phase, role, access and count", () => {
    assert.deepStrictEqual(callSiteRows(launch), [
      {
        label: "Read a file",
        spec: "@scout",
        detail: "Read · @scout · reads only · up to 4",
      },
      {
        label: "Node",
        spec: "@judge",
        detail: "@judge · writes · depends on the data",
      },
    ]);
  });

  it("folds the arguments as JSON, and none when there are none", () => {
    assert.deepStrictEqual(
      argsText(launch.args),
      Option.some('{\n  "paths": [\n    "src"\n  ]\n}')
    );
    assert.isTrue(Option.isNone(argsText({})));
    assert.isTrue(Option.isNone(argsText(null)));
  });
});
