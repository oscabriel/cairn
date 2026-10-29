// The portals' boot repair and close hook (ADR 0038, docs/phase-2/notes/reach.md R5), listed by
// `BootRepairs.ts` and `ShutdownHooks.ts`:
//
// - `portal reconcile`, after the Harness opens and before ready: rows, units and porches made to
//   agree (`Portals.reconcile`). A brain killed mid-open leaves at most a row `opening`, a porch and
//   a unit; the rerun of its tool finishes the portal, or this ends it.
// - `start portal sweep`, after the reconcile: every minute, lifetimes, exited units and archived
//   threads (`Portals.sweep`).
// - `stop portal sweep`, at SIGTERM: the sweep stops so nothing writes while the store closes. The
//   units keep running, so every open portal answers through the restart.

import { bootRepair } from "../BootRepairs.ts";
import type { BootRepair } from "../BootRepairs.ts";
import { shutdownHook } from "../Shutdown.ts";
import { Portals } from "./Portals.ts";

/** The boot repair that reconciles portal rows, units and porches. */
export const portalReconcile = bootRepair(
  "portal reconcile",
  Portals.use((portals) => portals.reconcile)
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
