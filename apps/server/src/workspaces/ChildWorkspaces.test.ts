// Judges a subagent's workspace on temporary repositories (docs/phase-2/notes/subagents.md
// section 6): a worktree child starts from the parent's HEAD on a branch named from its id, a
// shared child stays in the parent's cwd, a spawn a crash interrupted (after its plan row, or after
// `git worktree add`) reruns into the same worktree and leaves no orphan after the boot repair, and
// nothing ever deletes a dirty or unmerged worktree. The last judge also runs a broken control (a
// forced removal with no checks) and requires it to lose the work the real release keeps.
// `ChildWorkspaceKill.test.ts` repeats the crash cases with a real `kill -9`.

import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import type { PlatformError } from "effect";

import { Git } from "../git/Git.ts";
import type { GitError } from "../git/Git.ts";
import { Worktrees } from "../projects/Worktrees.ts";
import type { WorktreeError } from "../projects/Worktrees.ts";
import {
  childBranchName,
  ChildWorkspaceFaults,
  ChildWorkspaces,
} from "./ChildWorkspaces.ts";
import type {
  ChildWorkspaceCrashPoint,
  ChildWorkspaceError,
} from "./ChildWorkspaces.ts";
import {
  cairnWorktrees,
  commitFile,
  exists,
  gitIn,
  hasBranch,
  makeRepo,
  orphansOf,
  rowOf,
  thread,
  workspacesAt,
} from "./ChildWorkspacesTestKit.ts";

const Platform = Layer.mergeAll(Git.layer, NodeServices.layer);

const PARENT = thread(0);

/** A temporary folder holding `repo/` and the brain's data folder `data/`. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repo = yield* makeRepo(dir);

  return { dir, repo, data: path.join(dir, "data") };
});

const prepareIn = (repo: string, child: ThreadId) =>
  ChildWorkspaces.use((workspaces) =>
    workspaces.prepare({
      child,
      parent: PARENT,
      parentCwd: repo,
      isolation: "worktree",
      base: Option.none(),
    })
  );

/** `prepare` that dies at `point`, as a process killed there would stop. */
const crashingAt = (point: ChildWorkspaceCrashPoint) =>
  Effect.provideService(ChildWorkspaceFaults, {
    crashAt: (at) => (at === point ? Effect.die("killed") : Effect.void),
  });

