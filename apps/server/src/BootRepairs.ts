// The boot repairs, in the order they run after the Harness opens and before the brain is marked
// ready. A package hands off a `bootRepair(...)` entry and it is listed here: sweep unfinished
// attachment uploads; `ExecutorSweep` declines unfinished `apr_` ids; make subagent rows, then title
// the ones made before children were titled; reconcile spend, then load the budget book and halt
// the scopes past their line (4E); cancel approval records a stop left pending (the abort mark
// committed, the cancel not); expire records nothing waits on that lapsed (criteria, a budget
// raise); end the tasks crashes cut off too often (`CrashLimit.ts`, ADR 0046), keeping the waits:
// a tool call that holds a record (approval waits among them), a workflow's script call,
// `subagent_status`, and the subagent and workflow wait tasks; remove child workspaces whose spawn
// never landed;
// remove scratch folders whose thread is gone (a thread's row is committed before its folder is
// claimed); resume interrupted launches from `thread_launches`; repair checkpoint refs; reconcile
// portal rows, units and porches, then start the portal sweep; then start the durable event
// reactors, last, so they run after every repair and before resume and ready. Orphaned `claude`
// processes are only logged, by the bridge's boot lines (`BridgeProvider.ts`), not repaired here.
//
// The ordering rule: pi-durable schedules nothing until the Harness resumes, or until something
// submits to it or waits on it, so a repair that needs a quiet Harness (one that reads or removes
// what a running task would write, as the child workspace repair does) comes before the first
// repair that can start scheduling. That is `resume interrupted launches`, whose launch fibers
// submit first messages; every repair before it only reads, commits or marks (`abortTask` marks,
// it does not schedule), and boot resumes the Harness after the last one (`Boot.ts`).

import { Effect } from "effect";

import { sweepAttachmentUploads } from "./attachments/AttachmentStore.ts";
import type { AttachmentStore } from "./attachments/AttachmentStore.ts";
import {
  cancelAbandonedApprovalsAtBoot,
  expireLapsedApprovalsAtBoot,
} from "./brain/CairnDocs.ts";
import { repairChildWorkspacesAtBoot } from "./brain/ChildWorkspaceRepair.ts";
import { endCrashLoopedTasks } from "./brain/CrashLimit.ts";
import type { KeptWaits } from "./brain/CrashLimit.ts";
import { startEventReactors } from "./brain/EventReactors.ts";
import type { EventReactors } from "./brain/EventReactors.ts";
import type { HarnessSeam } from "./brain/HarnessSeam.ts";
import { sweepUnfinishedExecutorRequests } from "./executor/ExecutorSweep.ts";
import type { ExecutorSweep } from "./executor/ExecutorSweep.ts";
import { CheckpointCapture } from "./git/CheckpointCapture.ts";
import { repairScratchFoldersAtBoot } from "./projects/ScratchProject.ts";
import type { ScratchProject } from "./projects/ScratchProject.ts";
import type { Portals } from "./reach/Portals.ts";
import { portalReconcile, startPortalSweep } from "./reach/ReachRepair.ts";
import type { CommandReceipts } from "./shell/CommandReceipts.ts";
import type { EventSink } from "./shell/EventSink.ts";
import type { ThreadRows } from "./shell/ThreadRows.ts";
import {
  repairSubagentRows,
  retitleSubagentRows,
} from "./subagents/SubagentRows.ts";
import { SUBAGENT_WAIT_TASKS } from "./subagents/SubagentTasks.ts";
import { SUBAGENT_STATUS_TOOL } from "./subagents/SubagentTools.ts";
import { ThreadLaunch } from "./threads/ThreadLaunch.ts";
import type { ThreadTitles } from "./threads/ThreadTitles.ts";
import { budgetBootRepair } from "./usage/BudgetGuard.ts";
import type { BudgetGuard } from "./usage/BudgetGuard.ts";
import { reconcileSpendAtBoot } from "./usage/SpendLedger.ts";
import type { SpendLedger } from "./usage/SpendLedger.ts";
import { STOPPER_TASK } from "./workflows/WorkflowBudget.ts";
import { LAUNCH_WATCH_TASK } from "./workflows/WorkflowLaunch.ts";
import {
  AGENT_TOOL,
  VERIFY_TOOL,
  WATCH_TASK,
} from "./workflows/WorkflowTools.ts";
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

/**
 * The waits the crash accounting keeps however often crashes cut them off (ADR 0046). Task kinds:
 * they wait on other work, a clock or a person and start nothing outside, or (a subagent's start)
 * must make their child once (ADR 0030); the workflow watcher waits on a node's or a script call's
 * task, the launch watcher on the run that proposed an approved launch, and the budget stopper
 * looks until no node runs. Tools: `subagent_status` waits on its
 * children with no record of its own, and a workflow's `agent` and `verify` calls wait on their
 * child, before their reserve writes a record while they are queued for a node slot. A tool call
 * that holds a record, and a workflow's script call, are kept by what they hold (`CrashLimit.ts`).
 */
export const KEPT_WAITS: KeptWaits = {
  kinds: new Set([
    ...SUBAGENT_WAIT_TASKS,
    WATCH_TASK,
    STOPPER_TASK,
    LAUNCH_WATCH_TASK,
  ]),
  tools: new Set([SUBAGENT_STATUS_TOOL, AGENT_TOOL, VERIFY_TOOL]),
};

/** Every boot repair, in order. */
export const bootRepairs: ReadonlyArray<
  BootRepair<
    | AttachmentStore
    | BudgetGuard
    | CheckpointCapture
    | ChildWorkspaces
    | CommandReceipts
    | EventReactors
    | EventSink
    | ExecutorSweep
    | HarnessSeam
    | Portals
    | ScratchProject
    | SpendLedger
    | ThreadLaunch
    | ThreadRows
    | ThreadTitles
  >
> = [
  sweepAttachmentUploads,
  bootRepair("executor-sweep", sweepUnfinishedExecutorRequests),
  bootRepair("subagent rows", repairSubagentRows),
  bootRepair("subagent titles", retitleSubagentRows),
  bootRepair("spend reconcile", reconcileSpendAtBoot),
  bootRepair("budget boot repair", budgetBootRepair),
  bootRepair("cancel abandoned approvals", cancelAbandonedApprovalsAtBoot),
  bootRepair("expire lapsed approvals", expireLapsedApprovalsAtBoot),
  bootRepair("crash limit", endCrashLoopedTasks(KEPT_WAITS)),
  bootRepair("child workspace repair", repairChildWorkspacesAtBoot),
  bootRepair("scratch folder repair", repairScratchFoldersAtBoot),
  bootRepair(
    "resume interrupted launches",
    ThreadLaunch.use((launcher) => launcher.resumePending)
  ),
  bootRepair(
    "checkpoint repair",
    CheckpointCapture.use((capture) => capture.repair)
  ),
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
