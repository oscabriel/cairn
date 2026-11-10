// Where the brain keeps its store and backups. The composition root fills it from the server's
// config; it lives on the NVMe under `/home`, never the NAS. Only copies may go off the NVMe: the
// optional second copy folder (`CAIRN_BACKUP_COPY_DIR`) gets each daily rolling copy too.

import { Context, Layer, Option } from "effect";

/** The brain's data directory: `brain.sqlite`, its sidecar and `backups/` live in it. */
export class BrainConfig extends Context.Service<
  BrainConfig,
  {
    readonly dataDir: string;
    /** A second folder for the daily rolling copies, off the NVMe; none by default. */
    readonly backupCopyDir: Option.Option<string>;
  }
>()("cairn/server/brain/BrainConfig") {
  /** The brain's files under `dataDir`, with the rolling copies also written to `backupCopyDir`. */
  static readonly layerFrom = (
    dataDir: string,
    backupCopyDir: Option.Option<string> = Option.none()
  ) => Layer.succeed(BrainConfig, BrainConfig.of({ dataDir, backupCopyDir }));
}
