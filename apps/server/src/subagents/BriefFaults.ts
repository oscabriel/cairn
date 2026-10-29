// Fault points for the brief kill judge (`judges/brief-go.sh`, ADR 0030): a judge brain kills
// itself at one window of a brief's Go, so the judge can show that whatever the brain dies in, a
// brief yields one worktree, one child conversation and one first input. Production, dev and the
// conformance suite never plant one; the hooks default to doing nothing.
//
// The windows, in the order a Go passes them:
// - `go-commit`: inside the answering commit, after the record is accepted and the start task is
//   created, before the commit lands (nothing of it may survive).
// - `start`: at the top of the start task's phase, after the Go commit landed and before anything
//   else; five kills here in a row park the task (the parked case).
// - `prepared`: after the child's workspace was made and before the commit that creates the child.
// - `created`: after the creating commit, before the brief's reporter submits the first input.
// - `submitted`: after the reporter submitted the brief's first input to the child.

import { Context, Function, Schema } from "effect";

/** The windows of a brief's Go, in order. */
export const BriefFaultPoint = Schema.Literals([
  "go-commit",
  "start",
  "prepared",
  "created",
  "submitted",
]);

export type BriefFaultPoint = typeof BriefFaultPoint.Type;

/**
 * A hook that runs when a window opens; a judge brain kills itself there. Synchronous, since it
 * runs inside pi-durable's commit callbacks and task phases, outside Effect.
 */
export interface BriefFaultHooks {
  readonly at: (point: BriefFaultPoint) => void;
}

/** No fault: what everything but the judge runs with. */
export const NO_BRIEF_FAULTS: BriefFaultHooks = { at: Function.constVoid };

/**
 * The brief faults a brain plants; none unless a judge brain provides some. Read once when the
 * harness and the subagents extension are built.
 */
export const BriefFaults = Context.Reference<BriefFaultHooks>(
  "cairn/server/subagents/BriefFaults",
  { defaultValue: () => NO_BRIEF_FAULTS }
);