describe("ChildWorkspaces.prepare", () => {
  it.live("works over layerTest, the layer brains under test take", () =>
    Effect.gen(function* () {
      const { repo } = yield* setup;

      yield* Effect.gen(function* () {
        const prepared = yield* prepareIn(repo, thread(9));

        assert.isTrue(Option.isSome(prepared.worktree));
        assert.strictEqual(
          (yield* gitIn(prepared.cwd, ["branch", "--show-current"])).trim(),
          childBranchName(thread(9), false)
        );
      }).pipe(Effect.provide(ChildWorkspaces.layerTest));
    }).pipe(Effect.scoped, Effect.provide(Platform))
  );

  it.live(
    "gives a worktree child its own checkout from the parent's HEAD, and a shared child the parent's cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, data } = yield* setup;
        const head = (yield* gitIn(repo, ["rev-parse", "HEAD"])).trim();
        const child = thread(1);

        // A dirty edit in the parent is not copied.
        yield* fs.writeFileString(path.join(repo, "README.md"), "dirty\n");

        yield* Effect.gen(function* () {
          const workspaces = yield* ChildWorkspaces;
          const prepared = yield* prepareIn(repo, child);
          const branch = childBranchName(child, false);

          assert.match(branch, /^cairn\/sub-[0-9a-f]{8}$/u);
          assert.deepStrictEqual(
            Option.map(prepared.worktree, (w) => w.branch),
            Option.some(branch)
          );
          assert.deepStrictEqual(
            Option.map(prepared.worktree, (w) => w.baseSha),
            Option.some(head)
          );
          assert.strictEqual(
            (yield* gitIn(prepared.cwd, ["rev-parse", "HEAD"])).trim(),
            head
          );
          assert.strictEqual(
            (yield* gitIn(prepared.cwd, ["branch", "--show-current"])).trim(),
            branch
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(prepared.cwd, "README.md")),
            "hello\n"
          );

          const row = yield* rowOf(child);

          assert.strictEqual(row.state, "ready");
          assert.isTrue(row.worktreeCreated && row.branchCreated);
          assert.strictEqual(row.baseRef, "main");

          // A second call finds the same worktree and makes nothing.
          assert.deepStrictEqual(yield* prepareIn(repo, child), prepared);
          assert.strictEqual((yield* cairnWorktrees(repo, data)).length, 1);

          const shared = yield* workspaces.prepare({
            child: thread(2),
            parent: PARENT,
            parentCwd: repo,
            isolation: "shared",
            base: Option.none(),
          });

          assert.deepStrictEqual(shared, {
            cwd: repo,
            worktree: Option.none(),
          });
          assert.isTrue(Option.isNone(yield* workspaces.get(thread(2))));
        }).pipe(Effect.provide(workspacesAt(data)));
      }).pipe(Effect.scoped, Effect.provide(Platform))
  );

  it.live("starts from the brief's base and judges merged against it", () =>
    Effect.gen(function* () {
      const { repo, data } = yield* setup;

      yield* gitIn(repo, ["switch", "--quiet", "-c", "feature"]);
      const tip = yield* commitFile(repo, "feature.txt", "f\n");
      yield* gitIn(repo, ["switch", "--quiet", "main"]);

      yield* Effect.gen(function* () {
        const workspaces = yield* ChildWorkspaces;

        const prepared = yield* workspaces.prepare({
          child: thread(3),
          parent: PARENT,
          parentCwd: repo,
          isolation: "worktree",
          base: Option.some("feature"),
        });

        assert.strictEqual(
          (yield* gitIn(prepared.cwd, ["rev-parse", "HEAD"])).trim(),
          tip
        );
        assert.strictEqual((yield* rowOf(thread(3))).baseRef, "feature");
      }).pipe(Effect.provide(workspacesAt(data)));
    }).pipe(Effect.scoped, Effect.provide(Platform))
  );

  it.live(
    "refuses a parent outside a repository, a base that is no commit, and a branch it did not plan",
    () =>
      Effect.gen(function* () {
        const { dir, repo, data } = yield* setup;
        const taken = thread(4);

        yield* gitIn(repo, ["branch", childBranchName(taken, false)]);

        yield* Effect.gen(function* () {
          const workspaces = yield* ChildWorkspaces;

          const outside = yield* Effect.flip(
            workspaces.prepare({
              child: thread(5),
              parent: PARENT,
              parentCwd: dir,
              isolation: "worktree",
              base: Option.none(),
            })
          );

          assert.strictEqual(outside.reason, "not_a_repository");

          const noBase = yield* Effect.flip(
            workspaces.prepare({
              child: thread(5),
              parent: PARENT,
              parentCwd: repo,
              isolation: "worktree",
              base: Option.some("no-such-branch"),
            })
          );

          assert.strictEqual(noBase.reason, "base_not_found");

          const refused = yield* Effect.flip(prepareIn(repo, taken));

          assert.strictEqual(refused.reason, "branch_taken");
          assert.isTrue(Option.isNone(yield* workspaces.get(taken)));
          assert.isTrue(Option.isNone(yield* workspaces.get(thread(5))));
        }).pipe(Effect.provide(workspacesAt(data)));
      }).pipe(Effect.scoped, Effect.provide(Platform))
  );
});

