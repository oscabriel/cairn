// The boot repairs, in the order they run after the Harness opens and before the brain is marked
// ready. This list is a seam: packages hand off a `bootRepair(...)` entry and the integrator adds it
// here. Planned order: log orphan `claude` processes with a dead parent; `ExecutorSweep` declines
// unfinished `apr_` ids; `retryTask()` for tasks whose approval is still pending; resume interrupted
// launches from `thread_launches`.
import { Effect } from "effect";

import { retryParkedApprovalWaits } from "./Boot.ts";
import type { HarnessSeam } from "./brain/HarnessSeam.ts";
import { ThreadLaunch } from "./threads/ThreadLaunch.ts";

/** One repair: a name for the log and the effect. */
export interface BootRepair<R> {
  readonly name: string;
  readonly repair: Effect.Effect<void, never, R>;
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

/** Every boot repair, in order. */
export const bootRepairs: ReadonlyArray<
  BootRepair<HarnessSeam | ThreadLaunch>
> = [
  retryParkedApprovalWaits,
  bootRepair(
    "resume interrupted launches",
    ThreadLaunch.use((launcher) => launcher.resumePending)
  ),
];

/** Runs every repair in order, logging each one by name. */
export const runBootRepairs = Effect.forEach(
  bootRepairs,
  (entry) =>
    entry.repair.pipe(
      Effect.tap(() =>
        Effect.logInfo("boot repair done").pipe(
          Effect.annotateLogs({ event: "boot_repair", repair: entry.name })
        )
      )
    ),
  { discard: true }
);
