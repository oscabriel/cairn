import { assert, describe, it } from "@effect/vitest";
import { Predicate } from "effect";
import type { Schema } from "effect";

import {
  isStoppableNode,
  isStoppableWorkflow,
  nodeDetailText,
  spentText,
} from "./WorkflowPanel.ts";
import { workflowGroupsOf } from "./WorkflowSteps.ts";
import type { StepsNode, WorkflowGroup } from "./WorkflowSteps.ts";

interface Json {
  [key: string]: Schema.Json;
}

const node = (id: string, overrides: Json = {}): Json => ({
  id,
  workflowId: "wf-1",
  key: null,
  label: id,
  phase: "Read",
  index: 0,
  requestId: `wf-wf-1-${id}`,
  briefId: "launch-1",
  role: "@scout",
  provider: "faux",
  modelId: "scripted",
  effort: null,
  readonly: true,
  arms: "host",
  state: "running",
  stage: "submitted",
  childThreadId: null,
  conversationId: null,
  submissionId: null,
  nestedTaskId: 9,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: 1,
  endedAt: null,
  error: null,
  ...overrides,
});

const receipt = (totalTokens: number): Json => ({
  answerEntry: null,
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  listMicros: null,
  toolCalls: 0,
  durationMs: 10,
});

const groupOf = (
  nodes: ReadonlyArray<Json>,
  overrides: Json = {}
): WorkflowGroup => {
  const [group] = workflowGroupsOf({
    items: {
      "wf-1": {
        id: "wf-1",
        name: "review-fan",
        description: "",
        phases: [{ title: "Read", detail: null }],
        scriptHash: "h",
        scriptRef: "r",
        args: {},
        state: "running",
        outcome: null,
        approvalId: "launch-1",
        decidedBy: { kind: "user" },
        decidedAt: 1,
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
        codemodeTaskId: 3,
        startedAt: 1,
        endedAt: null,
        result: null,
        nodes: Object.fromEntries(
          nodes.map((each, index): [string, Json] => [
            Predicate.isString(each.id) ? each.id : String(index),
            each,
          ])
        ),
        log: {},
        spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
        softAt: null,
        spentAt: null,
        ...overrides,
      },
    },
  });

  assert.isDefined(group);

  return group;
};

const memberOf = (group: WorkflowGroup, id: string): StepsNode => {
  const found = group.phases
    .flatMap((phase) => phase.members)
    .find((member) => member.node.id === id);

  assert.isDefined(found, id);

  return found;
};

describe("what the work panel offers to stop", () => {
  it("offers Stop on a workflow from Go until it ends", () => {
    for (const [state, offered] of [
      ["proposed", false],
      ["approved", true],
      ["running", true],
      ["finished", false],
      ["stopped", false],
      ["declined", false],
    ] as const) {
      assert.strictEqual(
        isStoppableWorkflow(groupOf([], { state }).workflow),
        offered,
        state
      );
    }
  });

  it("offers Stop on a live node of a running workflow only", () => {
    const group = groupOf([
      node("n-run"),
      node("n-queued", { state: "reserved", stage: "reserved" }),
      node("n-done", { state: "settled", endedAt: 2 }),
      node("n-stopped", { state: "stopped", endedAt: 2 }),
    ]);

    assert.isTrue(isStoppableNode(memberOf(group, "n-run"), group.workflow));
    assert.isTrue(isStoppableNode(memberOf(group, "n-queued"), group.workflow));
    assert.isFalse(isStoppableNode(memberOf(group, "n-done"), group.workflow));
    assert.isFalse(
      isStoppableNode(memberOf(group, "n-stopped"), group.workflow)
    );

    // An ended workflow's live node reads stopped, and offers nothing.
    const ended = groupOf([node("n-run")], { state: "stopped", endedAt: 3 });

    assert.isFalse(isStoppableNode(memberOf(ended, "n-run"), ended.workflow));
  });
});

describe("what the work panel says of a node and a run", () => {
  it("gives a node's role, model, use and outcome", () => {
    const group = groupOf([
      node("n-done", {
        state: "settled",
        endedAt: 2,
        receipt: receipt(2100),
        resultSummary: "Counted 3 files.",
      }),
      node("n-refused", {
        state: "refused",
        provider: null,
        modelId: null,
        refusal: "budget_spent",
        endedAt: 2,
      }),
      node("n-failed", {
        state: "failed",
        error: "The bridge did not answer.",
      }),
      node("n-default", { role: null }),
    ]);

    assert.strictEqual(
      nodeDetailText(memberOf(group, "n-done")),
      "@scout · faux/scripted · 2.1k tokens · Counted 3 files."
    );
    assert.strictEqual(
      nodeDetailText(memberOf(group, "n-refused")),
      "@scout · refused: the budget is spent"
    );
    assert.strictEqual(
      nodeDetailText(memberOf(group, "n-failed")),
      "@scout · faux/scripted · The bridge did not answer."
    );
    assert.strictEqual(
      nodeDetailText(memberOf(group, "n-default")),
      "default role · faux/scripted"
    );
  });

  it("says what a run spent against its budget, never an unknown cost as zero", () => {
    assert.strictEqual(spentText(groupOf([])), "Nothing spent yet");
    assert.strictEqual(
      spentText(
        groupOf([], {
          spent: { tokens: 12_500, listMicros: 0, unpricedTokens: 12_500 },
        })
      ),
      "Spent 12.5k of 50k tokens · cost unknown"
    );
    assert.strictEqual(
      spentText(
        groupOf([], {
          spent: { tokens: 12_500, listMicros: 120_000, unpricedTokens: 0 },
        })
      ),
      "Spent 12.5k of 50k tokens · $0.12 at API list price"
    );
    assert.strictEqual(
      spentText(
        groupOf([], {
          budget: {
            maxListMicros: null,
            maxTokens: null,
            maxTurns: null,
            maxMinutes: null,
            planGuard: null,
            warnAt: 0.8,
          },
          spent: { tokens: 900, listMicros: 30_000, unpricedTokens: 100 },
        })
      ),
      "Spent 900 tokens · $0.03 at API list price, some unpriced"
    );
  });
});
