// A brain for kept judges: `CAIRN_*` settings only (a free port with `CAIRN_PORT=0`, the judge's own
// `CAIRN_DATA_DIR`), the production guard and identity rules over a fixed tailnet table, and JSON
// log lines (also to `CAIRN_EVENTS_LOG` when set) so a judge can read the bound port from the
// `listening` line. The table admits the owner from loopback, so a judge talking to the listener
// directly passes the minute identity re-check; it must send `Host` and `Origin` matching
// `CAIRN_ORIGIN` (default `http://127.0.0.1`) and `X-Cairn-User` equal to `CAIRN_OWNER` (default
// `owner@loopback`), exactly as Caddy would.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { JudgeTools } from "../../../judges/fixtures/JudgeTools.ts";
import { AppLayer, PiDurableBrain } from "./AppLayer.ts";
import { ModelSource } from "./brain/ModelSource.ts";
import { ServerConfig } from "./Config.ts";
import { Identity } from "./http/Identity.ts";
import { Tailscale } from "./http/Tailscale.ts";
import { observabilityLayer } from "./Observability.ts";

/** A tailnet in which loopback is the owner's untagged judge node. */
const JudgeTailnet = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const judgeNode = {
      stableId: "judge",
      loginName: config.owner,
      tags: [],
      nodeName: "judge.loopback",
    };

    return Tailscale.fixed(
      new Map([
        ["127.0.0.1", judgeNode],
        ["::1", judgeNode],
        ["::ffff:127.0.0.1", judgeNode],
      ])
    );
  })
);

// pi-durable over the faux model (until 2A), with the judge tools installed through the seam.
const Harness = PiDurableBrain({
  models: ModelSource.layerFaux({ tokensPerSecond: 200, settings: {} }),
  extraExtensions: [JudgeTools],
});

const JudgeLayer = AppLayer.pipe(
  Layer.provide(Harness),
  Layer.provide(Identity.layerNoDeps),
  Layer.provide(JudgeTailnet),
  Layer.provide(ServerConfig.layerLocal),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    observabilityLayer("json").pipe(Layer.provide(NodeServices.layer))
  )
);

NodeRuntime.runMain(Layer.launch(JudgeLayer));
