// Fixtures for the shell store's tests and judges: a migrated in-memory database under the store,
// deterministic ids, and the commands that make a project and a thread.

import { CommandId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { CairnRpcs, Viewer, ViewerMiddleware } from "@cairn/protocol/Rpc";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { Effect, Layer, Option } from "effect";

import { Database } from "../db/Database.ts";
import type { MigrationRecord } from "../db/Database.ts";
import { Shell0001 } from "../db/migrations/0001Shell.ts";
import { projectIdFor, ThreadCreate } from "./ShellCommands.ts";
import { ShellStoreLayer } from "./ShellLayer.ts";

/** The migrations the shell store needs. */
export const shellMigrations: MigrationRecord = { "0001_Shell": Shell0001 };

/** The shell store over a fresh, migrated in-memory database. */
export const ShellTestLayer = ShellStoreLayer.pipe(
  Layer.provideMerge(Database.layerTest(shellMigrations))
);

const uuid7 = (variant: string, n: number) =>
  `0199f0c2-6a4e-7d4c-${variant}-${n.toString(16).padStart(12, "0")}`;

/** The `n`th test command id. */
export const testCommandId = (n: number) => CommandId.make(uuid7("9a6b", n));

/** The `n`th test thread id. */
export const testThreadId = (n: number) => ThreadId.make(uuid7("8a6b", n));

/** Creates a folder project at `/srv/projects/<name>`; its id is `projectIdFor(commandId)`. */
export const createProject = (n: number, name = `project-${n}`) => {
  const commandId = testCommandId(1_000_000 + n);

  return {
    projectId: projectIdFor(commandId),
    command: ProjectCreate.make({
      commandId,
      workspaceRoot: `/srv/projects/${name}`,
      title: Option.none(),
    }),
  };
};

/** Creates thread `n` in `projectId`. */
export const createThread = (projectId: ProjectId, n: number) =>
  ThreadCreate.make({
    commandId: testCommandId(2_000_000 + n),
    threadId: testThreadId(n),
    projectId,
    title: `Thread ${n}`,
    provider: "opencode-go",
    modelId: "small",
    thinkingLevel: "off",
    runtimeMode: "full-access",
    branch: Option.none(),
    worktreePath: Option.none(),
  });

/** A project id that no command made. */
export const unknownProjectId = ProjectId.make("prj_missing");

/** The RPC group with only the shell's two procedures, for clients that test them alone. */
export const ShellRpcs = CairnRpcs.omit(
  "session.hello",
  "thread.launch",
  "thread.send",
  "thread.stop",
  "thread.withdraw",
  "thread.configure",
  "thread.respond",
  "thread.retryTask",
  "thread.subscribe",
  "thread.history",
  "thread.entry",
  "projects.browse",
  "projects.ensureScratch",
  "projects.searchEntries",
  "git.branches",
  "attachments.createUploadUrl",
  "attachments.discard",
  "diff.turn",
  "diff.full",
  "models.list",
  "providers.status",
  "usage.subscribe",
  "skills.list",
  "skills.reload",
  "executor.status",
  "executor.signIn",
  "push.subscribe",
  "push.unsubscribe",
  "presence.report",
  "settings.get",
  "settings.update"
);

/** Admits every request as the test owner. */
export const ViewerTest = Layer.succeed(
  ViewerMiddleware,
  ViewerMiddleware.of((effect) =>
    Effect.provideService(effect, Viewer, { login: "owner@test" })
  )
);
