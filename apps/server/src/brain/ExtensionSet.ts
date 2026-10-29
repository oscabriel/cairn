// The extension set the brain installs, in order (integration seam). A later package adds its
// extension by adding its source here at the end of its wave; the order key, not the position in
// this list, decides where it installs.

import { Effect, Layer } from "effect";

import { askUserExtension } from "../approvals/AskUserTool.ts";
import { ProviderRequestLog } from "../attachments/ProviderRequestExtension.ts";
import { ExecutorExtension } from "../executor/ExecutorExtension.ts";
import { ResultTool } from "../models/ResultTool.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { RolesTool } from "../models/RolesExtension.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachTools } from "../reach/ReachExtension.ts";
import { skillExtensionSources } from "../skills/SkillsLayer.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { BridgeCwd } from "./BridgeCwdExtension.ts";
import { CodeMode } from "./CodeMode.ts";
import { CodingTools } from "./CodingTools.ts";
import { ExtensionOrder, Extensions } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";
import { ModelHealthFeed } from "./ModelHealthExtension.ts";

const production: ReadonlyArray<
  Effect.Effect<
    CairnExtension,
    never,
    | CodingTools
    | CodeMode
    | ProviderRequestLog
    | ExecutorExtension
    | BridgeCwd
    | PiHost
    | ModelHealthFeed
    | RolesTool
    | ResultTool
    | ReachTools
    | Subagents
  >
> = [
  CodingTools.useSync((tools) => tools.extension),
  CodeMode.useSync((codemode) => codemode.extension),
  ...skillExtensionSources,
  ExecutorExtension.useSync((executor) => executor.extension),
  Subagents.useSync((subagents) => subagents.extension),
  BridgeCwd.useSync((bridgeCwd) => bridgeCwd.extension),
  PiHost.useSync((host) => host.extension),
  ModelHealthFeed.useSync((feed) => feed.extension),
  RolesTool.useSync((roles) => roles.extension),
  ResultTool.useSync((results) => results.extension),
  ReachTools.useSync((reach) => reach.extension),
  Effect.succeed(askUserExtension(ExtensionOrder.askUser)),
  ProviderRequestLog.useSync((log) => log.extension),
];

// The Executor proxies need an `ExecutorLink` from the composition root: the real one in
// `main.ts` only, the fake in dev and judge brains, the disabled one in tests. `BridgeCwd.layer`
// is the same reference `AppLayer` gives the bridge stop hook, so the memo map builds one. `PiHost`
// is left to the composition root too: `PiHost.layer` (the user's pi packages) in `main.ts`,
// `PiHost.layerEmpty` (the same empty `cairn.pi-tools` extension) everywhere else. So is
// `ModelHealth`, which the health feed records into: `PiDurableBrain` gives it the app's one
// `ModelHealthLive`, and tests a fresh in-memory one (`ModelHealth.layerTest`). The `roles` tool's
// `RoleAliases` leaves `SettingsStore` (and `ModelHealth`) to the root as well: `SettingsLive` in
// the entry points, `SettingsStore.layerTest` in tests. It reads the Claude plan's windows from
// `BridgeProvider`, a reference the deployed root provides. The `cairn.reach` tools read
// `Artifacts` and `PortalTools`, which the root gives too (`ReachLive` in `AppLayer.ts`, the same
// reference its handlers and boot repairs use; `ReachServicesTest` in tests), so one porch client
// and one portal store serve the tools and the RPCs. `Subagents` is the root's as well:
// `Subagents.layer` over the root's `ChildWorkspaces` in the entry points, `Subagents.layerWith`
// with planted faults in a test brain.
const dependencies = Layer.mergeAll(
  CodingTools.layer,
  CodeMode.layer,
  ProviderRequestLog.layer,
  ExecutorExtension.layer,
  BridgeCwd.layer,
  ModelHealthFeed.layer,
  RolesTool.layerAt(ExtensionOrder.roles).pipe(
    Layer.provide(RoleAliases.layerNoDeps)
  ),
  ResultTool.layer,
  ReachTools.layerAt(ExtensionOrder.reach)
);

/** The installed set: production extensions, plus any a composition root adds (judges). */
export const ExtensionSet = {
  layer: Extensions.fromSources(production).pipe(Layer.provide(dependencies)),
  /** The production set plus `extra`, for `judge-main.ts` and tests. */
  withExtra: (extra: ReadonlyArray<CairnExtension>) =>
    Extensions.fromSources([
      ...production,
      ...extra.map((extension) => Effect.succeed(extension)),
    ]).pipe(Layer.provide(dependencies)),
};
