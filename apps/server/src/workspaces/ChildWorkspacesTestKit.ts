// What the child workspace tests share: a temporary repository, a brain's `cairn.sqlite` on disk
// (so a second build of the layer is a restart), and the checks the judges count with.

import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { Effect, FileSystem, Layer, Option } from "effect";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ChildWorkspaces0012 } from "../db/migrations/0012ChildWorkspaces.ts";
import { Git } from "../git/Git.ts";
import { Worktrees } from "../projects/Worktrees.ts";
import { COMMIT_OPTIONS } from "../threads/ThreadsTestKit.ts";
import { ChildWorkspaces } from "./ChildWorkspaces.ts";
import { ChildWorkspaceStore } from "./ChildWorkspaceStore.ts";

/** Every migration, with this package's 0012 until the integrator lists it. */
export const testMigrations = {
  ...migrations,
  "0012_ChildWorkspaces": ChildWorkspaces0012,
};

/** One brain's workspaces over `<dataDir>/cairn.sqlite`: building it again is a restart. */
export const workspacesAt = (dataDir: string) =>
  ChildWorkspaces.layerNoDeps.pipe(
    Layer.provideMerge(ChildWorkspaceStore.layerNoDeps),
    Layer.provideMerge(Worktrees.layerNoDeps),
    Layer.provide(
      Database.layer({
        filename: path.join(dataDir, "cairn.sqlite"),
        migrations: testMigrations,
      })
    ),
    Layer.provide(ServerConfig.layerWith({ dataDir }))
  );

/** A thread id for case `n`. */
export const thread = (n: number) =>
  ThreadId.make(
    `0190f0c0-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`
  );

/** Runs git in `cwd` with the test identity, returning stdout. */
export const gitIn = (cwd: string, args: ReadonlyArray<string>) =>
  Git.use((git) => git.stdout("test", cwd, [...COMMIT_OPTIONS, ...args]));

/** A repository at `<dir>/repo` on `main` with one commit holding `README.md`. */
export const makeRepo = Effect.fn("ChildWorkspacesTestKit.makeRepo")(function* (
  dir: string
) {
  const fs = yield* FileSystem.FileSystem;
  const repo = path.join(dir, "repo");

  yield* gitIn(dir, ["init", "--quiet", "-b", "main", repo]);
  yield* fs.writeFileString(path.join(repo, "README.md"), "hello\n");
  yield* gitIn(repo, ["add", "README.md"]);
  yield* gitIn(repo, ["commit", "--quiet", "-m", "init"]);

  return repo;
});

/** Writes `file` in `cwd` and commits it; returns the new commit. */
export const commitFile = Effect.fn("ChildWorkspacesTestKit.commitFile")(
  function* (cwd: string, file: string, text: string) {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.writeFileString(path.join(cwd, file), text);
    yield* gitIn(cwd, ["add", file]);
    yield* gitIn(cwd, ["commit", "--quiet", "-m", `add ${file}`]);

    return (yield* gitIn(cwd, ["rev-parse", "HEAD"])).trim();
  }
);

/** Whether a local branch exists. */
export const hasBranch = (repo: string, branch: string) =>
  Git.use((git) =>
    git.run("test", repo, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ])
  ).pipe(Effect.map((result) => result.exitCode === 0));

/** The worktrees git lists for `repo` under `<dataDir>/worktrees`. */
export const cairnWorktrees = Effect.fn(
  "ChildWorkspacesTestKit.cairnWorktrees"
)(function* (repo: string, dataDir: string) {
  const worktrees = yield* Worktrees;
  const own = `${path.join(dataDir, "worktrees")}${path.sep}`;

  return (yield* worktrees.list(repo))
    .map((entry) => path.resolve(entry.path))
    .filter((entry) => entry.startsWith(own));
});

/**
 * Orphans: worktrees under Cairn's folder and `cairn/sub-*` branches that no open plan row
 * accounts for. After a boot repair there must be none.
 */
export const orphansOf = Effect.fn("ChildWorkspacesTestKit.orphansOf")(
  function* (repo: string, dataDir: string) {
    const store = yield* ChildWorkspaceStore;
    const rows = yield* store.listOpen;
    const listed = yield* cairnWorktrees(repo, dataDir);

    const branches = (yield* gitIn(repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/cairn",
      "refs/heads/cairn-sub-*",
    ]))
      .split("\n")
      .filter((name) => name !== "");

    return [
      ...listed.filter(
        (entry) => !rows.some((row) => path.resolve(row.worktreePath) === entry)
      ),
      ...branches.filter((name) => !rows.some((row) => row.branch === name)),
    ];
  }
);

/** Whether the folder exists. */
export const exists = (file: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(file)).pipe(
    Effect.orElseSucceed(() => false)
  );

/** The child's row, failing the test when it has none. */
export const rowOf = (child: ThreadId) =>
  ChildWorkspaces.use((workspaces) => workspaces.get(child)).pipe(
    Effect.map(Option.getOrThrow)
  );
