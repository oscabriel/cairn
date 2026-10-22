// The deployed brain: `node apps/server/src/main.ts` under the `cairn.service` user unit, on
// 127.0.0.1:3774 behind Caddy at `https://code.gneiss.run`. The real identity rules (Tailscale
// LocalAPI, then the CLI) and `cairn.json` settings; JSON log lines to the journal. SIGTERM closes
// the brain in `Shutdown`'s order and exits 130 (`SuccessExitStatus=130` in the unit).
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { AppLayer, PiDurableBrain } from "./AppLayer.ts";
import { ModelSource } from "./brain/ModelSource.ts";
import { ServerConfig } from "./Config.ts";
import { Identity } from "./http/Identity.ts";
import { observabilityLayer } from "./Observability.ts";

// The faux model until 2A's PiModelSource-backed layer replaces it.
const Harness = PiDurableBrain({
  models: ModelSource.layerFaux({ tokensPerSecond: 200, settings: {} }),
});

const MainLayer = AppLayer.pipe(
  Layer.provide(Harness),
  Layer.provide(Identity.layer),
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    observabilityLayer("json").pipe(Layer.provide(NodeServices.layer))
  )
);

NodeRuntime.runMain(Layer.launch(MainLayer));
