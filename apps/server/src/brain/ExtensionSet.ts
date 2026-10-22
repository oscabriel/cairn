// The extension set the brain installs, in order (integration seam). A later package adds its
// extension by adding its source here at the end of its wave; the order key, not the position in
// this list, decides where it installs.
import { Effect, Layer } from "effect";

import { ProviderRequestLog } from "../attachments/ProviderRequestExtension.ts";
import { ExecutorExtension } from "../executor/ExecutorExtension.ts";
import { skillExtensionSources } from "../skills/SkillsLayer.ts";
import { BridgeCwd } from "./BridgeCwdExtension.ts";
import { CodeMode } from "./CodeMode.ts";
import { CodingTools } from "./CodingTools.ts";
import { Extensions } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";

const production: ReadonlyArray<
  Effect.Effect<
    CairnExtension,
    never,
    CodingTools | CodeMode | ProviderRequestLog | ExecutorExtension | BridgeCwd
  >
> = [
  CodingTools.useSync((tools) => tools.extension),
  CodeMode.useSync((codemode) => codemode.extension),
  ...skillExtensionSources,
  ExecutorExtension.useSync((executor) => executor.extension),
  BridgeCwd.useSync((bridgeCwd) => bridgeCwd.extension),
  ProviderRequestLog.useSync((log) => log.extension),
];

// The Executor proxies need an `ExecutorLink` from the composition root: the real one in
// `main.ts` only, the fake in dev and judge brains, the disabled one in tests. `BridgeCwd.layer`
// is the same reference `AppLayer` gives the bridge stop hook, so the memo map builds one.
const dependencies = Layer.mergeAll(
  CodingTools.layer,
  CodeMode.layer,
  ProviderRequestLog.layer,
  ExecutorExtension.layer,
  BridgeCwd.layer
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
