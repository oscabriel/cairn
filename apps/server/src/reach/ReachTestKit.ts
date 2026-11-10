// The reach services for tests and the judge and dev brains (moved out of `ReachLayer.ts` and
// `Artifacts.ts`, so the deployed brain, which loads those, loads no fake; ADR 0053): a fake porch
// in a temp folder with fake or real units, the portal settings a judge or dev brain runs its
// units under, and the reach services or artifacts over a fresh migrated in-memory `cairn.sqlite`.
// Nothing outside the temp folders is touched, and no root reaches the user's porch or the
// production `cairn-portal-*` units through this file.

import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ArtifactPublisher } from "./ArtifactPublisher.ts";
import { Artifacts } from "./Artifacts.ts";
import { FakePorchLayer } from "./FakePorch.ts";
import { FakePortalUnitsLayer } from "./FakePortalUnits.ts";
import { PortalSettings } from "./Portals.ts";
import { PortalUnits } from "./PortalUnits.ts";
import { ReachServices } from "./ReachLayer.ts";

/** The fake porch, and fake or real units, a test, judge or dev root gives the reach services. */
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
        FakePorchLayer({ domain: "example.test", artifacts: root }),
        FakePortalUnitsLayer
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
        FakePorchLayer({ domain: "example.test", artifacts: root }),
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
 * The reach services over `ReachMachine.layerTest`, a fresh migrated in-memory `cairn.sqlite` and a
 * temp data folder: for tests that build the extension set without a database of their own. The
 * fake porch is given out too, since the `cairn.reach` tools ask it whether porch is set up.
 */
export const ReachServicesTest = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "cairn-reach-data-",
    });

    return ReachServices.pipe(
      Layer.provideMerge(ReachMachine.layerTest),
      Layer.provide(Database.layerTest(migrations)),
      Layer.provide(
        ServerConfig.layerWith({ dataDir: path.join(root, "data") })
      )
    );
  })
).pipe(Layer.provide(NodeServices.layer), Layer.orDie);

/**
 * `Artifacts` for tests and judge brains that build the extension set: a fake porch serving
 * `plans.example.test` from a temp folder, a fresh migrated in-memory `cairn.sqlite`, and a temp
 * data folder, all removed with the layer's scope.
 */
export const ArtifactsTest = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "cairn-artifacts-test-",
    });

    const artifacts = path.join(root, "artifacts");
    yield* fs.makeDirectory(artifacts);

    return Artifacts.layer.pipe(
      Layer.provide(ArtifactPublisher.layer),
      Layer.provide(FakePorchLayer({ domain: "example.test", artifacts })),
      Layer.provide(Database.layerTest(migrations)),
      Layer.provide(
        ServerConfig.layerWith({ dataDir: path.join(root, "data") })
      )
    );
  })
).pipe(Layer.provide(NodeServices.layer), Layer.orDie);
