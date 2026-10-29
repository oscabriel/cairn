// The boot repairs, in the order they run after the Harness opens and before the brain is marked
// ready. A package hands off a `bootRepair(...)` entry and it is listed here: sweep unfinished
// attachment uploads; `ExecutorSweep` declines unfinished `apr_` ids; cancel approval records a
// stop left pending (the abort mark committed, the cancel not); `retryTask()` for tasks whose
// approval is still pending; remove child workspaces whose spawn never landed; resume interrupted
// launches from `thread_launches`; repair checkpoint refs; reconcile spend; reconcile portal rows,
// units and porches, then start the portal sweep; then start the durable event reactors, last, so they run after every repair and before
// resume and ready. Orphaned `claude` processes are only logged, by the bridge's boot lines
// (`BridgeProvider.ts`), not repaired here.

import { Effect } from "effect";

import { sweepAttachmentUploads } from "./attachments/AttachmentStore.ts";
import type { AttachmentStore } from "./attachments/AttachmentStore.ts";
import { retryParkedApprovalWaits } from "./Boot.ts";
import { cancelAbandonedApprovalsAtBoot } from "./brain/CairnDocs.ts";
import { repairChildWorkspacesAtBoot } from "./brain/ChildWorkspaceRepair.ts";
import { startEventReactors } from "./brain/EventReactors.ts";
import type { EventReactors } from "./brain/EventReactors.ts";
import type { HarnessSeam } from "./brain/HarnessSeam.ts";
import { sweepUnfinishedExecutorRequests } from "./executor/ExecutorSweep.ts";
import type { ExecutorSweep } from "./executor/ExecutorSweep.ts";
import { CheckpointCapture } from "./git/CheckpointCapture.ts";
import type { Portals } from "./reach/Portals.ts";
import { portalReconcile, startPortalSweep } from "./reach/ReachRepair.ts";
import { ThreadLaunch } from "./threads/ThreadLaunch.ts";
import { reconcileSpendAtBoot } from "./usage/SpendLedger.ts";
import type { SpendLedger } from "./usage/SpendLedger.ts";
import type { ChildWorkspaces } from "./workspaces/ChildWorkspaces.ts";

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
    | ChildWorkspaces
    | EventReactors
    | ExecutorSweep
    | HarnessSeam
    | Portals
    | SpendLedger
    | ThreadLaunch
  >
> = [
  sweepAttachmentUploads,
  bootRepair("executor-sweep", sweepUnfinishedExecutorRequests),
  bootRepair("cancel abandoned approvals", cancelAbandonedApprovalsAtBoot),
  retryParkedApprovalWaits,
  bootRepair("child workspace repair", repairChildWorkspacesAtBoot),
  bootRepair(
    "resume interrupted launches",
    ThreadLaunch.use((launcher) => launcher.resumePending)
  ),
  bootRepair(
    "checkpoint repair",
    CheckpointCapture.use((capture) => capture.repair)
  ),
  bootRepair("spend reconcile", reconcileSpendAtBoot),
  portalReconcile,
  startPortalSweep,
  startEventReactors,
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
