// Where the brain keeps its store and backups. The composition root fills it from the server's
// config; it lives on the NVMe under `/home`, never the NAS.

import { Context, Layer } from "effect";

/** The brain's data directory: `brain.sqlite`, its sidecar and `backups/` live in it. */
export class BrainConfig extends Context.Service<
  BrainConfig,
  { readonly dataDir: string }
>()("cairn/server/brain/BrainConfig") {
  /** The brain's files under `dataDir`. */
  static readonly layerFrom = (dataDir: string) =>
    Layer.succeed(BrainConfig, BrainConfig.of({ dataDir }));
}
