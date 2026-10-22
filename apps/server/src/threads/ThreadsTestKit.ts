// Fixtures for the thread and launch tests: the shell store and `thread_launches` over a fresh
// in-memory database, the scripted harness with a model a test can hold, a title model a test
// scripts, real `git` over a temporary data folder, and helpers that make a repository.
import path from "node:path";

import { RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { CommandId, ProjectId } from "@cairn/protocol/Ids";
import type {
  ThreadLaunchInput,
  WorkspaceStrategy,
} from "@cairn/protocol/Launch";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { NodeServices } from "@effect/platform-node";
import { Clock, Context, Effect, Latch, Layer, Option, Ref } from "effect";

import { AttachmentsLayer } from "../attachments/AttachmentsLayer.ts";
import type { AttachmentStore } from "../attachments/AttachmentStore.ts";
import {
  scriptedAnswer,
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
  ScriptedTools,
} from "../brain/ScriptedHarness.ts";
import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { Shell0001 } from "../db/migrations/0001Shell.ts";
import { Launches0002 } from "../db/migrations/0002Launches.ts";
import { Attachments0003 } from "../db/migrations/0003Attachments.ts";
import { Git } from "../git/Git.ts";
import { FileSearch } from "../projects/FileSearch.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import { Worktrees } from "../projects/Worktrees.ts";
import { EventSink } from "../shell/EventSink.ts";
import { projectIdFor } from "../shell/ShellCommands.ts";
import { ShellStoreLayer } from "../shell/ShellLayer.ts";
import { BranchNames } from "./BranchNames.ts";
import { LaunchStore } from "./LaunchStore.ts";
import { StopHooks } from "./StopHooks.ts";
import { ThreadLaunch } from "./ThreadLaunch.ts";
import { Threads } from "./Threads.ts";
import { ThreadTitles } from "./ThreadTitles.ts";
import { TitleModel } from "./TitleModel.ts";
import type { TurnContent } from "./TurnContent.ts";
import { TurnContentLive } from "./TurnContentStages.ts";

/** The options `git commit` needs in a test repository, whatever the user's global config says. */
export const COMMIT_OPTIONS: ReadonlyArray<string> = [
  "-c",
  "user.name=Cairn Test",
  "-c",
  "user.email=test@localhost",
  "-c",
  "commit.gpgsign=false",
];

/** How the scripted title model answers: one answer for branch prompts, one for title prompts. */
export class TitleScript extends Context.Service<
  TitleScript,
  {
    /** The prompts the model was asked. */
    readonly prompts: Ref.Ref<ReadonlyArray<string>>;
    /** The answer to a branch-name prompt; none fails the request. */
    readonly branch: Ref.Ref<Option.Option<string>>;
    /** The answer to a title prompt; none fails the request. */
    readonly title: Ref.Ref<Option.Option<string>>;
    /** Requests wait until it is completed; `held: false` starts it completed. */
    readonly gate: Latch.Latch;
  }
>()("cairn/server/threads/ThreadsTestKit/TitleScript") {}

/** A title model a test scripts through `TitleScript`. */
export const TitleModelScripted = (options: { readonly held: boolean }) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
      const branch = yield* Ref.make(Option.none<string>());
      const title = yield* Ref.make(Option.none<string>());
      const gate = yield* Latch.make(!options.held);

      const model = TitleModel.of({
        complete: (prompt) =>
          Effect.gen(function* () {
            yield* Ref.update(prompts, (all) => [...all, prompt]);
            yield* gate.await;

            return yield* Ref.get(
              prompt.includes("git branch names") ? branch : title
            );
          }),
      });

      return Context.make(TitleModel, model).pipe(
        Context.add(
          TitleScript,
          TitleScript.of({ prompts, branch, title, gate })
        )
      );
    })
  );

/** Holds every scripted model answer until a test opens the gate. */
export class ModelGate extends Context.Service<
  ModelGate,
  { readonly open: Effect.Effect<void> }
>()("cairn/server/threads/ThreadsTestKit/ModelGate") {}

