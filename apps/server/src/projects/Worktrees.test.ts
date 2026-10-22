// The branch-name helper cases are ported from github.com/pingdotgg/t3code,
// packages/shared/src/git.test.ts ("isTemporaryWorktreeBranch") at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, with Cairn's `cairn` prefix.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";

import { Git } from "../git/Git.ts";
import { COMMIT_OPTIONS } from "../threads/ThreadsTestKit.ts";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  sanitizeBranchFragment,
  WORKTREE_BRANCH_PREFIX,
  worktreePathFor,
  Worktrees,
} from "./Worktrees.ts";

const TestLayer = Worktrees.layerNoDeps.pipe(
  Layer.provideMerge(Git.layerNoDeps),
  Layer.provideMerge(NodeServices.layer)
);

describe("worktrees and branches", () => {
  it("builds and recognises temporary branch names", () => {
    assert.strictEqual(
      buildTemporaryWorktreeBranchName("DEADBEEF"),
      "cairn/deadbeef"
    );
    assert.isTrue(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)
    );
    assert.isTrue(
      isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/DEADBEEF `)
    );
    assert.isFalse(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)
    );
    assert.isFalse(isTemporaryWorktreeBranch("main"));
    assert.isFalse(isTemporaryWorktreeBranch("other/deadbeef"));
  });

  it("flattens a temporary name when a plain cairn branch blocks the folder form", () => {
    const flat = flattenTemporaryWorktreeBranchName("cairn/deadbeef");

    assert.strictEqual(flat, "cairn-deadbeef");
    assert.isTrue(isTemporaryWorktreeBranch(flat));
    assert.isFalse(isTemporaryWorktreeBranch("cairn-deadbeef-extra"));
    assert.isFalse(isTemporaryWorktreeBranch("cairn-feature"));
  });

  it("sanitizes a fragment and puts a branch's worktree at a flat path", () => {
    assert.strictEqual(
      sanitizeBranchFragment("  Fix: the Login bug!! "),
      "fix-the-login-bug"
    );
    assert.strictEqual(
      sanitizeBranchFragment("feat//add search"),
      "feat/add-search"
    );
    assert.strictEqual(sanitizeBranchFragment("..."), "update");
    assert.strictEqual(
      worktreePathFor("/data/worktrees", "cairn", "feat/add-search"),
      "/data/worktrees/cairn/feat-add-search"
    );
  });

  it.live("lists branches with the default marked, and finds a free name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git;
      const worktrees = yield* Worktrees;
      const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const repo = path.join(dir, "repo");

      yield* git.stdout("test", dir, ["init", "--quiet", "-b", "main", repo]);
      yield* git.stdout("test", repo, [
        ...COMMIT_OPTIONS,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      ]);
      yield* git.stdout("test", repo, ["branch", "topic"]);
      yield* git.stdout("test", repo, ["branch", "topic-1"]);

      const listed = yield* worktrees.branches(repo);

      assert.deepStrictEqual(listed.current, Option.some("main"));
      assert.deepStrictEqual(
        listed.branches.map((branch) => [
          branch.name,
          branch.isDefault,
          branch.isRemote,
        ]),
        [
          ["main", true, false],
          ["topic", false, false],
          ["topic-1", false, false],
        ]
      );
      assert.strictEqual(
        yield* worktrees.availableBranchName(repo, "topic"),
        "topic-2"
      );
      assert.strictEqual(
        yield* worktrees.availableBranchName(repo, "fresh"),
        "fresh"
      );
      assert.isTrue(yield* worktrees.isRepository(repo));
      assert.isFalse(yield* worktrees.isRepository(dir));
      assert.deepStrictEqual(yield* worktrees.branches(dir), {
        current: Option.none(),
        branches: [],
      });

      const created = yield* worktrees.create({
        repoRoot: repo,
        worktreesDir: path.join(dir, "worktrees"),
        baseRef: "main",
        startFromOrigin: false,
        branch: "feat/one",
      });

      assert.strictEqual(
        created.worktreePath,
        path.join(dir, "worktrees", "repo", "feat-one")
      );
      assert.isTrue(yield* worktrees.isWorktreeOf(repo, created.worktreePath));

      const again = yield* worktrees.create({
        repoRoot: repo,
        worktreesDir: path.join(dir, "worktrees"),
        baseRef: "main",
        startFromOrigin: false,
        branch: "feat/one",
      });

      assert.isFalse(again.created);

      const missingBase = yield* Effect.flip(
        worktrees.create({
          repoRoot: repo,
          worktreesDir: path.join(dir, "worktrees"),
          baseRef: "nope",
          startFromOrigin: false,
          branch: "feat/two",
        })
      );

      assert.strictEqual(missingBase.reason, "base_not_found");

      const invalid = yield* Effect.flip(
        worktrees.create({
          repoRoot: repo,
          worktreesDir: path.join(dir, "worktrees"),
          baseRef: "main",
          startFromOrigin: false,
          branch: "bad..name",
        })
      );

      assert.strictEqual(invalid.reason, "invalid_branch");
    }).pipe(Effect.scoped, Effect.provide(TestLayer))
  );
});
