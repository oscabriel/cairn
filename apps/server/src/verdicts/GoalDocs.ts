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

import { GOAL_DOCUMENT } from "@cairn/protocol/Policy";
import type { CriterionState, JudgeRef } from "@cairn/protocol/Policy";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import { Match } from "effect";

/** A judge as a document holds it: the protocol's `JudgeRef` as plain JSON. */
export type JudgeRefState =
  | {
      [key: string]: JsonValue;
      kind: "command";
      argv: Array<string>;
      expectExit: number;
      timeoutSec: number;
    }
  | { [key: string]: JsonValue; kind: "user" }
  | { [key: string]: JsonValue; kind: "model"; spec: string; rubric: string }
  | { [key: string]: JsonValue; kind: "verification"; recipe: string };

/** A verdict's evidence; null where the judge has none of that kind. */
export interface EvidenceState {
  [key: string]: JsonValue;
  exit: number | null;
  tail: string | null;
  sha: string | null;
  model: string | null;
  note: string | null;
}

/** A judge run's recorded result: the protocol's `Verdict` as plain JSON. */
export interface VerdictState {
  [key: string]: JsonValue;
  at: number;
  ok: boolean;
  judge: JudgeRefState;
  evidence: EvidenceState;
  runId: string;
}

/** One criterion: the protocol's `Criterion` as plain JSON. */
export interface CriterionStateDoc {
  [key: string]: JsonValue;
  id: string;
  text: string;
  judge: JudgeRefState;
  state: CriterionState;
  verdict: VerdictState | null;
  tries: number;
  changedAt: number;
}

/** `cairn.goal` state: the protocol's `GoalDocument` as plain JSON. */
export interface GoalState {
  [key: string]: JsonValue;
  objective: string;
  criteria: Array<CriterionStateDoc>;
  /** Reserved for hands-off goals; phase 2 never writes it. */
  envelope: { [key: string]: JsonValue } | null;
  closedAt: number | null;
  closedBy: { [key: string]: JsonValue } | null;
}

/** A goal with no objective and no criteria: a thread that is not a goal. */
export const NO_GOAL = (): GoalState => ({
  objective: "",
  criteria: [],
  envelope: null,
  closedAt: null,
  closedBy: null,
});

/** `cairn.goal`: a goal thread's objective and criteria (ADR 0026). */
export const GoalDoc = defineDoc<GoalState>({
  kind: GOAL_DOCUMENT,
  version: 1,
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

/** A judge as a document holds it, copied from the protocol's value. */
export const judgeState = (judge: JudgeRef): JudgeRefState =>
  Match.value(judge).pipe(
    Match.discriminatorsExhaustive("kind")({
      command: (found): JudgeRefState => ({
        kind: "command",
        argv: [...found.argv],
        expectExit: found.expectExit,
        timeoutSec: found.timeoutSec,
      }),
      user: (): JudgeRefState => ({ kind: "user" }),
      model: (found): JudgeRefState => ({
        kind: "model",
        spec: found.spec,
        rubric: found.rubric,
      }),
      verification: (found): JudgeRefState => ({
        kind: "verification",
        recipe: found.recipe,
      }),
    })
  );
