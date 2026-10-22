// The brain's layer graph (a seam: the integrator adds each package's layer here). Each entry point
// provides what it chooses itself: the identity rules, the settings source, logging, the harness
// behind the seam (`PiDurableBrain` or `ScriptedBrain`) and (from later waves) the Executor link.
// Build order is shutdown order reversed: whatever the close hooks need is built before
// `Shutdown`, and the HTTP server after it, so on SIGTERM the sockets close first, then the hooks
// run, then the stores and the Harness close.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";

import { AttachmentsLayer } from "./attachments/AttachmentsLayer.ts";
import { BootLayer } from "./Boot.ts";
import { runBootRepairs } from "./BootRepairs.ts";
import { Brain } from "./brain/Brain.ts";
import { BrainConfig } from "./brain/BrainConfig.ts";
import { BridgeCwd } from "./brain/BridgeCwdExtension.ts";
import type { CairnExtension } from "./brain/Extensions.ts";
import { ExtensionSet } from "./brain/ExtensionSet.ts";
import { ModelSource } from "./brain/ModelSource.ts";
import { PiDurableHarness } from "./brain/PiDurableHarness.ts";
import { ScriptedHarness } from "./brain/ScriptedHarness.ts";
import { ServerConfig } from "./Config.ts";
import { Database } from "./db/Database.ts";
import { migrations } from "./db/Migrations.ts";
import { ExecutorSweep } from "./executor/ExecutorSweep.ts";
import { Git } from "./git/Git.ts";
import { Health } from "./http/Health.ts";
import { HttpLive } from "./http/Http.ts";
import { BootJson } from "./http/Static.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { SettingsStore } from "./models/SettingsStore.ts";
import { FileSearch } from "./projects/FileSearch.ts";
import { FolderRules } from "./projects/FolderRules.ts";
import { ScratchProject } from "./projects/ScratchProject.ts";
import { Worktrees } from "./projects/Worktrees.ts";
import { ExecutorSignInPush } from "./push/ExecutorSignInPush.ts";
import { PushLayer } from "./push/PushLayer.ts";
import { HandlersLayer } from "./rpc/Handlers.ts";
import { SessionHelloWithModels } from "./rpc/ModelHandlers.ts";
import { SessionHelloWithPush } from "./rpc/PushHandlers.ts";
import { SessionHello } from "./rpc/SessionHandlers.ts";
import { ShellLayer } from "./shell/ShellLayer.ts";
import { ShellProjector } from "./shell/ShellProjector.ts";
import { Shutdown } from "./Shutdown.ts";
import { shutdownHooks } from "./ShutdownHooks.ts";
import { Skills } from "./skills/SkillsLayer.ts";
import { BranchNames } from "./threads/BranchNames.ts";
import { bridgeStopHook } from "./threads/BridgeStopHook.ts";
import { LaunchStore } from "./threads/LaunchStore.ts";
import { StopHooks } from "./threads/StopHooks.ts";
import { ThreadLaunch } from "./threads/ThreadLaunch.ts";
import { Threads } from "./threads/Threads.ts";
import { ThreadTitles } from "./threads/ThreadTitles.ts";
import { TitleModel } from "./threads/TitleModel.ts";
import { TurnContentLive } from "./threads/TurnContentStages.ts";
import { ClaudeSignals } from "./usage/ClaudeSignals.ts";

/**
 * How boot hands the harness its work after the repairs. pi-durable does not resume on open, so
 * `PiDurableBrain` resumes the `Brain` here; the scripted harness resumes itself.
 */
export class HarnessBoot extends Context.Service<
  HarnessBoot,
  { readonly resume: Effect.Effect<void> }
>()("cairn/server/AppLayer/HarnessBoot") {}

// Boot (`Boot.ts`): the repairs in order, the harness resumed, every thread row reconciled, then
// ready. The listener serves static files meanwhile and answers `/ws` with 503 until then.
const Boot = BootLayer({
  repairs: runBootRepairs,
  resume: HarnessBoot.use((boot) => boot.resume),
});

