// One boot repair and where it runs among the others. A feature lists its repairs in its manifest,
// each placed by a `RepairOrder` key; `BootRepairs.ts` gathers them with the brain's own, runs them
// in key order and states the rule the order follows. Keys never move, and they leave gaps, so a
// new repair takes a key between two others without renumbering them.

import { Effect } from "effect";

/** Where each boot repair runs: in key order, before the Harness resumes (`BootRepairs.ts`). */
export const RepairOrder = {
  /** Clear `.tmp` and sweep stale attachment uploads. */
  attachmentUploads: 100,
  /** Decline unfinished Executor requests (`apr_` ids). */
  executorSweep: 200,
  /** Make the rows of subagents made before their rows existed. */
  subagentRows: 300,
  /** Title the subagent rows made before children were titled. */
  subagentTitles: 310,
  /** Reconcile spend from the store. */
  spendReconcile: 400,
  /** Load the budget book and halt the scopes past their line. */
  budget: 410,
  /** Cancel the approval records a stop left pending. */
  cancelAbandonedApprovals: 500,
  /** Expire the records nothing waits on that lapsed. */
  expireLapsedApprovals: 510,
  /** End the tasks crashes cut off too often, keeping the waits (ADR 0046). */
  crashLimit: 600,
  /** Remove the child workspaces whose spawn never landed; needs a quiet Harness. */
  childWorkspaces: 700,
  /** Remove the scratch folders whose thread is gone. */
  scratchFolders: 800,
  /** Resume interrupted launches: the first repair that can start scheduling. */
  resumeLaunches: 900,
  /** Repair checkpoint refs. */
  checkpoints: 1000,
  /** Reconcile portal rows, units and porches. */
  portalReconcile: 1100,
  /** Start the portal sweep. */
  portalSweep: 1110,
  /** Start the durable event reactors, after every other repair. */
  eventReactors: 1200,
} as const;

/** One repair: a name for the log and the effect. */
export interface BootRepair<R> {
  readonly name: string;
  readonly repair: Effect.Effect<void, never, R>;
}

/** A repair with its `RepairOrder` key. */
export interface PlacedRepair<R> extends BootRepair<R> {
  readonly at: number;
}

/**
 * Builds a boot repair. A failure is logged (`event: boot_repair_failed`) and boot goes on: a
 * repair that cannot run must not keep the brain from serving the threads it can.
 */
export const bootRepair = <E, R>(
  name: string,
  repair: Effect.Effect<void, E, R>
): BootRepair<R> => ({
  name,
  repair: repair.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("boot repair failed").pipe(
        Effect.annotateLogs({
          event: "boot_repair_failed",
          repair: name,
          cause: String(cause),
        })
      )
    )
  ),
});

/** `repair` placed at `at`, a `RepairOrder` key. */
export const placed = <R>(
  at: number,
  repair: BootRepair<R>
): PlacedRepair<R> => ({
  ...repair,
  at,
});
