// The deployed brain: `node apps/server/src/main.ts` under the `cairn.service` user unit, on
// 127.0.0.1:3774 behind Caddy at `https://code.gneiss.run`. The real identity rules (Tailscale
// LocalAPI, then the CLI) and `cairn.json` settings; JSON log lines to the journal. SIGTERM closes
// the brain in `Shutdown`'s order and exits 130 (`SuccessExitStatus=130` in the unit).
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { AppLayer, PiDurableBrain } from "./AppLayer.ts";
import { ServerConfig } from "./Config.ts";
import { Identity } from "./http/Identity.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { observabilityLayer } from "./Observability.ts";

// The user's API models through pi's model runtime, read-only over `~/.pi/agent`. One reference,
// so the harness, the picker and the title model share one runtime.
const Models = PiModelSource.layer.pipe(
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.orDie
);

const Harness = PiDurableBrain({ models: Models });

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
