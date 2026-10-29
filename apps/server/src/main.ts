// The deployed brain: `node apps/server/src/main.ts` under the `cairn.service` user unit, on
// 127.0.0.1:3774 behind Caddy at `https://code.gneiss.run`. The real identity rules (Tailscale
// LocalAPI, then the CLI) and `cairn.json` settings; JSON log lines to the journal. SIGTERM closes
// the brain in `Shutdown`'s order and exits 130 (`SuccessExitStatus=130` in the unit).

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import {
  AppLayer,
  DatabaseLive,
  ModelHealthLive,
  PiDurableBrain,
  SettingsLive,
} from "./AppLayer.ts";
import { UploadKeyFromFile } from "./attachments/UploadTokens.ts";
import { ServerConfig } from "./Config.ts";
import { ExecutorLink } from "./executor/ExecutorLink.ts";
import { Identity } from "./http/Identity.ts";
import {
  BridgeExtraProviders,
  BridgeProvider,
} from "./models/BridgeProvider.ts";
import { OAuthStore } from "./models/OAuthStore.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { observabilityLayer } from "./Observability.ts";
import { PiHost } from "./pi-host/PiHost.ts";
import { VapidKeyFromFile } from "./push/Vapid.ts";

// Cairn's own OAuth store (Codex sign-in, ADR 0037) over the same `cairn.sqlite`, holding the
// OAuth lock. One reference, given to the models and the app alike, so the memo map builds one
// store and one flock: a second instance would find the lock taken. Only the deployed brain holds
// it; judge and dev brains go without, so they never take the real lock.
const OAuth = OAuthStore.layer.pipe(Layer.provide(DatabaseLive), Layer.orDie);

// The user's API models through pi's model runtime, read-only over `~/.pi/agent`. One reference,
// so the harness, the picker and the title model share one runtime.
const Models = PiModelSource.layer.pipe(
  Layer.provide(BridgeExtraProviders),
  Layer.provide(OAuth),
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.orDie
);

const Harness = PiDurableBrain({ models: Models });

// The one holder of the Executor grant, over the same `cairn.sqlite` the app opens (one layer
// reference, so one connection). A grant that cannot be opened leaves Executor `disabled`; it never
// stops the brain from booting.
const Executor = ExecutorLink.layer.pipe(Layer.provide(DatabaseLive));

// The tools-only pi host (ADR 0039): the allowlisted pi packages the user enabled, loaded once.
const PiTools = PiHost.layer;

const MainLayer = AppLayer.pipe(
  Layer.provide(Harness),
  // The same reference `AppLayer` uses, so the brain's health feed and the login RPCs share one store.
  Layer.provide(ModelHealthLive),
  // The same reference `AppLayer` uses, so the `roles` tool and the settings RPCs share one store.
  Layer.provide(SettingsLive),
  Layer.provide(PiTools),
  Layer.provide(BridgeProvider.layer),
  Layer.provide(Executor),
  Layer.provide(OAuth),
  Layer.provide(VapidKeyFromFile),
  Layer.provide(UploadKeyFromFile),
  Layer.provide(Identity.layer),
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    observabilityLayer("json").pipe(Layer.provide(NodeServices.layer))
  )
);

NodeRuntime.runMain(Layer.launch(MainLayer));
