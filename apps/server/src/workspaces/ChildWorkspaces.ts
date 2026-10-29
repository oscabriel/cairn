// Where a subagent works (docs/phase-2/notes/subagents.md section 6). A child whose brief asks for
// a worktree (writing roles) gets its own, made from the parent's HEAD (or the brief's base) on a
// branch named from the child's thread id; a `shared` child works in its parent's cwd. Dirty edits
// in the parent's checkout are not copied (t3code's rule).
//
// The spawn calls `prepare` after Go and before the commit that creates the child, which sets the
// child's cwd to what `prepare` returned. `prepare` follows ThreadLaunch's T18 pattern: the plan
// (repository, branch, path, base) is written to `child_workspaces` before `git worktree add` runs,
// the made flags only after git says it made them, so a spawn a crash interrupted reruns into the
// same branch and path, and a plan whose spawn never landed is found by the boot repair.
//
// Nothing here ever deletes a dirty or unmerged worktree. Release and the boot repair remove a
// worktree only when it has no uncommitted or untracked file and both its branch tip and its HEAD
// are reachable from its base, and they remove it with `git worktree remove` unforced, so git
// refuses too if anything changed in between. Release keeps the branch. Descendants release
// before ancestors, and a kept descendant keeps its ancestors (after Ultimate's workspaces rule,
// github.com/HazAT/ultimate extensions/workspaces/README.md at 8b263386; ideas only, no code).

import { createHash } from "node:crypto";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import type { BriefWorkspace } from "@cairn/protocol/Policy";
import type { ChildWorktree } from "@cairn/protocol/Subagents";
import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ChildWorkspaces0012 } from "../db/migrations/0012ChildWorkspaces.ts";
import { Git } from "../git/Git.ts";
import type { GitError } from "../git/Git.ts";
import {
  WORKTREE_BRANCH_PREFIX,
  worktreePathFor,
  worktreeRepoKey,
  Worktrees,
} from "../projects/Worktrees.ts";
import type { WorktreeError } from "../projects/Worktrees.ts";
import { ChildWorkspaceStore } from "./ChildWorkspaceStore.ts";
import type {
  ChildWorkspaceRow,
  ChildWorkspaceStoreError,
} from "./ChildWorkspaceStore.ts";

/** What the spawn asks for. */
export interface PrepareChildWorkspace {
  readonly child: ThreadId;
  readonly parent: ThreadId;
  /** The parent's cwd at the spawn: the shared child's cwd, and where a worktree's base is read. */
  readonly parentCwd: string;
  readonly isolation: BriefWorkspace;
  /** The brief's base revision; none is the parent's HEAD. */
  readonly base: Option.Option<string>;
}

/** Where the child works: its cwd, and its worktree when it has one. */
export interface PreparedChildWorkspace {
  readonly cwd: string;
  /** The `worktree` of the child's `cairn.subagents` record; none for a shared child. */
  readonly worktree: Option.Option<ChildWorktree>;
}

/** Why a release kept a worktree. */
export type KeepReason =
  /** The caller says the child is still working or waiting. */
  | "not_settled"
  /** A modified, staged or untracked file is in the worktree. */
  | "uncommitted"
  /** The branch tip or the worktree's HEAD has a commit its base does not. */
  | "unmerged"
  /** The base ref no longer names a commit, so "merged" cannot be judged. */
  | "base_missing"
  /** One of the child's own children kept its worktree. */
  | "descendant_kept"
  /** `git worktree remove` (unforced) refused or failed. */
  | "git_refused";

/** What release did with one child's worktree. */
export type ReleaseResult =
  | {
      readonly kind: "released";
      readonly child: ThreadId;
      /** The branch, which stays for the parent or the user to merge or delete. */
      readonly branch: string;
    }
  | {
      readonly kind: "kept";
      readonly child: ThreadId;
      readonly reason: KeepReason;
      readonly detail: string;
    };

/** What the boot repair did with one plan whose spawn never landed. */
export type RepairResult =
  | { readonly kind: "removed"; readonly child: ThreadId }
  | {
      readonly kind: "kept";
      readonly child: ThreadId;
      readonly reason: KeepReason;
      readonly detail: string;
    };

