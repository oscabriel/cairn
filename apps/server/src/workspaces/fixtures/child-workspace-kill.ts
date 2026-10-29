// One spawn's workspace step in its own process, for `ChildWorkspaceKill.test.ts`: it opens
// `<data>/cairn.sqlite`, runs `ChildWorkspaces.prepare` for one worktree child of the parent whose
// cwd is `<repo>`, and kills itself with SIGKILL at the crash point it names, as `kill -9` would.
//
//   node child-workspace-kill.ts <data> <repo> <child> <parent> <after_intent|after_add|none>
//   node child-workspace-kill.ts <data> <repo> <child> <parent> control
//
// `control` is the broken order the plan exists to prevent: it runs `git worktree add` (through
// `Worktrees.create`, at the branch and path a plan would choose) with no plan row first, then
// dies, so the boot repair cannot know the worktree is there. Prints `{"event":"prepared","cwd":
// "..."}` when the step returns.

import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Schema } from "effect";

import { ServerConfig } from "../../Config.ts";
import { Database } from "../../db/Database.ts";
import { migrations } from "../../db/Migrations.ts";
import { ChildWorkspaces0012 } from "../../db/migrations/0012ChildWorkspaces.ts";
import { Git } from "../../git/Git.ts";
import {
  worktreePathFor,
  worktreeRepoKey,
  Worktrees,
} from "../../projects/Worktrees.ts";
import {
  childBranchName,
  ChildWorkspaceFaults,
  ChildWorkspaces,
} from "../ChildWorkspaces.ts";
import type { ChildWorkspaceCrashPoint } from "../ChildWorkspaces.ts";

const [
  dataArg = ".",
  repo = ".",
  childArg = "",
  parentArg = "",
  mode = "none",
] = process.argv.slice(2);

const data = path.resolve(dataArg);

const child = Schema.decodeSync(ThreadId)(childArg);

const parent = Schema.decodeSync(ThreadId)(parentArg);

const killSelf = Effect.sync(() => {
  process.kill(process.pid, "SIGKILL");
}).pipe(Effect.andThen(Effect.never));

const layer = Layer.mergeAll(ChildWorkspaces.layer, Worktrees.layerNoDeps).pipe(
  Layer.provide(
    Database.layer({
      filename: path.join(data, "cairn.sqlite"),
      migrations: {
        ...migrations,
        "0012_ChildWorkspaces": ChildWorkspaces0012,
      },
    })
  ),
  Layer.provide(ServerConfig.layerWith({ dataDir: data })),
  Layer.provide(Git.layer),
  Layer.provide(NodeServices.layer)
);

const control = Effect.gen(function* () {
  const worktrees = yield* Worktrees;
  const branch = childBranchName(child, false);

  yield* worktrees.create({
    repoRoot: repo,
    worktreesDir: path.join(data, "worktrees"),
    baseRef: "HEAD",
    startFromOrigin: false,
    branch,
  });

  // Only `worktreePathFor` names the folder; it is printed so the test can look for it.
  console.log(
    JSON.stringify({
      event: "control",
      cwd: worktreePathFor(
        path.join(data, "worktrees"),
        worktreeRepoKey(repo),
        branch
      ),
    })
  );

  return yield* killSelf;
});

const prepare = Effect.gen(function* () {
  const workspaces = yield* ChildWorkspaces;

  const prepared = yield* workspaces.prepare({
    child,
    parent,
    parentCwd: repo,
    isolation: "worktree",
    base: Option.none(),
  });

  console.log(JSON.stringify({ event: "prepared", cwd: prepared.cwd }));
}).pipe(
  Effect.provideService(ChildWorkspaceFaults, {
    crashAt: (point: ChildWorkspaceCrashPoint) =>
      point === mode ? killSelf : Effect.void,
  })
);

const program: Effect.Effect<void, never, ChildWorkspaces | Worktrees> =
  mode === "control" ? control.pipe(Effect.orDie) : prepare.pipe(Effect.orDie);

await Effect.runPromise(program.pipe(Effect.provide(layer)));
