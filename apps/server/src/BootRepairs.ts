// The boot repairs, in the order they run after the Harness opens and before the brain is marked
// ready. A package hands off a `bootRepair(...)` entry and it is listed here: sweep unfinished
// attachment uploads; `ExecutorSweep` declines unfinished `apr_` ids; `retryTask()` for tasks whose
// approval is still pending; resume interrupted launches from `thread_launches`; repair checkpoint
// refs. Orphaned `claude` processes are only logged, by the bridge's boot lines
// (`BridgeProvider.ts`), not repaired here.

import { Effect } from "effect";

import { sweepAttachmentUploads } from "./attachments/AttachmentStore.ts";
import type { AttachmentStore } from "./attachments/AttachmentStore.ts";
import { retryParkedApprovalWaits } from "./Boot.ts";
import type { HarnessSeam } from "./brain/HarnessSeam.ts";
import { sweepUnfinishedExecutorRequests } from "./executor/ExecutorSweep.ts";
import type { ExecutorSweep } from "./executor/ExecutorSweep.ts";
import { CheckpointCapture } from "./git/CheckpointCapture.ts";
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
  BootRepair<
    | AttachmentStore
    | CheckpointCapture
    | ExecutorSweep
    | HarnessSeam
    | ThreadLaunch
  >
> = [
  sweepAttachmentUploads,
  bootRepair("executor-sweep", sweepUnfinishedExecutorRequests),
  retryParkedApprovalWaits,
  bootRepair(
    "resume interrupted launches",
    ThreadLaunch.use((launcher) => launcher.resumePending)
  ),
  bootRepair(
    "checkpoint repair",
    CheckpointCapture.use((capture) => capture.repair)
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
