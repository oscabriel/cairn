// The reach services as one layer (integration, wave 3): artifacts (3E) and portals (3F), the
// lister `reach.list` reads, and the portal tools the `cairn.reach` extension installs. The porch
// and the systemd units are the composition root's choice, so no test, judge or dev brain can
// reach the user's porch or the production `cairn-portal-*` units by default:
//
// - `main.ts`: `PorchClient.layer`, `PortalUnits.layer`, `portalSettingsLayer(process.env)`.
// - `judge-main.ts`, `dev-main.ts`, tests: `ReachTestKit.ts` (a fake porch with real or fake
//   units, the judges' portal settings, the reach services over a fresh database).

import { Layer } from "effect";

import { DatabaseLive } from "../db/DatabaseLive.ts";
import { Git } from "../git/Git.ts";
import { ArtifactPublisher } from "./ArtifactPublisher.ts";
import { Artifacts } from "./Artifacts.ts";
import { Portals } from "./Portals.ts";
import { PortalTools } from "./PortalTools.ts";
import { ReachLister } from "./ReachLister.ts";

/**
 * The reach services: `Artifacts`, `Portals`, `PortalTools` and `ReachLister`. Needs `PorchClient`,
 * `PortalUnits`, `SqlClient` and `ServerConfig` from the root.
 */
export const ReachServices = Layer.mergeAll(
  PortalTools.layerNoDeps,
  ReachLister.layerNoDeps
).pipe(
  Layer.provideMerge(Portals.layerNoDeps),
  Layer.provideMerge(Artifacts.layer),
  Layer.provide(ArtifactPublisher.layer),
  Layer.provide(Git.layer)
);

/**
 * The brain's reach services over `DatabaseLive`: the reference the reach RPCs, the portal boot
 * repairs and close hook, and the `cairn.reach` tools are all given, so the memo map builds one
 * portal store. The porch (`PorchClient`) and the units (`PortalUnits`), with `PortalSettings`,
 * are the entry point's.
 */
export const ReachLive = ReachServices.pipe(Layer.provide(DatabaseLive));
