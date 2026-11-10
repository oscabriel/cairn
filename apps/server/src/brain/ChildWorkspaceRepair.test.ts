// Judges the child workspace boot repair against a real pi-durable brain: a plan whose child has a
// `cairn.thread` receipt (its spawn landed) is left alone, and a plan whose child has none (the
// spawn died before its commit) loses its worktree, branch and row.

import path from "node:path";

import { ProjectId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";

import { Git } from "../git/Git.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { ChildWorkspaces } from "../workspaces/ChildWorkspaces.ts";
import {
  cairnWorktrees,
  hasBranch,
  makeRepo,
  orphansOf,
  thread,
  workspacesAt,
} from "../workspaces/ChildWorkspacesTestKit.ts";
import { testBrain } from "./BrainTestKit.ts";
import { repairChildWorkspacesAtBoot } from "./ChildWorkspaceRepair.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import { FAUX_MODEL } from "./ModelSource.ts";

/**
 * The brain over the children's workspaces `workspaces`, which its subagents extension makes
 * children in too.
 */
const harnessOver = (workspaces: ReturnType<typeof workspacesAt>) =>
  testBrain({ subagents: Subagents.layer.pipe(Layer.provide(workspaces)) });

const Platform = Layer.mergeAll(Git.layer, NodeServices.layer);

describe("the child workspace boot repair", () => {
  it.live("removes only the plans whose child has no receipt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const repo = yield* makeRepo(dir);
      const data = path.join(dir, "data");
      const parent = thread(60);
      const landed = thread(61);
      const lost = thread(62);
      const workspacesLayer = workspacesAt(data);

      yield* Effect.gen(function* () {
        const seam = yield* HarnessSeam;
        const workspaces = yield* ChildWorkspaces;

        const prepare = (child: typeof landed) =>
          workspaces.prepare({
            child,
            parent,
            parentCwd: repo,
            isolation: "worktree",
            base: Option.none(),
          });

        const kept = yield* prepare(landed);
        const dropped = yield* prepare(lost);

        yield* seam.ensureThread({
          threadId: landed,
          projectId: ProjectId.make("repair"),
          model: FAUX_MODEL,
          thinkingLevel: "off",
          cwd: kept.cwd,
          instructions: Option.none(),
          runtimeMode: "full-access",
        });

        yield* repairChildWorkspacesAtBoot;

        assert.isTrue(Option.isSome(yield* workspaces.get(landed)));
        assert.isTrue(Option.isNone(yield* workspaces.get(lost)));
        assert.deepStrictEqual(yield* cairnWorktrees(repo, data), [kept.cwd]);
        assert.isFalse(
          yield* hasBranch(repo, Option.getOrThrow(dropped.worktree).branch)
        );
        assert.deepStrictEqual(yield* orphansOf(repo, data), []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(harnessOver(workspacesLayer), workspacesLayer)
        )
      );
    }).pipe(Effect.scoped, Effect.provide(Platform))
  );
});
