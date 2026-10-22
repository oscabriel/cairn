// The brain's layer graph (a seam: the integrator adds each package's layer here). Each entry point
// provides what it chooses itself: the identity rules, the settings source, logging, the harness
// behind the seam (`PiDurableBrain` or `ScriptedBrain`) and (from later waves) the Executor link.
// Build order is shutdown order reversed: whatever the close hooks need is built before
// `Shutdown`, and the HTTP server after it, so on SIGTERM the sockets close first, then the hooks
// run, then the stores and the Harness close.
import path from "node:path";

import { Context, Effect, Layer } from "effect";

import { runBootRepairs } from "./BootRepairs.ts";
import { Brain } from "./brain/Brain.ts";
import { BrainConfig } from "./brain/BrainConfig.ts";
import type { CairnExtension } from "./brain/Extensions.ts";
import { ExtensionSet } from "./brain/ExtensionSet.ts";
import type { ModelSource } from "./brain/ModelSource.ts";
import { PiDurableHarness } from "./brain/PiDurableHarness.ts";
import { ScriptedHarness } from "./brain/ScriptedHarness.ts";
import { ServerConfig } from "./Config.ts";
import { Database } from "./db/Database.ts";
import { migrations } from "./db/Migrations.ts";
import { Health } from "./http/Health.ts";
import { HttpLive } from "./http/Http.ts";
import { BootJson } from "./http/Static.ts";
import { HandlersLayer } from "./rpc/Handlers.ts";
import { SessionHello } from "./rpc/SessionHandlers.ts";
import { ShellLayer } from "./shell/ShellLayer.ts";
import { Shutdown } from "./Shutdown.ts";
import { shutdownHooks } from "./ShutdownHooks.ts";

/**
 * How boot hands the harness its work after the repairs. pi-durable does not resume on open, so
 * `PiDurableBrain` resumes the `Brain` here; the scripted harness resumes itself.
 */
export class HarnessBoot extends Context.Service<
  HarnessBoot,
  { readonly resume: Effect.Effect<void> }
>()("cairn/server/AppLayer/HarnessBoot") {}

// Boot, until the boot package (2C) owns it: the repairs in order, the harness resumed, then
// ready. The listener serves static files meanwhile and answers `/ws` with 503 until `markReady`.
const Boot = Layer.effectDiscard(
  Effect.gen(function* () {
    const health = yield* Health;
    const harness = yield* HarnessBoot;

    yield* runBootRepairs;
    yield* harness.resume;
    yield* health.markReady;
    yield* Effect.logInfo("ready").pipe(
      Effect.annotateLogs({ event: "ready" })
    );
  })
);

/** `cairn.sqlite` under the configured data directory, migrated (with a backup first). */
const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    return Database.layer({
      filename: path.join(config.dataDir, "cairn.sqlite"),
      migrations,
    });
  })
);

/** The shell store with settlement and the default projector signals, over the database. */
const ShellLive = ShellLayer.pipe(Layer.provideMerge(DatabaseLive));

/** The brain's directory, from the server's config. */
const BrainConfigLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    return BrainConfig.layerFrom(config.dataDir);
  })
);

/**
 * pi-durable behind the harness seam, with the given models and extension set (the production
 * set unless a judge adds its tools). Boot resumes it after the repairs.
 */
export const PiDurableBrain = (options: {
  readonly models: Layer.Layer<ModelSource>;
  readonly extraExtensions?: ReadonlyArray<CairnExtension>;
}) => {
  const resume = Layer.effect(
    HarnessBoot,
    Brain.useSync((brain) =>
      HarnessBoot.of({
        resume: brain.resume.pipe(
          Effect.catchTag("BrainUnavailable", (failure) =>
            Effect.logError("brain did not resume").pipe(
              Effect.annotateLogs({
                event: "brain_resume_failed",
                cause: failure.message,
              })
            )
          )
        ),
      })
    )
  );

  return resume.pipe(
    Layer.provideMerge(PiDurableHarness.layer),
    Layer.provide(
      options.extraExtensions === undefined
        ? ExtensionSet.layer
        : ExtensionSet.withExtra(options.extraExtensions)
    ),
    Layer.provide(options.models),
    Layer.provide(BrainConfigLive)
  );
};

/** The scripted harness (echoing model, in-memory store) behind the seam: the dev default. */
export const ScriptedBrain = Layer.succeed(
  HarnessBoot,
  HarnessBoot.of({ resume: Effect.void })
).pipe(Layer.provideMerge(ScriptedHarness.layer));

/**
 * Everything but the entry point's choices. Needs `ServerConfig`, `Identity`, the platform's
 * `FileSystem`, and a harness (`HarnessSeam` and `HarnessBoot`).
 */
export const AppLayer = Layer.mergeAll(HttpLive, Boot).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(SessionHello.layer),
  Layer.provide(BootJson.layerNone),
  Layer.provide(Shutdown.layerFrom(shutdownHooks)),
  Layer.provide(Health.layer),
  Layer.provideMerge(ShellLive)
);
