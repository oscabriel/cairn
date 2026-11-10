// The brain's layer graph: the brain's own layers and every feature's, folded from `Features.ts`
// (ADR 0053): the RPC handlers, the services a feature runs over pi-durable and what the app runs
// for it. Each entry point provides what it chooses itself: the identity rules, the settings
// source, logging, the harness behind the seam (`PiDurableBrain`, or `ScriptedBrain` from
// `DevLayer.ts`) and the Executor link (`ExecutorLink.layer`, `FakeExecutorLink` or
// `layerDisabled`). Build order is shutdown order reversed: whatever the close hooks need is built
// before `Shutdown`, and the HTTP server after it, so on SIGTERM the sockets close first, then the
// hooks run, then the stores and the Harness close.

import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";

import { AttachmentsLayer } from "./attachments/AttachmentsLayer.ts";
import { BootLayer } from "./Boot.ts";
import { runBootRepairs } from "./BootRepairs.ts";
import { Brain } from "./brain/Brain.ts";
import { BrainConfig } from "./brain/BrainConfig.ts";
import type { CairnExtension } from "./brain/Extensions.ts";
import { HarnessSeam } from "./brain/HarnessSeam.ts";
import type { ModelSource } from "./brain/ModelSource.ts";
import { PiDurableHarness } from "./brain/PiDurableHarness.ts";
import { ServerConfig } from "./Config.ts";
import { DatabaseLive } from "./db/DatabaseLive.ts";
import { ExecutorSweep } from "./executor/ExecutorSweep.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FEATURES } from "./Features.ts";
import type { Feature } from "./Features.ts";
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
import { BridgeCwd } from "./models/BridgeCwdExtension.ts";
import { SessionHelloWithModels } from "./models/ModelHandlers.ts";
import { ModelHealthLive } from "./models/ModelHealth.ts";
import { PiModelSource } from "./models/PiModelSource.ts";
import { SettingsLive } from "./models/SettingsStore.ts";
import { FileSearch } from "./projects/FileSearch.ts";
import { FolderRules } from "./projects/FolderRules.ts";
import { ScratchProject } from "./projects/ScratchProject.ts";
import { Worktrees } from "./projects/Worktrees.ts";
import { SessionHelloWithPush } from "./push/PushHandlers.ts";
import { PushLayer } from "./push/PushLayer.ts";
import { ReachLive } from "./reach/ReachLayer.ts";
import { ReactorSet } from "./ReactorSet.ts";
import { handlersOf, servesEveryRpc } from "./rpc/Handlers.ts";
import { SessionHello } from "./rpc/SessionHandlers.ts";
import { ShellLayer } from "./shell/ShellLayer.ts";
import { ShellProjector } from "./shell/ShellProjector.ts";
import { Shutdown } from "./Shutdown.ts";
import { shutdownHooks } from "./ShutdownHooks.ts";
import { Skills } from "./skills/SkillsLayer.ts";
import { Subagents } from "./subagents/Subagents.ts";
import { BranchNames } from "./threads/BranchNames.ts";
import { bridgeStopHook } from "./threads/BridgeStopHook.ts";
import { LaunchStore } from "./threads/LaunchStore.ts";
import { StopHooks } from "./threads/StopHooks.ts";
import { ThreadLaunch } from "./threads/ThreadLaunch.ts";
import { Threads } from "./threads/Threads.ts";
import { ThreadTitles } from "./threads/ThreadTitles.ts";
import { TitleModel } from "./threads/TitleModel.ts";
import { TurnContentLive } from "./threads/TurnContentStages.ts";
import { BudgetBook } from "./usage/BudgetBook.ts";
import { BudgetGuard } from "./usage/BudgetGuard.ts";
import { Budgets } from "./usage/Budgets.ts";
import { ClaudeSignals } from "./usage/ClaudeSignals.ts";
import { SpendLedger } from "./usage/SpendLedger.ts";
import { WorkflowPushes } from "./workflows/WorkflowPushes.ts";
import { ChildWorkspaces } from "./workspaces/ChildWorkspaces.ts";

/** The services every feature runs over pi-durable, beside the harness. */
export const harnessLayersOf = (features: ReadonlyArray<Feature>) =>
  features.map((feature): Feature["harnessLayer"] => feature.harnessLayer);

