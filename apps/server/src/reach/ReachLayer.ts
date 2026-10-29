// The reach services as one layer (integration, wave 3): artifacts (3E) and portals (3F), the
// lister `reach.list` reads, and the portal tools the `cairn.reach` extension installs. The porch
// and the systemd units are the composition root's choice, so no test, judge or dev brain can
// reach the user's porch or the production `cairn-portal-*` units by default:
//
// - `main.ts`: `PorchClient.layer`, `PortalUnits.layer`, `portalSettingsLayer(process.env)`.
// - `judge-main.ts` and `dev-main.ts`: a fake porch in a temp folder, their own unit prefix and
//   ports (`judgePortalSettings`), real units under that prefix.
// - tests: `ReachMachine.layerTest` (fake porch, fake units), or `ReachServices.layerTest` when no
//   database is at hand.

import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Git } from "../git/Git.ts";
import { ArtifactPublisher } from "./ArtifactPublisher.ts";
import { Artifacts } from "./Artifacts.ts";
import { PorchClient } from "./PorchClient.ts";
import { Portals, PortalSettings } from "./Portals.ts";
import { PortalTools } from "./PortalTools.ts";
import { PortalUnits } from "./PortalUnits.ts";
import { ReachLister } from "./ReachLister.ts";

/** The porch and units a root gives the reach services. */
export const ReachMachine = {
  /**
   * A fake porch serving `plans.example.test` from a temp folder and in-memory units, removed
   * with the layer's scope. For tests and roots that must not touch the machine.
   */
  layerTest: Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "cairn-reach-test-",
      });

      return Layer.merge(
        PorchClient.layerFake({ domain: "example.test", artifacts: root }),
        PortalUnits.layerFake
      );
    })
  ).pipe(Layer.provide(NodeServices.layer), Layer.orDie),

  /**
   * A fake porch in a temp folder with the real units, for judge and dev brains: portals run as
   * units under the root's own `PortalSettings` prefix, which its reconcile and sweep keep to.
   */
  layerFakePorch: Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "cairn-reach-porch-",
      });

      return Layer.merge(
        PorchClient.layerFake({ domain: "example.test", artifacts: root }),
        PortalUnits.layer
      );
    })
  ).pipe(Layer.provide(NodeServices.layer), Layer.orDie),
};

/**
 * Portal settings for a judge or dev brain: units named `<prefix><id>` and ports 38100 to 38199
 * (`offset` 0) or above, clear of production's `cairn-portal-` and 3100 to 3699. Only `PATH`,
 * which the root reads from its environment, is passed to a unit.
 */
export const judgePortalSettings = (
  prefix: string,
  offset: number,
  unitPath: string
) =>
  Layer.succeed(PortalSettings, {
    unitPrefix: prefix,
    firstPort: 38_100 + offset,
    lastPort: 38_199 + offset,
    openingGrace: Duration.minutes(3),
    sweepEvery: Duration.minutes(1),
    probeEvery: Duration.millis(250),
    env: { PATH: unitPath },
  });

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
 * The reach services over `ReachMachine.layerTest`, a fresh migrated in-memory `cairn.sqlite` and a
 * temp data folder: for tests that build the extension set without a database of their own.
 */
export const ReachServicesTest = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "cairn-reach-data-",
    });

    return ReachServices.pipe(
      Layer.provide(ReachMachine.layerTest),
      Layer.provide(Database.layerTest(migrations)),
      Layer.provide(
        ServerConfig.layerWith({ dataDir: path.join(root, "data") })
      )
    );
  })
).pipe(Layer.provide(NodeServices.layer), Layer.orDie);
