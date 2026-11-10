// The boot repairs, in the order they run after the Harness opens and before the brain is marked
// ready: every feature's (`Features.ts`) and the brain's own, each placed by its `RepairOrder` key
// (`BootRepair.ts`). In key order: sweep unfinished attachment uploads; `ExecutorSweep` declines
// unfinished `apr_` ids; make subagent rows, then title the ones made before children were titled;
// reconcile spend, then load the budget book and halt the scopes past their line (4E); cancel
// approval records a stop left pending (the abort mark committed, the cancel not); expire records
// nothing waits on that lapsed (criteria, a budget raise); end the tasks crashes cut off too often
// (`CrashLimit.ts`, ADR 0046), keeping the waits every feature's manifest names (`KEPT_WAITS`): a
// tool call that holds a record (approval waits among them), a workflow's script call,
// `subagent_status`, and the subagent and workflow wait tasks; remove child workspaces whose spawn
// never landed; remove scratch folders whose thread is gone (a thread's row is committed before its
// folder is claimed); resume interrupted launches from `thread_launches`; repair checkpoint refs;
// reconcile portal rows, units and porches, then start the portal sweep; then start the durable
// event reactors, last, so they run after every repair and before resume and ready. Orphaned
// `claude` processes are only logged, by the bridge's boot lines (`BridgeProvider.ts`), not
// repaired here. The two approval sweeps and the reconcile's `inspect()` share one scan of every
// conversation's `cairn.approvals` (`PendingApprovals`): the first sweep makes it, and each later
// reader reads only the conversations that hold a pending record.
//
// The ordering rule: pi-durable schedules nothing until the Harness resumes, or until something
// submits to it or waits on it, so a repair that needs a quiet Harness (one that reads or removes
// what a running task would write, as the child workspace repair does) comes before the first
// repair that can start scheduling. That is `resume interrupted launches`, whose launch fibers
// submit first messages; every repair before it only reads, commits or marks (`abortTask` marks,
// it does not schedule), and boot resumes the Harness after the last one (`Boot.ts`). A new
// repair takes a key that keeps the rule; `Features.test.ts` holds the order.

import { Effect } from "effect";

import { bootRepair, placed, RepairOrder } from "./BootRepair.ts";
import type { PlacedRepair } from "./BootRepair.ts";
import { endCrashLoopedTasks } from "./brain/CrashLimit.ts";
import type { KeptWaits } from "./brain/CrashLimit.ts";
import { startEventReactors } from "./brain/EventReactors.ts";
import type { CairnFeature, Registered } from "./brain/Feature.ts";
import { FEATURES } from "./Features.ts";
import type { Feature } from "./Features.ts";
import { CheckpointCapture } from "./git/CheckpointCapture.ts";
import { repairScratchFoldersAtBoot } from "./projects/ScratchProject.ts";
import { ThreadLaunch } from "./threads/ThreadLaunch.ts";

/**
 * The waits the crash accounting keeps however often crashes cut them off (ADR 0046), from every
 * feature's manifest. Task kinds: they wait on other work, a clock or a person and start nothing
 * outside, or (a subagent's start) must make their child once (ADR 0030). Tools: their calls wait
 * on their children with no record of their own. A tool call that holds a record, and a
 * workflow's script call, are kept by what they hold (`CrashLimit.ts`).
 */
export const keptWaitsOf = (
  features: ReadonlyArray<CairnFeature>
): KeptWaits => ({
  kinds: new Set(features.flatMap((feature) => feature.keptWaits.kinds)),
  tools: new Set(features.flatMap((feature) => feature.keptWaits.tools)),
});

/** The waits the crash limit keeps, from every feature. */
export const KEPT_WAITS: KeptWaits = keptWaitsOf(FEATURES);

/** The brain's own repairs, with the crash limit keeping `keptWaits`. */
const brainRepairs = (keptWaits: KeptWaits) => [
  placed(
    RepairOrder.crashLimit,
    bootRepair("crash limit", endCrashLoopedTasks(keptWaits))
  ),
  placed(
    RepairOrder.scratchFolders,
    bootRepair("scratch folder repair", repairScratchFoldersAtBoot)
  ),
  placed(
    RepairOrder.resumeLaunches,
    bootRepair(
      "resume interrupted launches",
      ThreadLaunch.use((launcher) => launcher.resumePending)
    )
  ),
  placed(
    RepairOrder.checkpoints,
    bootRepair(
      "checkpoint repair",
      CheckpointCapture.use((capture) => capture.repair)
    )
  ),
  placed(RepairOrder.eventReactors, startEventReactors),
];

/** What the repairs read, across the brain's own and every feature's. */
type RepairServices =
  | (ReturnType<typeof brainRepairs>[number] extends PlacedRepair<infer R>
      ? R
      : never)
  | (Registered<Feature, "bootRepairs"> extends PlacedRepair<infer R>
      ? R
      : never);

/** Every boot repair of the brain and `features`, in key order. */
export const bootRepairsOf = (
  features: ReadonlyArray<Feature>
): ReadonlyArray<PlacedRepair<RepairServices>> =>
  [
    ...brainRepairs(keptWaitsOf(features)),
    ...features.flatMap(
      (feature): ReadonlyArray<Registered<Feature, "bootRepairs">> =>
        feature.bootRepairs
    ),
  ].toSorted((a, b) => a.at - b.at);

/** Every boot repair, in order. */
export const bootRepairs = bootRepairsOf(FEATURES);

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