describe("a spawn interrupted between its plan and the child's commit", () => {
  for (const point of ["after_intent", "after_add"] as const) {
    it.live(
      `${point}: the rerun makes the same worktree once, and the boot repair leaves no orphan`,
      () =>
        Effect.gen(function* () {
          const { repo, data } = yield* setup;
          const child = thread(6);

          // Life one: dies at the crash point.
          const planned = yield* Effect.gen(function* () {
            yield* Effect.exit(prepareIn(repo, child).pipe(crashingAt(point)));

            const row = yield* rowOf(child);

            assert.strictEqual(row.state, "planned");
            assert.isFalse(row.worktreeCreated);
            assert.strictEqual(
              (yield* cairnWorktrees(repo, data)).length,
              point === "after_add" ? 1 : 0
            );

            return row;
          }).pipe(Effect.provide(workspacesAt(data)));

          // Life two: the spawn reruns and lands.
          yield* Effect.gen(function* () {
            const prepared = yield* prepareIn(repo, child);

            assert.strictEqual(prepared.cwd, planned.worktreePath);
            assert.deepStrictEqual(yield* cairnWorktrees(repo, data), [
              planned.worktreePath,
            ]);
            assert.strictEqual((yield* rowOf(child)).state, "ready");
          }).pipe(Effect.provide(workspacesAt(data)));

          // Another spawn dies at the same point and never lands: the boot repair clears it.
          const lost = thread(7);

          yield* Effect.exit(
            prepareIn(repo, lost).pipe(crashingAt(point))
          ).pipe(Effect.provide(workspacesAt(data)));

          yield* Effect.gen(function* () {
            const workspaces = yield* ChildWorkspaces;

            const results = yield* workspaces.repair((id) =>
              Effect.succeed(id === child)
            );

            assert.deepStrictEqual(results, [{ kind: "removed", child: lost }]);
            assert.isTrue(Option.isNone(yield* workspaces.get(lost)));
            assert.isFalse(
              yield* hasBranch(repo, childBranchName(lost, false))
            );
            assert.deepStrictEqual(yield* orphansOf(repo, data), []);

            // The landed child is untouched.
            assert.deepStrictEqual(yield* cairnWorktrees(repo, data), [
              planned.worktreePath,
            ]);
          }).pipe(Effect.provide(workspacesAt(data)));
        }).pipe(Effect.scoped, Effect.provide(Platform))
    );
  }

  it.live(
    "the boot repair keeps an unlanded worktree that holds work, with its row and branch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, data } = yield* setup;
        const child = thread(8);

        yield* Effect.gen(function* () {
          yield* Effect.exit(
            prepareIn(repo, child).pipe(crashingAt("after_add"))
          );

          const row = yield* rowOf(child);

          yield* fs.writeFileString(
            path.join(row.worktreePath, "notes.txt"),
            "keep me\n"
          );

          const workspaces = yield* ChildWorkspaces;
          const results = yield* workspaces.repair(() => Effect.succeed(false));

          assert.deepStrictEqual(
            results.map((result) => [result.kind, result.child]),
            [["kept", child]]
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(row.worktreePath, "notes.txt")),
            "keep me\n"
          );
          assert.isTrue(Option.isSome(yield* workspaces.get(child)));
          assert.isTrue(yield* hasBranch(repo, row.branch));
        }).pipe(Effect.provide(workspacesAt(data)));
      }).pipe(Effect.scoped, Effect.provide(Platform))
  );
});

/** A worktree child, ready, with `work` done in its checkout. */
interface Scenario {
  readonly name: string;
  readonly settled: boolean;
  /** Puts work in the worktree (or none). */
  readonly work: (
    worktree: string
  ) => Effect.Effect<
    void,
    PlatformError.PlatformError | GitError,
    FileSystem.FileSystem | Git
  >;
  /** Whether removing the worktree is allowed: settled, clean and merged. */
  readonly removable: boolean;
}

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "a modified tracked file",
    settled: true,
    work: (worktree) =>
      FileSystem.FileSystem.use((fs) =>
        fs.writeFileString(path.join(worktree, "README.md"), "edited\n")
      ),
    removable: false,
  },
  {
    name: "an untracked file",
    settled: true,
    work: (worktree) =>
      FileSystem.FileSystem.use((fs) =>
        fs.writeFileString(path.join(worktree, "new.txt"), "new\n")
      ),
    removable: false,
  },
  {
    name: "a staged file",
    settled: true,
    work: (worktree) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        yield* fs.writeFileString(path.join(worktree, "staged.txt"), "s\n");
        yield* gitIn(worktree, ["add", "staged.txt"]);
      }),
    removable: false,
  },
  {
    name: "a commit not in its base",
    settled: true,
    work: (worktree) => commitFile(worktree, "work.txt", "w\n"),
    removable: false,
  },
  {
    name: "a commit on a detached HEAD",
    settled: true,
    work: (worktree) =>
      Effect.gen(function* () {
        yield* gitIn(worktree, ["switch", "--quiet", "--detach"]);
        yield* commitFile(worktree, "detached.txt", "d\n");
      }),
    removable: false,
  },
  {
    name: "a child still working",
    settled: false,
    work: () => Effect.void,
    removable: false,
  },
  {
    name: "a settled, clean child with nothing unmerged",
    settled: true,
    work: () => Effect.void,
    removable: true,
  },
];

/** How a release under test treats one child. */
type Releaser = (
  child: ThreadId,
  settled: boolean
) => Effect.Effect<
  void,
  ChildWorkspaceError | WorktreeError,
  ChildWorkspaces | Worktrees
>;

const realRelease: Releaser = (child, settled) =>
  ChildWorkspaces.use((workspaces) =>
    workspaces.release(child, () => Effect.succeed(settled))
  );

/** The broken control: a forced `Worktrees.remove` with no checks at all. */
const forcedRemove: Releaser = (child) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees;
    const row = yield* rowOf(child);

    yield* worktrees.remove(row.repoRoot, row.worktreePath, Option.none());
  });

/**
 * Runs every scenario through `release` and returns the ones it got wrong: a worktree with work
 * (or a working child) that is gone, or a removable one that is still there.
 */
