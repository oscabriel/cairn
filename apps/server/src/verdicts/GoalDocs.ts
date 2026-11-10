// A goal's documents inside pi-durable's store (ADR 0026, briefs note section 3), as plain JSON
// (S23). A goal is a thread with criteria; with the user's 2026-10-29 decision the project thread is
// the natural goal thread, so any top-level thread may carry one, and a project thread that lives on
// carries one goal at a time, its criteria replaced as the work moves on.
//
// - `cairn.goal` (conversation, visible) is the goal: the user's objective and the criteria, each
//   bound to the outside judge that decides it. Its shape is the protocol's `GoalDocument`
//   (packages/protocol/src/Policy.ts). Only the verdict writer (`Verdicts.ts`) opens it for writing,
//   which `Verdicts.test.ts` holds over the server's source.
// - `cairn.judge-runs` (conversation, brain only) indexes the judge runs `goal_check` queued, by the
//   tool task that asked, so a rerun of the tool finds its run instead of queueing a second, and a
//   criterion with a run still going is not queued twice.
//
// Both start empty in a fork, which is another thread.

import { GOAL_DOCUMENT, JudgeRef } from "@cairn/protocol/Policy";
import type { Criterion, GoalDocument, Verdict } from "@cairn/protocol/Policy";
import type { DocumentState } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { migrateGoal } from "../brain/RolesRetired.ts";
import { plainCopy } from "../subagents/SubagentDocs.ts";

/** A judge as a document holds it: the protocol's `JudgeRef`. */
export type JudgeRefState = DocumentState<typeof JudgeRef>;

/** A judge run's recorded result: the protocol's `Verdict`. */
export type VerdictState = DocumentState<typeof Verdict>;

/** A verdict's evidence; null where the judge has none of that kind. */
export type EvidenceState = VerdictState["evidence"];

/** One criterion: the protocol's `Criterion`. */
export type CriterionStateDoc = DocumentState<typeof Criterion>;

/** `cairn.goal` state: the protocol's `GoalDocument`. */
export type GoalState = DocumentState<typeof GoalDocument>;

/** A goal with no objective and no criteria: a thread that is not a goal. */
export const NO_GOAL = (): GoalState => ({
  objective: "",
  criteria: [],
  envelope: null,
  closedAt: null,
  closedBy: null,
});

/**
 * `cairn.goal`: a goal thread's objective and criteria (ADR 0026). Version 2 retired the role names
 * its judges held (ADR 0052).
 */
export const GoalDoc = defineDoc<GoalState>({
  kind: GOAL_DOCUMENT,
  version: 2,
  migrate: migrateGoal,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, with no goal of its own until the user gives it one.
  fork: "initial",
  initial: NO_GOAL,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** One judge run `goal_check` queued. */
export interface JudgeRunItemState {
  [key: string]: JsonValue;
  /** The `cairn.judge-run` task. */
  taskId: number;
  criterionId: string;
  /**
   * The criterion's `changedAt` when queued: a run judges the criterion as it stood then, so a
   * later criterion that reuses the id is not this run's. Absent on items queued before it was kept.
   */
  changedAt?: number;
  queuedAt: number;
  /** Set by the run's completing commit; a run with none is still going. */
  settledAt: number | null;
}

/** `cairn.judge-runs` state: the runs `goal_check` queued, by the asking tool task's id. */
export interface JudgeRunsState {
  [key: string]: JsonValue;
  items: { [toolTaskId: string]: JudgeRunItemState };
}

/** The document kind of the judge-run index; brain only, never on the wire. */
export const JUDGE_RUNS_DOCUMENT = "cairn.judge-runs";

/** `cairn.judge-runs`: the index `goal_check` keeps so a criterion is queued once per ask. */
export const JudgeRunsDoc = defineDoc<JudgeRunsState>({
  kind: JUDGE_RUNS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

const encodeJudge = Schema.encodeSync(JudgeRef);

/** A judge as a document holds it: the protocol's value, encoded by its schema (ADR 0052). */
export const judgeState = (judge: JudgeRef): JudgeRefState =>
  plainCopy(encodeJudge(judge));
