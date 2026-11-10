// The brain's one `cairn.sqlite`: the database every composition root opens. It is exported once,
// from here, and every layer that needs the deployed database provides this reference, so the
// memo map opens one connection (`Composition.test.ts` counts it).

import path from "node:path";

import { Effect, Layer } from "effect";

import { ServerConfig } from "../Config.ts";
import { Database } from "./Database.ts";
import { migrations } from "./Migrations.ts";

/**
 * `cairn.sqlite` under the configured data directory, migrated (with a backup first), with its
 * daily rolling copy.
 */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    return Database.layerRollingCopy(config.backupCopyDir).pipe(
      Layer.provideMerge(
        Database.layer({
          filename: path.join(config.dataDir, "cairn.sqlite"),
          migrations,
        })
      )
    );
  })
);
