// A development brain, started by `tools/dev.ts`: a free loopback port unless `CAIRN_PORT` names
// one, `CAIRN_*` settings only (never the deployed brain's `cairn.json`), and the loopback-owner
// identity, so the page Vite serves needs no Caddy and no copied header. `CAIRN_ORIGIN` must be the
// Vite origin (the guard checks Origin and Host against it). Pretty log lines.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { AppLayer } from "./AppLayer.ts";
import { ServerConfig } from "./Config.ts";
import { Identity } from "./http/Identity.ts";
import { observabilityLayer } from "./Observability.ts";

const DevLayer = AppLayer.pipe(
  Layer.provide(Identity.layerLoopbackOwner),
  Layer.provide(ServerConfig.layerLocal),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    observabilityLayer("pretty").pipe(Layer.provide(NodeServices.layer))
  )
);

NodeRuntime.runMain(Layer.launch(DevLayer));