/** What the app runs for every feature: its fibers and the services only it gives the app. */
export const appLayersOf = (features: ReadonlyArray<Feature>) =>
  features.map((feature): Feature["appLayer"] => feature.appLayer);

/**
 * Every RPC handler, the brain's own and every feature's, held to the whole group of `CairnRpcs`:
 * a feature whose handlers are missing from its manifest is a compile error here.
 */
export const HandlersLayer = servesEveryRpc(handlersOf(FEATURES));

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

/** The shell store with settlement and the default projector signals, over the database. */
const ShellLive = ShellLayer.pipe(Layer.provideMerge(DatabaseLive));

/** Folders, the scratch project, worktrees, child workspaces and file search, over git. */
const ProjectsLive = Layer.mergeAll(
  FolderRules.layer,
  ScratchProject.layerNoDeps,
  FileSearch.layerNoDeps,
  ChildWorkspaces.layer
).pipe(
  Layer.provideMerge(Worktrees.layerNoDeps),
  Layer.provideMerge(Git.layer),
  Layer.provide(NodeServices.layer)
);

/**
 * The subagents extension (3A) over the app's child workspaces: `ChildWorkspaces.layer`, the
 * reference `ProjectsLive` uses, so the memo map builds one `ChildWorkspaces` for the brief task's
 * `prepare` and the boot repair. `SubagentFaults` keeps its default, no faults.
 */
const SubagentsLive = Subagents.layer.pipe(
  Layer.provide(ChildWorkspaces.layer),
  Layer.provide(DatabaseLive)
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

    return BrainConfig.layerFrom(config.dataDir, config.backupCopyDir);
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
 * it after the repairs. The `cairn.reach` tools' `Artifacts` and `PortalTools` are the entry
 * point's too: `ReachLive`, as `AppLayer` uses. `ModelHealth`, which the set's health feed records
 * into, is left to the entry point: `ModelHealthLive`, the reference `AppLayer` uses, so one
 * store serves both; so is `SettingsStore` (`SettingsLive`), which the brain's tools read.
 * The models layer is also
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

  return Layer.mergeAll(
    resume,
    ReactorSet.layer,
    ...harnessLayersOf(FEATURES)
  ).pipe(
    Layer.provideMerge(PiDurableHarness.layer),
    Layer.provide(
      options.extraExtensions === undefined
        ? ExtensionSet.layer
        : ExtensionSet.withExtra(options.extraExtensions)
    ),
    Layer.provide(SubagentsLive),
    Layer.provideMerge(Skills.live),
    Layer.provideMerge(options.models),
    Layer.provide(BrainConfigLive)
  );
};

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
 * Budgets (4E, ADR 0036) over one `BudgetBook`: `BudgetBook.layer` is the reference the brain's
 * extension set gives the `cairn.budgets` gate (`ExtensionSet.ts`), so the memo map builds one book
 * for the gate, the spend ledger (each row's budget word), `Budgets` and the guard. The guard's
 * fiber acts on the ledger's readings; `BudgetSources` is the harness's (`PiDurableBrain` or
 * `ScriptedBrain`).
 */
const BudgetsLive = BudgetGuard.layerNoDeps.pipe(
  Layer.provideMerge(Budgets.layerNoDeps)
);

/**
 * Everything but the entry point's choices. Needs `ServerConfig`, `Identity`, the platform's
 * `FileSystem`, a harness (`HarnessSeam` and `HarnessBoot`) and its models (`ModelSource` and the
 * picker's `PiModelSource`): `PiDurableBrain` and `ScriptedBrain` provide all four. Also the porch
 * and portal units (`PorchClient`, `PortalUnits`): the real ones in `main.ts`, a fake porch in
 * judge and dev brains (`ReachMachine` in `reach/ReachTestKit.ts`).
 */
export const AppLayer = Layer.mergeAll(
  HttpLive,
  Boot,
  MemoryWatch.pipe(Layer.provide(NodeServices.layer)),
  ...appLayersOf(FEATURES)
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
  Layer.provideMerge(BudgetsLive),
  Layer.provideMerge(SpendLedger.layerNoDeps),
  Layer.provideMerge(PushLayer),
  Layer.provideMerge(BudgetBook.layer),
  Layer.provideMerge(WorkflowPushes.layer),
  Layer.provideMerge(ReachLive),
  Layer.provide(SettingsLive),
  Layer.provideMerge(Layer.merge(ShellLive, ModelHealthLive))
);
