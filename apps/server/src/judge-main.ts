// A brain for kept judges: `CAIRN_*` settings only (a free port with `CAIRN_PORT=0`, the judge's own
// `CAIRN_DATA_DIR`), the production guard and identity rules over a fixed tailnet table, and JSON
// log lines (also to `CAIRN_EVENTS_LOG` when set) so a judge can read the bound port from the
// `listening` line. The table admits the owner from loopback, so a judge talking to the listener
// directly passes the minute identity re-check; it must send `Host` and `Origin` matching
// `CAIRN_ORIGIN` (default `http://127.0.0.1`) and `X-Cairn-User` equal to `CAIRN_OWNER` (default
// `owner@loopback`), exactly as Caddy would.

import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { JudgeModel } from "../../../judges/fixtures/JudgeModel.ts";
import { JudgeTools } from "../../../judges/fixtures/JudgeTools.ts";
import {
  AppLayer,
  ModelHealthLive,
  PiDurableBrain,
  ReachLive,
  SettingsLive,
  withCatalog,
} from "./AppLayer.ts";
import {
  judgeSubagentCrashes,
  NO_SUBAGENT_FAULTS,
  SubagentCrashes,
  SubagentFaults,
} from "./brain/SubagentFaults.ts";
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
import { judgePortalFaults } from "./reach/Portals.ts";
import { judgePortalSettings, ReachMachine } from "./reach/ReachLayer.ts";

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

// Portals as units of the judge's own (`cairn-judge-portal-<pid>-`, ports 38100 to 38199), which its
// reconcile and sweep keep to, so production portals are never touched; artifacts and portal
// porches go to a fake porch in a temp folder. `CAIRN_JUDGE_FAULT=portal:after-<step>` kills the
// brain once after that step, with its marker in the data folder.
const JudgeReach = Layer.mergeAll(
  ReachMachine.layerFakePorch,
  judgePortalSettings(
    `cairn-judge-portal-${String(process.pid)}-`,
    0,
    process.env.PATH ?? "/usr/bin:/bin"
  ),
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;

      return judgePortalFaults(
        process.env.CAIRN_JUDGE_FAULT ?? "",
        path.join(config.dataDir, "portal-fault-fired")
      );
    })
  ).pipe(Layer.provide(NodeServices.layer))
);

// Subagent crash points for judges/subagent-durability.ts: `CAIRN_JUDGE_FAULT=subagent:<point>` (or
// `subagent:<point>*<times>`) kills the brain at that point of a delivery, counted in a marker in
// the data folder; `CAIRN_JUDGE_SUBAGENT_FAULTS=freshIds` (or `deliverTwice`, `seamOwnIds` or
// `freshQuestionIds`) plants the broken delivery its controls run against. Unset, neither plants anything.
const JudgeSubagents = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const planted = (process.env.CAIRN_JUDGE_SUBAGENT_FAULTS ?? "").split(",");

    return Layer.mergeAll(
      Layer.succeed(
        SubagentCrashes,
        judgeSubagentCrashes(
          process.env.CAIRN_JUDGE_FAULT ?? "",
          path.join(config.dataDir, "subagent-fault-fired")
        )
      ),
      Layer.succeed(SubagentFaults, {
        ...NO_SUBAGENT_FAULTS,
        freshIds: planted.includes("freshIds"),
        seamOwnIds: planted.includes("seamOwnIds"),
        deliverTwice: planted.includes("deliverTwice"),
        freshQuestionIds: planted.includes("freshQuestionIds"),
      })
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
  Layer.provide(ReachLive),
  Layer.provide(JudgeReach),
  Layer.provide(JudgeSubagents),
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
