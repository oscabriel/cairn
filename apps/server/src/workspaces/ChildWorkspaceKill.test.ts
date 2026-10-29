// The workspace step under a real `kill -9` (docs/phase-2/notes/subagents.md section 10, the
// "worktree intent row or git worktree add" row). Each case runs `fixtures/child-workspace-kill.ts`
// in its own process, which kills itself with SIGKILL at a crash point inside
// `ChildWorkspaces.prepare`; this process then opens the same `cairn.sqlite` and repository as the
// next boot would:
//
// - killed after the plan row, before `git worktree add`: the boot repair leaves no orphan, and a
//   rerun of the spawn makes the planned worktree once;
// - killed after `git worktree add`, before the made flags: the same.
//
// The broken control runs `git worktree add` with no plan row first and dies the same way; the
// orphan check must find what it left, which proves the check can fail.

import { spawn } from "node:child_process";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Option, Schema } from "effect";

import { Git } from "../git/Git.ts";
import { childBranchName, ChildWorkspaces } from "./ChildWorkspaces.ts";
import {
  cairnWorktrees,
  hasBranch,
  makeRepo,
  orphansOf,
  rowOf,
  thread,
  workspacesAt,
} from "./ChildWorkspacesTestKit.ts";

const fixture = path.join(
  import.meta.dirname,
  "fixtures",
  "child-workspace-kill.ts"
);

const Platform = Layer.mergeAll(Git.layer, NodeServices.layer);

const PARENT = thread(90);

const Printed = Schema.Struct({
  event: Schema.Literals(["prepared", "control"]),
  cwd: Schema.String,
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Printed));

/** How one fixture run ended: killed by its own SIGKILL or not, and the cwd it printed. */
interface Ended {
  readonly killed: boolean;
  readonly cwd: Option.Option<string>;
}

const runFixture = (
  data: string,
  repo: string,
  child: ThreadId,
  mode: string
) =>
  Effect.callback<Ended>((resume) => {
    const run = spawn(
      process.execPath,
      [fixture, data, repo, child, PARENT, mode],
      {
        stdio: ["ignore", "pipe", "inherit"],
      }
    );

    let cwd = Option.none<string>();
    let buffered = "";

    run.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");

      const lines = buffered.split("\n");

      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const decoded = decodeLine(line);

        if (Option.isSome(decoded)) {
          cwd = Option.some(decoded.value.cwd);
        }
      }
    });

    run.on("exit", (_code, signal) => {
      resume(Effect.succeed({ killed: signal === "SIGKILL", cwd }));
    });

    return Effect.sync(() => {
      run.kill("SIGKILL");
    });
  }).pipe(Effect.timeout(Duration.seconds(30)), Effect.orDie);

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repo = yield* makeRepo(dir);
  const data = path.join(dir, "data");

  yield* fs.makeDirectory(data, { recursive: true });

  return { repo, data };
});

describe("kill -9 inside the workspace step", () => {
  for (const point of ["after_intent", "after_add"] as const) {
    it.live(
      `killed ${point}: no orphan after the boot repair, and the rerun makes one worktree`,
      () =>
        Effect.gen(function* () {
          const { repo, data } = yield* setup;
          const lost = thread(91);
          const resumed = thread(92);

          const killed = yield* runFixture(data, repo, lost, point);

          assert.isTrue(killed.killed);
          assert.isTrue(Option.isNone(killed.cwd));

          const killedAgain = yield* runFixture(data, repo, resumed, point);

          assert.isTrue(killedAgain.killed);

          // The next boot: `lost` never landed; `resumed`'s spawn reruns after the repair.
          yield* Effect.gen(function* () {
            const planned = yield* rowOf(resumed);

            assert.strictEqual(planned.state, "planned");
            assert.strictEqual(
              (yield* cairnWorktrees(repo, data)).length,
              point === "after_add" ? 2 : 0
            );

            const workspaces = yield* ChildWorkspaces;

            const results = yield* workspaces.repair((id) =>
              Effect.succeed(id === resumed)
            );

            assert.deepStrictEqual(results, [{ kind: "removed", child: lost }]);
            assert.deepStrictEqual(yield* orphansOf(repo, data), []);
            assert.isFalse(
              yield* hasBranch(repo, childBranchName(lost, false))
            );
          }).pipe(Effect.provide(workspacesAt(data)));

          const rerun = yield* runFixture(data, repo, resumed, "none");

          assert.isFalse(rerun.killed);

          yield* Effect.gen(function* () {
            const row = yield* rowOf(resumed);

            assert.deepStrictEqual(rerun.cwd, Option.some(row.worktreePath));
            assert.strictEqual(row.state, "ready");
            assert.deepStrictEqual(yield* cairnWorktrees(repo, data), [
              row.worktreePath,
            ]);
            assert.deepStrictEqual(yield* orphansOf(repo, data), []);
          }).pipe(Effect.provide(workspacesAt(data)));
        }).pipe(Effect.scoped, Effect.provide(Platform)),
      60_000
    );
  }

  it.live(
    "the broken control (git before the plan row) leaves an orphan the check finds",
    () =>
      Effect.gen(function* () {
        const { repo, data } = yield* setup;

        // The real fixture first, so the database exists and is migrated.
        yield* runFixture(data, repo, thread(93), "none");

        const killed = yield* runFixture(data, repo, thread(94), "control");

        assert.isTrue(killed.killed);

        yield* Effect.gen(function* () {
          const workspaces = yield* ChildWorkspaces;

          yield* workspaces.repair(() => Effect.succeed(false));

          const orphans = yield* orphansOf(repo, data);

          assert.deepStrictEqual(orphans, [
            ...Option.toArray(killed.cwd),
            childBranchName(thread(94), false),
          ]);
        }).pipe(Effect.provide(workspacesAt(data)));
      }).pipe(Effect.scoped, Effect.provide(Platform)),
    60_000
  );
});