/**
 * `cairn.sqlite` under the configured data directory, migrated (with a backup first). Exported so
 * `main.ts` gives the Executor link this same reference, and the memo map opens one connection.
 */
export const DatabaseLive = Layer.unwrap(
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

/** Folders, the scratch project, worktrees and file search, over git. */
const ProjectsLive = Layer.mergeAll(
  FolderRules.layer,
  ScratchProject.layerNoDeps,
  FileSearch.layerNoDeps
).pipe(
  Layer.provideMerge(Worktrees.layerNoDeps),
  Layer.provideMerge(Git.layer),
  Layer.provide(NodeServices.layer)
);

/**
 * Thread launch and thread commands, with their stages, stop hooks and the title model that the
 * `titleModel` server setting names.
 */
export const ThreadsLive = Layer.mergeAll(
  ThreadLaunch.layerNoDeps,
  Threads.layerNoDeps
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LaunchStore.layerNoDeps,
      TurnContentLive,
      StopHooks.layerFrom([bridgeStopHook]).pipe(
        Layer.provide(BridgeCwd.layer)
      ),
      ThreadTitles.layerNoDeps,
      BranchNames.layerNoDeps
    ).pipe(Layer.provide(TitleModel.layerFromSettings))
  ),
  Layer.provideMerge(AttachmentsLayer),
  Layer.provideMerge(ProjectsLive)
);

/** The brain's directory, from the server's config. */
const BrainConfigLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    return BrainConfig.layerFrom(config.dataDir);
  })
);

/**
 * A model source with the picker's catalog over it (`PiModelSource.layerFromModelSource`), for
 * brains that do not run pi's model runtime: the faux and scripted ones.
 */
export const withCatalog = <E, R>(models: Layer.Layer<ModelSource, E, R>) =>
  PiModelSource.layerFromModelSource.pipe(Layer.provideMerge(models));

/**
 * pi-durable behind the harness seam, with the given models and extension set (the production
 * set unless a judge adds its tools). Boot resumes it after the repairs. The models layer is also
 * exposed, so the app's catalog and title model read the same runtime the harness does.
 */
export const PiDurableBrain = <Models = never>(options: {
  readonly models: Layer.Layer<ModelSource | Models>;
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
    Layer.provideMerge(Skills.live),
    Layer.provideMerge(options.models),
    Layer.provide(BrainConfigLive)
  );
};

/**
 * The scripted harness (echoing model, in-memory store) behind the seam: the dev default. The
 * picker's catalog and the title model see the faux model.
 */
export const ScriptedBrain = Layer.succeed(
  HarnessBoot,
  HarnessBoot.of({ resume: Effect.void })
).pipe(
  Layer.provideMerge(ScriptedHarness.layer),
  Layer.provideMerge(Skills.local),
  Layer.provideMerge(
    withCatalog(ModelSource.layerFaux({ tokensPerSecond: 50, settings: {} }))
  )
);

/**
 * Everything but the entry point's choices. Needs `ServerConfig`, `Identity`, the platform's
 * `FileSystem`, a harness (`HarnessSeam` and `HarnessBoot`) and its models (`ModelSource` and the
 * picker's `PiModelSource`): `PiDurableBrain` and `ScriptedBrain` provide all four.
 */
export const AppLayer = Layer.mergeAll(HttpLive, Boot, ExecutorSignInPush).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(
    SessionHelloWithPush.pipe(
      Layer.provide(
        SessionHelloWithModels.pipe(Layer.provide(SessionHello.layer))
      )
    )
  ),
  Layer.provide(BootJson.layerNone),
  Layer.provide(ExecutorSweep.layerNoDeps),
  Layer.provide(Shutdown.layerFrom(shutdownHooks)),
  Layer.provide(Health.layer),
  Layer.provide(ShellProjector.layer.pipe(Layer.provide(ClaudeSignals))),
  Layer.provideMerge(ThreadsLive),
  Layer.provideMerge(PushLayer),
  Layer.provide(SettingsStore.layerNoDeps),
  Layer.provideMerge(ShellLive)
);