/** A child's workspace could not be prepared, released or repaired. */
export class ChildWorkspaceError extends Schema.TaggedError<ChildWorkspaceError>()(
  "ChildWorkspaceError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals([
      /** The parent's cwd is not inside a git work tree, so no worktree can be made from it. */
      "not_a_repository",
      /** The brief's base (or the parent's HEAD) is not a commit. */
      "base_not_found",
      /** The branch named from the child's id already exists and Cairn did not plan it. */
      "branch_taken",
      /** A planned worktree exists but is not clean: a checkout a crash cut short. */
      "worktree_incomplete",
      /** The child's worktree was released; a released child is not prepared again. */
      "released",
      "git_failed",
      "store_failed",
    ]),
    /** True when running the same call again may succeed (the plan is kept). */
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** A step of `prepare` where a fault can be planted, for the kill judges. */
export type ChildWorkspaceCrashPoint =
  /** The plan row is committed; `git worktree add` has not run. */
  | "after_intent"
  /** git made the worktree; the made flags are not written. */
  | "after_add";

/** Faults planted in `prepare`; production plants none. */
export interface ChildWorkspaceFaultSet {
  /** Runs at each crash point; a judge's fixture kills its own process here. */
  crashAt(point: ChildWorkspaceCrashPoint): Effect.Effect<void>;
}

/** The faults `prepare` runs at its crash points; none unless a judge provides some. */
export const ChildWorkspaceFaults = Context.Reference<ChildWorkspaceFaultSet>(
  "cairn/server/workspaces/ChildWorkspaces/ChildWorkspaceFaults",
  { defaultValue: () => ({ crashAt: () => Effect.void }) }
);

/** The branch fragment Cairn gives children: `sub-<8 hex of the thread id's hash>`. */
export const childBranchName = (child: ThreadId, flat: boolean) => {
  const hex = createHash("sha256").update(child).digest("hex").slice(0, 8);

  return `${WORKTREE_BRANCH_PREFIX}${flat ? "-" : "/"}sub-${hex}`;
};

const gitFailed = (operation: string) => (cause: GitError | WorktreeError) =>
  new ChildWorkspaceError({
    message: `${operation} failed in git: ${cause.message}. The plan is kept; run it again.`,
    operation,
    reason: "git_failed",
    retryable: true,
    cause,
  });

const storeFailed = (operation: string) => (cause: ChildWorkspaceStoreError) =>
  new ChildWorkspaceError({
    message: cause.message,
    operation,
    reason: "store_failed",
    retryable: true,
    cause,
  });

const worktreeOf = (row: ChildWorkspaceRow): PreparedChildWorkspace => ({
  cwd: row.worktreePath,
  worktree: Option.some({
    path: row.worktreePath,
    branch: row.branch,
    baseSha: row.baseSha,
  }),
});

/** Makes, releases and repairs the worktrees subagents work in. */
export class ChildWorkspaces extends Context.Service<
  ChildWorkspaces,
  {
    /**
     * The child's cwd: the parent's for a shared child; for a worktree child, its worktree, made
     * on the first call and found on every later one (the same branch and path whatever crashed
     * in between). Fails with `ChildWorkspaceError`; a retryable failure keeps the plan.
     */
    prepare(
      input: PrepareChildWorkspace
    ): Effect.Effect<PreparedChildWorkspace, ChildWorkspaceError>;
    /** The child's worktree row, if it has one. */
    get(
      child: ThreadId
    ): Effect.Effect<Option.Option<ChildWorkspaceRow>, ChildWorkspaceError>;
    /**
     * Releases the worktrees of `root`'s descendants, deepest first, then `root`'s own: each one
     * whose child `isSettled` says is settled, with nothing uncommitted and nothing unmerged into
     * its base. A kept worktree keeps every ancestor's. Branches stay. Returns one result per
     * worktree it looked at; a thread with no worktree row has none.
     */
    release(
      root: ThreadId,
      isSettled: (child: ThreadId) => Effect.Effect<boolean>
    ): Effect.Effect<ReadonlyArray<ReleaseResult>, ChildWorkspaceError>;
    /**
     * The boot repair: for every plan whose child `landed` says does not exist (its spawn commit
     * never committed), removes the worktree and the branch git made for it, then the row, unless
     * the worktree holds work (then all three stay and the result says why).
     */
    repair(
      landed: (child: ThreadId) => Effect.Effect<boolean>
    ): Effect.Effect<ReadonlyArray<RepairResult>, ChildWorkspaceError>;
  }