/** A scripted model that answers "done" once `ModelGate.open` ran, so runs stay busy until then. */
export const HeldModel = Layer.effectContext(
  Effect.gen(function* () {
    const gate = yield* Latch.make(false);

    const model = ScriptedModel.of({
      answer: () =>
        Effect.gen(function* () {
          yield* gate.await;

          return scriptedAnswer("done", yield* Clock.currentTimeMillis);
        }),
    });

    return Context.make(ScriptedModel, model).pipe(
      Context.add(
        ModelGate,
        ModelGate.of({
          open: gate.open.pipe(Effect.asVoid),
        })
      )
    );
  })
);

/** Everything a thread test needs, over `dataDir`, the given title model and scripted model. */
export const threadsTestLayer = <T, E1, R1, M, E2, R2>(options: {
  readonly dataDir: string;
  /** Provides `TitleModel`, and whatever handle the test scripts it with. */
  readonly titleModel: Layer.Layer<T, E1, R1>;
  /** Provides `ScriptedModel`, and whatever handle the test holds it with. */
  readonly model: Layer.Layer<M, E2, R2>;
  /** Defaults to the production stage order. */
  readonly turnContent?: Layer.Layer<TurnContent, never, AttachmentStore>;
  /** Defaults to no hooks. */
  readonly stopHooks?: Layer.Layer<StopHooks>;
}) => {
  const shell = ShellStoreLayer.pipe(
    Layer.provideMerge(
      Database.layerTest({
        "0001_Shell": Shell0001,
        "0002_Launches": Launches0002,
        "0003_Attachments": Attachments0003,
      })
    )
  );

  const harness = ScriptedHarness.layerNoDeps.pipe(
    Layer.provideMerge(ScriptedStore.layer),
    Layer.provideMerge(ScriptedTools.layerEcho),
    Layer.provideMerge(options.model)
  );

  const projects = Layer.mergeAll(
    ScratchProject.layerNoDeps,
    FileSearch.layerNoDeps
  ).pipe(
    Layer.provideMerge(Worktrees.layerNoDeps),
    Layer.provideMerge(Git.layerNoDeps)
  );

  const naming = Layer.mergeAll(
    ThreadTitles.layerNoDeps,
    BranchNames.layerNoDeps
  ).pipe(Layer.provideMerge(options.titleModel));

  return Layer.mergeAll(ThreadLaunch.layerNoDeps, Threads.layerNoDeps).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        LaunchStore.layerNoDeps,
        options.turnContent ?? TurnContentLive,
        options.stopHooks ?? StopHooks.layerNone,
        naming,
        projects,
        harness
      )
    ),
    Layer.provideMerge(AttachmentsLayer),
    Layer.provideMerge(shell),
    Layer.provideMerge(ServerConfig.layerWith({ dataDir: options.dataDir })),
    Layer.provideMerge(NodeServices.layer)
  );
};

/** Makes a git repository at `dir` on branch `main` with one empty commit. */
export const makeRepository = Effect.fn("ThreadsTestKit.makeRepository")(
  function* (dir: string) {
    const git = yield* Git;

    yield* git.stdout("test", path.dirname(dir), [
      "init",
      "--quiet",
      "-b",
      "main",
      dir,
    ]);
    yield* git.stdout("test", dir, [
      ...COMMIT_OPTIONS,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ]);
  }
);

/** Adds the folder at `workspaceRoot` as a project; returns its id. */
export const addProject = Effect.fn("ThreadsTestKit.addProject")(function* (
  workspaceRoot: string
) {
  const sink = yield* EventSink;
  const commandId = yield* sink.mintCommandId;

  yield* sink.commitCommand(
    ProjectCreate.make({ commandId, workspaceRoot, title: Option.none() })
  );

  return projectIdFor(commandId);
});

/** A launch of a new thread in `projectId` with `text` as its first message. */
export const launchInput = Effect.fn("ThreadsTestKit.launchInput")(function* (
  projectId: ProjectId,
  workspace: WorkspaceStrategy,
  text: string
) {
  const sink = yield* EventSink;
  const commandId: CommandId = yield* sink.mintCommandId;
  const threadId = ThreadId.make(yield* sink.mintCommandId);

  const input: ThreadLaunchInput = {
    commandId,
    threadId,
    projectId,
    title: Option.none(),
    model: { provider: "scripted", modelId: "scripted" },
    thinkingLevel: "off",
    runtimeMode: "full-access",
    workspace,
    initialMessage: {
      requestId: RequestId.make(`launch-${threadId}`),
      text,
      attachments: [],
      skillRefs: [],
    },
  };

  return input;
});
