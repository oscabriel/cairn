// The reach feature's manifest (ADR 0053): artifacts and portals on the user's porch (ADR 0038 as
// amended), shelved behind the fence that installs the `cairn.reach` tools only when porch is set
// up. Everything it registers with the brain and the app is listed here, and `Features.ts` lists
// this manifest.
//
// The reach services the tools and handlers read (`ReachLive`) and the porch are the root's.

import { Layer } from "effect";

import { placed, RepairOrder } from "../BootRepair.ts";
import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import { PortalHandlers } from "./PortalHandlers.ts";
import { ReachTools } from "./ReachExtension.ts";
import { ReachHandlers } from "./ReachHandlers.ts";
import {
  portalReconcile,
  startPortalSweep,
  stopPortalSweep,
} from "./ReachRepair.ts";

/** What the reach feature registers. */
export const ReachFeature = {
  name: "reach",
  extensionSources: [ReachTools.useSync((reach) => reach.extension)],
  extensionLayer: ReachTools.layerAt(ExtensionOrder.reach),
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [
    placed(RepairOrder.portalReconcile, portalReconcile),
    placed(RepairOrder.portalSweep, startPortalSweep),
  ],
  closeHooks: [stopPortalSweep],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: Layer.mergeAll(PortalHandlers, ReachHandlers),
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