const judgeRelease = (release: Releaser) =>
  Effect.gen(function* () {
    const { repo, data } = yield* setup;

    return yield* Effect.gen(function* () {
      const wrong: Array<string> = [];

      for (const [index, scenario] of scenarios.entries()) {
        const child = thread(20 + index);
        const prepared = yield* prepareIn(repo, child);

        yield* scenario.work(prepared.cwd);
        yield* release(child, scenario.settled);

        if ((yield* exists(prepared.cwd)) === scenario.removable) {
          wrong.push(scenario.name);
        }
      }

      return wrong;
    }).pipe(Effect.provide(workspacesAt(data)));
  }).pipe(Effect.scoped, Effect.provide(Platform));

describe("release never deletes a dirty or unmerged worktree", () => {
  it.live(
    "the real release keeps every worktree with work and releases the clean one",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* judgeRelease(realRelease), []);
      })
  );

  it.live("the broken control (a forced removal) fails the same judge", () =>
    Effect.gen(function* () {
      const wrong = yield* judgeRelease(forcedRemove);

      assert.deepStrictEqual(
        wrong,
        scenarios.flatMap((s) => (s.removable ? [] : [s.name]))
      );
    })
  );

  it.live(
    "releases children before ancestors, keeps the branch, and lets a kept child keep its parent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo, data } = yield* setup;
        const child = thread(40);
        const grandchild = thread(41);
        const clean = thread(42);

        yield* Effect.gen(function* () {
          const workspaces = yield* ChildWorkspaces;
          const own = yield* prepareIn(repo, child);
          const sibling = yield* prepareIn(repo, clean);

          const below = yield* workspaces.prepare({
            child: grandchild,
            parent: child,
            parentCwd: own.cwd,
            isolation: "worktree",
            base: Option.none(),
          });

          // The grandchild's base is the child's branch.
          assert.strictEqual(
            (yield* rowOf(grandchild)).baseRef,
            childBranchName(child, false)
          );

          yield* fs.writeFileString(path.join(below.cwd, "wip.txt"), "wip\n");

          const first = yield* workspaces.release(PARENT, () =>
            Effect.succeed(true)
          );

          assert.deepStrictEqual(
            first.map((result) =>
              result.kind === "kept"
                ? [result.child, result.reason]
                : [result.child, result.kind]
            ),
            [
              [grandchild, "uncommitted"],
              [child, "descendant_kept"],
              [clean, "released"],
            ]
          );
          assert.isTrue(yield* exists(own.cwd));
          assert.isTrue(yield* exists(below.cwd));
          assert.isFalse(yield* exists(sibling.cwd));
          assert.isTrue(yield* hasBranch(repo, childBranchName(clean, false)));

          // The grandchild's work is committed and merged into the child's branch: both go.
          yield* gitIn(below.cwd, ["add", "wip.txt"]);
          yield* gitIn(below.cwd, ["commit", "--quiet", "-m", "wip"]);
          yield* gitIn(own.cwd, [
            "merge",
            "--quiet",
            "--ff-only",
            childBranchName(grandchild, false),
          ]);

          // The child now has a commit main lacks, so only the grandchild is released.
          const second = yield* workspaces.release(PARENT, () =>
            Effect.succeed(true)
          );

          assert.deepStrictEqual(
            second.map((result) => [result.child, result.kind]),
            [
              [grandchild, "released"],
              [child, "kept"],
            ]
          );

          yield* gitIn(repo, [
            "merge",
            "--quiet",
            "--ff-only",
            childBranchName(child, false),
          ]);

          const third = yield* workspaces.release(PARENT, () =>
            Effect.succeed(true)
          );

          assert.deepStrictEqual(
            third.map((result) => [result.child, result.kind]),
            [[child, "released"]]
          );
          assert.isFalse(yield* exists(own.cwd));
          assert.deepStrictEqual(yield* cairnWorktrees(repo, data), []);

          const again = yield* Effect.flip(prepareIn(repo, child));

          assert.strictEqual(again.reason, "released");

          // Nothing settled: nothing released.
          const fresh = yield* prepareIn(repo, thread(43));

          const none = yield* workspaces.release(PARENT, () =>
            Effect.succeed(false)
          );

          assert.deepStrictEqual(
            none.map((result) => [result.child, result.kind]),
            [[thread(43), "kept"]]
          );
          assert.isTrue(yield* exists(fresh.cwd));
        }).pipe(Effect.provide(workspacesAt(data)));
      }).pipe(Effect.scoped, Effect.provide(Platform))
  );
});
