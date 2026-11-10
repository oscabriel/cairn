// The models feature's manifest (ADR 0053): the models a thread runs on, their health and their
// sign-ins, and the Claude bridge's place in the brain. Everything it registers with the brain and
// the app is listed here, and `Features.ts` lists this manifest.
//
// `BridgeCwd.layer` is the reference the app gives the bridge stop hook, so the memo map builds
// one. `ModelHealth` and `SettingsStore`, which the health feed and the `models` tool read, are the
// root's (`ModelHealthLive`, `SettingsLive`), as is the `BridgeProvider` the plan's windows come
// from.

import { Layer } from "effect";

import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import { BridgeCwd } from "./BridgeCwdExtension.ts";
import { bridgeClosingHook } from "./BridgeProvider.ts";
import { CodexLogin } from "./CodexLogin.ts";
import { LoginHandlers } from "./LoginHandlers.ts";
import { ModelCheckHandlers } from "./ModelCheckHandlers.ts";
import { ModelHandlers } from "./ModelHandlers.ts";
import { ModelHealthFeed } from "./ModelHealthExtension.ts";
import { ModelsTool } from "./ModelsExtension.ts";
import { ModelSpecs } from "./ModelSpecs.ts";
import { ResultTool } from "./ResultTool.ts";

/** What the models feature registers. */
export const ModelsFeature = {
  name: "models",
  extensionSources: [
    BridgeCwd.useSync((bridgeCwd) => bridgeCwd.extension),
    ModelHealthFeed.useSync((feed) => feed.extension),
    ModelsTool.useSync((models) => models.extension),
    ResultTool.useSync((results) => results.extension),
  ],
  extensionLayer: Layer.mergeAll(
    BridgeCwd.layer,
    ModelHealthFeed.layer,
    ModelsTool.layerAt(ExtensionOrder.models).pipe(
      Layer.provide(ModelSpecs.layerNoDeps)
    ),
    ResultTool.layer
  ),
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [],
  closeHooks: [bridgeClosingHook],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: Layer.mergeAll(
    ModelHandlers,
    ModelCheckHandlers.pipe(Layer.provide(ModelSpecs.layerNoDeps)),
    LoginHandlers.pipe(Layer.provide(CodexLogin.layer))
  ),
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
