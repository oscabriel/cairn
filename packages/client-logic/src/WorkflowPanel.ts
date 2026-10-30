// What the work panel's workflow section says beyond its phases and nodes (plan wave 6, 6F;
// surfaces note S7; workflows note "Stopping" and "The steps panel's data"): which workflows and
// nodes offer Stop, one line of detail per node, and what a run spent against its budget. Pure, so
// the panel draws only what this decides and its tests judge the words.
//
// - Stop on the whole workflow is offered while it may still run nodes: approved (Go given, the
//   script not yet started) or running. Stop on a node is offered while its workflow runs and the
//   node is live (queued, running, held or unknown); the script reads a stopped node as `null`.
// - A node's detail is its role, the model it resolved to, and what it used or why it ended.
// - Spent is the meter's tokens against the token budget, and dollars at API list price only where
//   every spent token is priced: an unknown is never a zero (ADR 0036).

import type { WorkflowRecord } from "@cairn/protocol/Workflows";
import { Option } from "effect";

import { dollarsText, tokensShort, tokensText } from "./Meters.ts";
import type { StepsNode, WorkflowGroup } from "./WorkflowSteps.ts";
import { isLiveNodeStatus, workflowTotals } from "./WorkflowSteps.ts";

/** Whether Stop on the whole workflow is offered: Go given and not yet ended. */
export const isStoppableWorkflow = (workflow: WorkflowRecord): boolean =>
  workflow.state === "approved" || workflow.state === "running";

/** Whether Stop on one node is offered: its workflow runs and the node is still live. */
export const isStoppableNode = (
  member: StepsNode,
  workflow: WorkflowRecord
): boolean => workflow.state === "running" && isLiveNodeStatus(member.status);

const REFUSAL_WORDS: Readonly<
  Record<NonNullable<StepsNode["node"]["refusal"]>, string>
> = {
  budget_spent: "refused: the budget is spent",
  outside_grant: "refused: outside what Go covered",
  node_cap: "refused: past the node cap",
  no_provider: "refused: no model for its role",
};

/** Why a node ended or what it gave, when there is something to say. */
const outcomeOf = (member: StepsNode): Option.Option<string> => {
  const { node } = member;

  if (node.refusal !== null) {
    return Option.some(REFUSAL_WORDS[node.refusal]);
  }

  if (node.error !== null && member.status === "failed") {
    return Option.some(node.error);
  }

  return Option.fromNullOr(node.resultSummary);
};

/**
 * One line of detail under a node: "@scout · faux/scripted · 2.1k tokens · Counted 3 files.", each
 * part only when known.
 */
export const nodeDetailText = (member: StepsNode): string => {
  const { node } = member;

  const model =
    node.provider === null || node.modelId === null
      ? []
      : [`${node.provider}/${node.modelId}`];

  const used =
    node.receipt === null ? [] : [tokensText(node.receipt.totalTokens)];

  return [
    node.role ?? "default role",
    ...model,
    ...used,
    ...Option.toArray(outcomeOf(member)),
  ].join(" · ");
};

/**
 * What a workflow spent, against its budget: "Spent 12.5k of 50k tokens · $0.12 at API list
 * price", "cost unknown" when no spent token has a price, or "Nothing spent yet".
 */
export const spentText = (group: WorkflowGroup): string => {
  const totals = workflowTotals(group);
  const { tokens } = totals.spent;

  if (tokens === 0) {
    return "Nothing spent yet";
  }

  const tokenPart = Option.match(totals.tokenBudget, {
    onNone: () => `Spent ${tokensText(tokens)}`,
    onSome: (line) =>
      `Spent ${tokensShort(tokens)} of ${tokensShort(line.limit)} tokens`,
  });

  const dollars = Option.match(totals.listMicros, {
    onNone: () => "cost unknown",
    onSome: (micros) =>
      totals.spent.unpricedTokens > 0
        ? `${dollarsText(micros)} at API list price, some unpriced`
        : `${dollarsText(micros)} at API list price`,
  });

  return `${tokenPart} · ${dollars}`;
};
