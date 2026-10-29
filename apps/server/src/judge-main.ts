// A brain for kept judges: `CAIRN_*` settings only (a free port with `CAIRN_PORT=0`, the judge's own
// `CAIRN_DATA_DIR`), the production guard and identity rules over a fixed tailnet table, and JSON
// log lines (also to `CAIRN_EVENTS_LOG` when set) so a judge can read the bound port from the
// `listening` line. The table admits the owner from loopback, so a judge talking to the listener
// directly passes the minute identity re-check; it must send `Host` and `Origin` matching
// `CAIRN_ORIGIN` (default `http://127.0.0.1`) and `X-Cairn-User` equal to `CAIRN_OWNER` (default
// `owner@loopback`), exactly as Caddy would.

import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { JudgeModel } from "../../../judges/fixtures/JudgeModel.ts";
import { JudgeTools } from "../../../judges/fixtures/JudgeTools.ts";
import {
  AppLayer,
  ModelHealthLive,
  PiDurableBrain,
  SettingsLive,
  withCatalog,
} from "./AppLayer.ts";
import { ServerConfig } from "./Config.ts";
import { ExecutorLink } from "./executor/ExecutorLink.ts";
import { Identity } from "./http/Identity.ts";
import { Tailscale } from "./http/Tailscale.ts";
import {
  BridgeExtraProviders,
  BridgeProvider,
} from "./models/BridgeProvider.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { observabilityLayer } from "./Observability.ts";
import { PiHost } from "./pi-host/PiHost.ts";

// `--models real` runs pi's model runtime with the bridge (the bridge windows of judges/durability.ts); the default is
// the judge's faux model.
const { values } = parseArgs({
  options: { models: { type: "string", default: "judge" } },
});

const real = values.models === "real";

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

// pi-durable over the scripted faux model (JudgeModel: a judge drives tool calls and long replies
// from the message text), with the judge tools installed through the seam.
const Harness = real
  ? PiDurableBrain({
      models: PiModelSource.layer.pipe(
        Layer.provide(BridgeExtraProviders),
        Layer.provide(ServerConfig.layerLocal),
        Layer.provide(NodeServices.layer),
        Layer.orDie
      ),
      extraExtensions: [JudgeTools],
    })
  : PiDurableBrain({
      models: withCatalog(JudgeModel.layer(200)),
      extraExtensions: [JudgeTools],
    });

const JudgeLayer = AppLayer.pipe(
  Layer.provide(Harness),
  Layer.provide(ModelHealthLive),
  Layer.provide(SettingsLive),
  Layer.provide(PiHost.layerEmpty),
  Layer.provide(real ? BridgeProvider.layer : BridgeProvider.layerOff),
  Layer.provide(ExecutorLink.layerFake),
  Layer.provide(Identity.layerNoDeps),
  Layer.provide(JudgeTailnet),
  Layer.provide(ServerConfig.layerLocal),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    observabilityLayer("json").pipe(Layer.provide(NodeServices.layer))
  )
);

NodeRuntime.runMain(Layer.launch(JudgeLayer));
