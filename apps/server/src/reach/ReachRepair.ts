// The portals' boot repair and close hook (ADR 0038, docs/phase-2/notes/reach.md R5), listed by
// `BootRepairs.ts` and `ShutdownHooks.ts`:
//
// - `portal reconcile`, after the Harness opens and before ready: rows, units and porches made to
//   agree (`Portals.reconcile`). A brain killed mid-open leaves at most a row `opening`, a porch and
//   a unit; the rerun of its tool finishes the portal, or this ends it. Before the user installs
//   porch (`ops/wizards/phase-2.sh 2`), the reconcile records the reach state `porch: not set up`,
//   logged once at info, and succeeds: a missing porch is a state, not a boot failure
//   (`ReachStatus.ts`). Any other failure is logged as `boot_repair_failed` and boot goes on.
// - `start portal sweep`, after the reconcile: every minute, lifetimes, exited units and archived
//   threads (`Portals.sweep`). A sweep that meets a porch not set up records the same state.
// - `stop portal sweep`, at SIGTERM: the sweep stops so nothing writes while the store closes. The
//   units keep running, so every open portal answers through the restart.

import { Effect } from "effect";

import type { BootRepair } from "../BootRepair.ts";
import { bootRepair } from "../BootRepair.ts";
import { shutdownHook } from "../Shutdown.ts";
import { Portals } from "./Portals.ts";

/** The boot repair that reconciles portal rows, units and porches. A failure is logged and boot goes on. */
export const portalReconcile = bootRepair(
  "portal reconcile",
  Portals.use((portals) => portals.reconcile).pipe(Effect.asVoid)
);

/** The boot repair that starts the portal sweep; listed after `portalReconcile`. */
export const startPortalSweep: BootRepair<Portals> = {
  name: "start portal sweep",
  repair: Portals.use((portals) => portals.startSweeper),
};

/** The close hook that stops the portal sweep, leaving every portal's unit running. */
export const stopPortalSweep = shutdownHook(
  "stop portal sweep",
  Portals.use((portals) => portals.stopSweeper)
);
