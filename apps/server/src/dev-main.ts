// A development brain, started by `tools/dev.ts`: a free loopback port unless `CAIRN_PORT` names
// one, `CAIRN_*` settings only (never the deployed brain's `cairn.json`), and the loopback-owner
// identity, so the page Vite serves needs no Caddy and no copied header. `CAIRN_ORIGIN` must be the
// Vite origin (the guard checks Origin and Host against it). Pretty log lines. The harness is the
// scripted one with a demo thread (`DevDemo.ts`), or with `--models real` pi-durable over the user's
// API models (pi's model runtime, read-only over `~/.pi/agent`).

import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { AppLayer, PiDurableBrain } from "./AppLayer.ts";
import { ServerConfig } from "./Config.ts";
import { DevDemo } from "./DevDemo.ts";
import { ScriptedBrain } from "./DevLayer.ts";
import { FakeExecutorLink } from "./executor/FakeExecutor.ts";
import { Identity } from "./http/Identity.ts";
import { ModelHealthLive } from "./models/ModelHealth.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { SettingsLive } from "./models/SettingsStore.ts";
import { observabilityLayer } from "./Observability.ts";
import { PiHost } from "./pi-host/PiHost.ts";
import {
  judgePortalSettings,
  ReachLive,
  ReachMachine,
} from "./reach/ReachLayer.ts";

const { values } = parseArgs({
  options: { models: { type: "string", default: "scripted" } },
});

const App =
  values.models === "real"
    ? AppLayer.pipe(
        Layer.provide(
          PiDurableBrain({
            models: PiModelSource.layer.pipe(
              Layer.provide(ServerConfig.layerLocal),
              Layer.provide(NodeServices.layer),
              Layer.orDie
            ),
          })
        )
      )
    : DevDemo.pipe(
        Layer.provideMerge(AppLayer),
        Layer.provideMerge(ScriptedBrain)
      );

const DevLayer = App.pipe(
  Layer.provide(PiHost.layerEmpty),
  Layer.provide(ModelHealthLive),
  Layer.provide(SettingsLive),
  // Portals as `cairn-dev-portal-*` units on ports 38200 to 38299, apart from production's and the
  // judges'; artifacts and portal porches go to a fake porch in a temp folder.
  Layer.provide(ReachLive),
  Layer.provide(ReachMachine.layerFakePorch),
  Layer.provide(
    judgePortalSettings(
      "cairn-dev-portal-",
      100,
      process.env.PATH ?? "/usr/bin:/bin"
    )
  ),
  Layer.provide(FakeExecutorLink),
  Layer.provide(Identity.layerLoopbackOwner),
  Layer.provide(ServerConfig.layerLocal),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    observabilityLayer("pretty").pipe(Layer.provide(NodeServices.layer))
  )
);

NodeRuntime.runMain(Layer.launch(DevLayer));
