// The brain's layer graph: each package's layer is added here. Each entry point provides what it
// chooses itself: the identity rules, the settings source, logging, the harness behind the seam
// (`PiDurableBrain` or `ScriptedBrain`) and the Executor link (`ExecutorLink.layer` or
// `layerDisabled`).
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
import { EventReactors } from "./brain/EventReactors.ts";
import type { CairnExtension } from "./brain/Extensions.ts";
import { ExtensionSet } from "./brain/ExtensionSet.ts";
import { HarnessSeam } from "./brain/HarnessSeam.ts";
import { ModelSource } from "./brain/ModelSource.ts";
import { PiDurableHarness } from "./brain/PiDurableHarness.ts";
import { ReactorSet } from "./brain/ReactorSet.ts";
import { ScriptedHarness } from "./brain/ScriptedHarness.ts";
import { SpendFeed } from "./brain/SpendFeed.ts";
import { ServerConfig } from "./Config.ts";
import { Database } from "./db/Database.ts";
import { migrations } from "./db/Migrations.ts";
import { ExecutorSweep } from "./executor/ExecutorSweep.ts";
import {
  CHECKPOINT_ENTRY_KIND,
  CheckpointCapture,
  CheckpointEntries,
  CheckpointEntryError,
} from "./git/CheckpointCapture.ts";
import { Diffs } from "./git/Diffs.ts";
import { Git } from "./git/Git.ts";
import { Health } from "./http/Health.ts";
import { HttpLive } from "./http/Http.ts";
import { BootData } from "./load/BootData.ts";
import { PeerPath } from "./load/PeerPath.ts";
import { MemoryWatch } from "./MemoryWatch.ts";
import { ModelHealth } from "./models/ModelHealth.ts";
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
import { SpendLedger } from "./usage/SpendLedger.ts";

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

/**
 * Each provider's health over the database. One reference, which `AppLayer` uses (the login RPCs
 * reset it) and each entry point gives `PiDurableBrain` (its `model-health` extension records into
 * it), so the memo map builds one store whose memory both see.
 */
export const ModelHealthLive = ModelHealth.layerNoDeps.pipe(
  Layer.provide(DatabaseLive)
);

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
export const ThreadsLive = Threads.layerNoDeps.pipe(
  Layer.provideMerge(ThreadLaunch.layerNoDeps),
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
 * set unless a judge adds its tools) and the durable event reactors (`ReactorSet.ts`). Boot resumes
 * it after the repairs. `ModelHealth`, which the set's health feed records into, is left to the
 * entry point: `ModelHealthLive`, the reference `AppLayer` uses, so one store serves both. The models layer is also
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

  return Layer.mergeAll(resume, ReactorSet.layer, SpendFeed.layer).pipe(
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
export const ScriptedBrain = Layer.mergeAll(
  Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
  EventReactors.layerOff,
  SpendFeed.layerOff
).pipe(
  Layer.provideMerge(ScriptedHarness.layer),
  Layer.provideMerge(Skills.local),
  Layer.provideMerge(
    withCatalog(ModelSource.layerFaux({ tokensPerSecond: 50, settings: {} }))
  )
);

/** Checkpoint entries written through the harness as passive `cairn.checkpoint` entries. */
const CheckpointEntriesLive = Layer.effect(
  CheckpointEntries,
  HarnessSeam.useSync((harness) =>
    CheckpointEntries.of({
      write: (threadId, requestId, data) =>
        harness
          .write(threadId, {
            requestId,
            kind: CHECKPOINT_ENTRY_KIND,
            data: { ...data, files: data.files.map((file) => ({ ...file })) },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CheckpointEntryError({
                  message: cause.message,
                  threadId,
                  cause,
                })
            )
          ),
    })
  )
);

/**
 * Everything but the entry point's choices. Needs `ServerConfig`, `Identity`, the platform's
 * `FileSystem`, a harness (`HarnessSeam` and `HarnessBoot`) and its models (`ModelSource` and the
 * picker's `PiModelSource`): `PiDurableBrain` and `ScriptedBrain` provide all four.
 */
export const AppLayer = Layer.mergeAll(
  HttpLive,
  Boot,
  ExecutorSignInPush,
  MemoryWatch.pipe(Layer.provide(NodeServices.layer))
).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(BootData),
  Layer.provide(
    SessionHelloWithPush.pipe(
      Layer.provide(
        SessionHelloWithModels.pipe(Layer.provide(SessionHello.layer))
      )
    )
  ),
  Layer.provide(PeerPath.layer),
  Layer.provide(ExecutorSweep.layerNoDeps),
  Layer.provide(Shutdown.layerFrom(shutdownHooks)),
  Layer.provide(Health.layer),
  Layer.provide(Diffs.layer),
  Layer.provideMerge(
    CheckpointCapture.layer.pipe(Layer.provide(CheckpointEntriesLive))
  ),
  Layer.provide(ShellProjector.layer.pipe(Layer.provide(ClaudeSignals))),
  Layer.provideMerge(ThreadsLive),
  Layer.provideMerge(SpendLedger.layerNoDeps),
  Layer.provideMerge(PushLayer),
  Layer.provide(SettingsStore.layerNoDeps),
  Layer.provideMerge(Layer.merge(ShellLive, ModelHealthLive))
);