>()("cairn/server/workspaces/ChildWorkspaces") {
  /** Over the ambient store, `Worktrees`, `Git` and `ServerConfig` (worktrees under its data dir). */
  static readonly layerNoDeps = Layer.effect(
    ChildWorkspaces,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const store = yield* ChildWorkspaceStore;
      const worktrees = yield* Worktrees;
      const git = yield* Git;

      const worktreesDir = path.join(config.dataDir, "worktrees");

      // Git writes and plan rows change one at a time, so a release never races a prepare.
      const writes = yield* Semaphore.make(1);

      const commitOf = (operation: string, cwd: string, ref: string) =>
        git
          .run(operation, cwd, [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            `${ref}^{commit}`,
          ])
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? Option.some(result.stdout.trim())
                : Option.none<string>()
            ),
            Effect.mapError(gitFailed(operation))
          );

      const listed = Effect.fnUntraced(function* (row: ChildWorkspaceRow) {
        const entries = yield* worktrees
          .list(row.repoRoot)
          .pipe(Effect.mapError(gitFailed("ChildWorkspaces.listed")));

        return entries.some(
          (entry) => path.resolve(entry.path) === path.resolve(row.worktreePath)
        );
      });

      // Plans the worktree on a first call: repository, base, branch and path, refusing a branch
      // Cairn did not plan. The row it writes is the plan every rerun follows.
      const planFor = Effect.fnUntraced(function* (
        input: PrepareChildWorkspace
      ) {
        const operation = "ChildWorkspaces.prepare";

        const top = yield* git
          .run(operation, input.parentCwd, ["rev-parse", "--show-toplevel"])
          .pipe(Effect.mapError(gitFailed(operation)));

        if (top.exitCode !== 0 || top.stdout.trim() === "") {
          return yield* new ChildWorkspaceError({
            message: `ChildWorkspaces.prepare cannot make a worktree for ${input.child}: ${input.parentCwd} is not inside a git repository. Spawn it with workspace "shared", or start the parent in a repository.`,
            operation,
            reason: "not_a_repository",
            retryable: false,
          });
        }

        const repoRoot = path.resolve(top.stdout.trim());
        const baseRevision = Option.getOrElse(input.base, () => "HEAD");

        const baseSha = yield* commitOf(
          operation,
          input.parentCwd,
          baseRevision
        );

        if (Option.isNone(baseSha)) {
          return yield* new ChildWorkspaceError({
            message: `ChildWorkspaces.prepare cannot make a worktree for ${input.child}: ${baseRevision} is not a commit in ${repoRoot}. Name a branch or commit that exists as the brief's base.`,
            operation,
            reason: "base_not_found",
            retryable: false,
          });
        }

        const baseRef = Option.isSome(input.base)
          ? input.base.value
          : Option.getOrElse(
              yield* worktrees.currentBranch(input.parentCwd),
              () => baseSha.value
            );

        const flat = yield* worktrees
          .branchExists(repoRoot, WORKTREE_BRANCH_PREFIX)
          .pipe(Effect.mapError(gitFailed(operation)));

        const branch = childBranchName(input.child, flat);

        // A branch that exists before the plan is someone else's; the plan never adopts it, so
        // everything at the planned branch and path afterwards is Cairn's.
        if (
          yield* worktrees
            .branchExists(repoRoot, branch)
            .pipe(Effect.mapError(gitFailed(operation)))
        ) {
          return yield* new ChildWorkspaceError({
            message: `ChildWorkspaces.prepare cannot make a worktree for ${input.child}: the branch ${branch} already exists in ${repoRoot} and Cairn did not plan it. Rename or delete that branch, then spawn again.`,
            operation,
            reason: "branch_taken",
            retryable: false,
          });
        }

        return yield* store
          .plan({
            child: input.child,
            parent: input.parent,
            repoRoot,
            worktreePath: worktreePathFor(
              worktreesDir,
              worktreeRepoKey(repoRoot),
              branch
            ),
            branch,
            baseSha: baseSha.value,
            baseRef,
            state: "planned",
            worktreeCreated: false,
            branchCreated: false,
          })
          .pipe(Effect.mapError(storeFailed(operation)));
      });

      const isClean = Effect.fnUntraced(function* (
        operation: string,
        worktreePath: string
      ) {
        const status = yield* git
          .stdout(operation, worktreePath, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "-z",
          ])
          .pipe(Effect.mapError(gitFailed(operation)));

        return status === "";
      });

      const prepareWorktree = Effect.fnUntraced(function* (
        input: PrepareChildWorkspace
      ) {
        const operation = "ChildWorkspaces.prepare";
        const faults = yield* ChildWorkspaceFaults;

        const found = yield* store
          .get(input.child)
          .pipe(Effect.mapError(storeFailed(operation)));

        const row = Option.isSome(found) ? found.value : yield* planFor(input);

        if (row.state === "released") {
          return yield* new ChildWorkspaceError({
            message: `ChildWorkspaces.prepare will not prepare ${input.child} again: its worktree was released (its branch ${row.branch} stays). Spawn a new child instead.`,
            operation,
            reason: "released",
            retryable: false,
          });
        }

        if (row.state === "ready") {
          return worktreeOf(row);
        }

        yield* faults.crashAt("after_intent");

        const made = yield* worktrees
          .create({
            repoRoot: row.repoRoot,
            worktreesDir,
            baseRef: row.baseSha,
            startFromOrigin: false,
            branch: row.branch,
          })
          .pipe(Effect.mapError(gitFailed(operation)));

        // Found rather than made: an earlier attempt's checkout, which a kill may have cut short.
        if (!made.created && !(yield* isClean(operation, made.worktreePath))) {
          return yield* new ChildWorkspaceError({
            message: `ChildWorkspaces.prepare found ${made.worktreePath} for ${input.child} with changes before the child ever ran: a checkout a crash cut short. Nothing was removed; inspect it, remove it with git worktree remove, then spawn again.`,
            operation,
            reason: "worktree_incomplete",
            retryable: false,
          });
        }

        yield* faults.crashAt("after_add");

        // The plan refused a branch that existed before it, so what git made or found here is
        // this plan's own, whichever attempt made it.
        const ready: ChildWorkspaceRow = {
          ...row,
          worktreePath: made.worktreePath,
          state: "ready",
          worktreeCreated: true,
          branchCreated: true,
        };

        yield* store
          .update(ready)
          .pipe(Effect.mapError(storeFailed(operation)));

        return worktreeOf(ready);
      });

      const prepare = Effect.fn("ChildWorkspaces.prepare")(function* (
        input: PrepareChildWorkspace
      ) {
        if (input.isolation === "shared") {
          return { cwd: input.parentCwd, worktree: Option.none() };
        }

        return yield* writes.withPermits(1)(prepareWorktree(input));
      });

      const get = Effect.fn("ChildWorkspaces.get")(function* (child: ThreadId) {
        return yield* store
          .get(child)
          .pipe(Effect.mapError(storeFailed("ChildWorkspaces.get")));
      });

      // Why the worktree must stay, if it must: uncommitted files, or a commit on its branch or its
      // HEAD that its base does not have. None means removing it loses nothing.
      const workAtRisk = Effect.fnUntraced(function* (
        operation: string,
        row: ChildWorkspaceRow,
        present: boolean
      ) {
        if (present && !(yield* isClean(operation, row.worktreePath))) {
          return Option.some({
            reason: "uncommitted" as const,
            detail: `${row.worktreePath} has uncommitted or untracked files.`,
          });
        }

        const base = yield* commitOf(operation, row.repoRoot, row.baseRef);

        if (Option.isNone(base)) {
          return Option.some({
            reason: "base_missing" as const,
            detail: `Its base ${row.baseRef} no longer names a commit in ${row.repoRoot}.`,
          });
        }

        const tips = [
          yield* commitOf(operation, row.repoRoot, `refs/heads/${row.branch}`),
          present
            ? yield* commitOf(operation, row.worktreePath, "HEAD")
            : Option.none<string>(),
        ];

        for (const tip of tips) {
          if (Option.isSome(tip)) {
            const merged = yield* git
              .run(operation, row.repoRoot, [
                "merge-base",
                "--is-ancestor",
                tip.value,
                base.value,
              ])
              .pipe(Effect.mapError(gitFailed(operation)));

            if (merged.exitCode !== 0) {
              return Option.some({
                reason: "unmerged" as const,
                detail: `${tip.value.slice(0, 12)} on ${row.branch} is not in its base ${row.baseRef}.`,
              });
            }
          }
        }

        return Option.none<{ reason: KeepReason; detail: string }>();
      });

      // `git worktree remove` without --force: git itself refuses a worktree with changes.
      const removeUnforced = Effect.fnUntraced(function* (
        operation: string,
        row: ChildWorkspaceRow
      ) {
        const result = yield* git
          .run(operation, row.repoRoot, [
            "worktree",
            "remove",
            "--",
            row.worktreePath,
          ])
          .pipe(Effect.mapError(gitFailed(operation)));

        return result.exitCode === 0
          ? Option.none<string>()
          : Option.some(result.stderr.trim());
      });

      const releaseOne = Effect.fnUntraced(function* (
        row: ChildWorkspaceRow,
        settled: boolean
      ) {
        const operation = "ChildWorkspaces.release";

        const kept = (reason: KeepReason, detail: string): ReleaseResult => ({
          kind: "kept",
          child: row.child,
          reason,
          detail,
        });

        if (!settled) {
          return kept(
            "not_settled",
            `${row.child} is still working or waiting.`
          );
        }

        const present = yield* listed(row);
        const risk = yield* workAtRisk(operation, row, present);

        if (Option.isSome(risk)) {
          return kept(risk.value.reason, risk.value.detail);
        }

        if (present) {
          const refused = yield* removeUnforced(operation, row);

          if (Option.isSome(refused)) {
            return kept("git_refused", refused.value);
          }
        }

        yield* store
          .update({ ...row, state: "released" })
          .pipe(Effect.mapError(storeFailed(operation)));

        yield* Effect.logInfo("child worktree released").pipe(
          Effect.annotateLogs({
            event: "child_workspace_released",
            child: row.child,
            branch: row.branch,
          })
        );

        const released: ReleaseResult = {
          kind: "released",
          child: row.child,
          branch: row.branch,
        };

        return released;
      });

      // Post-order over the rows below `parent`: every child's subtree before the child itself.
      const releaseBelow = (
        parent: ThreadId,
        isSettled: (child: ThreadId) => Effect.Effect<boolean>,
        results: Array<ReleaseResult>
      ): Effect.Effect<boolean, ChildWorkspaceError> =>
        Effect.gen(function* () {
          const rows = yield* store
            .children(parent)
            .pipe(Effect.mapError(storeFailed("ChildWorkspaces.release")));

          let anyKept = false;

          for (const row of rows) {
            const keptBelow = yield* releaseBelow(
              row.child,
              isSettled,
              results
            );

            if (row.state === "released") {
              anyKept ||= keptBelow;
            } else {
              const result = keptBelow
                ? {
                    kind: "kept" as const,
                    child: row.child,
                    reason: "descendant_kept" as const,
                    detail: `A child of ${row.child} kept its worktree.`,
                  }
                : yield* releaseOne(row, yield* isSettled(row.child));

              results.push(result);
              anyKept ||= result.kind === "kept";
            }
          }

          return anyKept;
        });

      const release = Effect.fn("ChildWorkspaces.release")(function* (
        root: ThreadId,
        isSettled: (child: ThreadId) => Effect.Effect<boolean>
      ) {
        return yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const results: Array<ReleaseResult> = [];
            const keptBelow = yield* releaseBelow(root, isSettled, results);

            const own = yield* store
              .get(root)
              .pipe(Effect.mapError(storeFailed("ChildWorkspaces.release")));

            if (Option.isSome(own) && own.value.state !== "released") {
              results.push(
                keptBelow
                  ? {
                      kind: "kept",
                      child: root,
                      reason: "descendant_kept",
                      detail: `A child of ${root} kept its worktree.`,
                    }
                  : yield* releaseOne(own.value, yield* isSettled(root))
              );
            }

            return results;
          })
        );
      });

      const repairOne = Effect.fnUntraced(function* (row: ChildWorkspaceRow) {
        const operation = "ChildWorkspaces.repair";
        const present = yield* listed(row);
        const risk = yield* workAtRisk(operation, row, present);

        if (Option.isSome(risk)) {
          const kept: RepairResult = {
            kind: "kept",
            child: row.child,
            reason: risk.value.reason,
            detail: risk.value.detail,
          };

          return kept;
        }

        if (present) {
          const refused = yield* removeUnforced(operation, row);

          if (Option.isSome(refused)) {
            const kept: RepairResult = {
              kind: "kept",
              child: row.child,
              reason: "git_refused",
              detail: refused.value,
            };

            return kept;
          }
        }

        // The branch goes only while it still points at the plan's base: no commit of its own.
        yield* git
          .run(operation, row.repoRoot, [
            "update-ref",
            "-d",
            `refs/heads/${row.branch}`,
            row.baseSha,
          ])
          .pipe(Effect.mapError(gitFailed(operation)));

        yield* store
          .remove(row.child)
          .pipe(Effect.mapError(storeFailed(operation)));

        const removed: RepairResult = { kind: "removed", child: row.child };

        return removed;
      });

      const repair = Effect.fn("ChildWorkspaces.repair")(function* (
        landed: (child: ThreadId) => Effect.Effect<boolean>
      ) {
        return yield* writes.withPermits(1)(
          Effect.gen(function* () {
            const rows = yield* store.listOpen.pipe(
              Effect.mapError(storeFailed("ChildWorkspaces.repair"))
            );

            const results: Array<RepairResult> = [];

            for (const row of rows) {
              if (!(yield* landed(row.child))) {
                const result = yield* repairOne(row);

                yield* result.kind === "removed"
                  ? Effect.logInfo("child workspace removed").pipe(
                      Effect.annotateLogs({
                        event: "child_workspace_removed",
                        child: row.child,
                        branch: row.branch,
                      })
                    )
                  : Effect.logWarning("child workspace kept").pipe(
                      Effect.annotateLogs({
                        event: "child_workspace_kept",
                        child: row.child,
                        branch: row.branch,
                        reason: result.reason,
                        detail: result.detail,
                      })
                    );

                results.push(result);
              }
            }

            return results;
          })
        );
      });

      return ChildWorkspaces.of({ prepare, get, release, repair });
    })
  );

  /** Over `cairn.sqlite`'s `SqlClient` and `ServerConfig` from the root, with Node's git and files. */
  static readonly layer = ChildWorkspaces.layerNoDeps.pipe(
    Layer.provide(ChildWorkspaceStore.layerNoDeps),
    Layer.provide(Worktrees.layerNoDeps),
    Layer.provide(Git.layer),
    Layer.provide(NodeServices.layer)
  );

  /**
   * For tests and judges that build a brain: a fresh migrated in-memory `cairn.sqlite`, and
   * worktrees under a fresh temporary data folder.
   */
  static readonly layerTest = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const dataDir = yield* fs.makeTempDirectory({
        prefix: "cairn-children-",
      });

      return ChildWorkspaces.layer.pipe(
        Layer.provide(
          Database.layerTest({
            ...migrations,
            "0012_ChildWorkspaces": ChildWorkspaces0012,
          })
        ),
        Layer.provide(ServerConfig.layerWith({ dataDir }))
      );
    })
  ).pipe(Layer.provide(NodeServices.layer), Layer.orDie);
}
