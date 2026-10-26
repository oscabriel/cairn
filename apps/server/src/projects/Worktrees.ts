// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// packages/shared/src/git.ts (`WORKTREE_BRANCH_PREFIX`, `sanitizeBranchFragment`,
// `buildTemporaryWorktreeBranchName`, `flattenTemporaryWorktreeBranchName`,
// `isTemporaryWorktreeBranch`) and apps/server/src/vcs/GitVcsDriverCore.ts (`createWorktree`, lines
// 3686 to 3800; `branchExists` and `resolveAvailableBranchName`, 1199 to 1236; the rename behind
// `renameBranch`). Kept: a thread's worktree gets a temporary `<prefix>/<8 hex>` branch, flattened to
// `<prefix>-<8 hex>` when a plain `<prefix>` branch blocks the folder form;
// `git worktree add -b <branch> -- <path> <start>`
// with the repository's `checkout.workers`; a rename takes the first free name of `name`,
// `name-1` ... `name-100`. Changed: the prefix is `cairn`; Linux only; no progress parsing,
// submodules or project scripts; every call goes through Cairn's `Git` with its safe options; and
// the legacy `t3code` temporary names are not recognised. The worktree folder is
// `<worktrees>/<repo>-<8 hex of the repo's path>/<branch with / as ->`, so two repositories with
// one folder name never share a folder, and `remove` deletes a folder only when git lists it as a
// worktree of that repository (T18).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { createHash } from "node:crypto";
import path from "node:path";

import type { Branch, BranchesResult } from "@cairn/protocol/Projects";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Random,
  Schema,
} from "effect";

import { Git, GIT_DEFAULTS } from "../git/Git.ts";
import type { GitError } from "../git/Git.ts";

/** The namespace of the temporary branches Cairn gives new worktrees. */
export const WORKTREE_BRANCH_PREFIX = "cairn";

/** How long `git worktree add` may take: a large checkout is slow on a cold cache. */
const WORKTREE_ADD_TIMEOUT = Duration.minutes(10);

/** How long a fetch of the base branch may take. */
const FETCH_TIMEOUT = Duration.minutes(2);

const TEMPORARY_BRANCH = new RegExp(
  `^${WORKTREE_BRANCH_PREFIX}[-/][0-9a-f]{8}$`,
  "u"
);

/**
 * A branch fragment from free text: lowercase, runs of anything but letters, digits, `/`, `_` and
 * `-` as one `-`, at most 64 characters, `update` when nothing is left.
 */
export const sanitizeBranchFragment = (raw: string) => {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replaceAll(/['"`]/gu, "")
    .replaceAll(/^[./\s_-]+|[./\s_-]+$/gu, "");

  const fragment = normalized
    .replaceAll(/[^a-z0-9/_-]+/gu, "-")
    .replaceAll(/\/+/gu, "/")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^[./_-]+|[./_-]+$/gu, "")
    .slice(0, 64)
    .replace(/[./_-]+$/u, "");

  return fragment.length > 0 ? fragment : "update";
};

/** `cairn/<hex>` from eight hex characters. */
export const buildTemporaryWorktreeBranchName = (hex: string) =>
  `${WORKTREE_BRANCH_PREFIX}/${hex
    .toLowerCase()
    .replaceAll(/[^0-9a-f]/gu, "")
    .slice(0, 8)}`;

/**
 * Git stores refs as paths, so a plain `cairn` branch makes every `cairn/<hex>` ref impossible.
 * This moves a temporary name to the flat `cairn-<hex>` sibling.
 */
export const flattenTemporaryWorktreeBranchName = (refName: string) => {
  const normalized = refName.trim().toLowerCase();
  const tokenStart = normalized.search(/[-/]/u) + 1;

  return `${WORKTREE_BRANCH_PREFIX}-${normalized.slice(tokenStart, tokenStart + 8)}`;
};

/** Whether `refName` is a temporary branch Cairn made, which a rename may replace. */
export const isTemporaryWorktreeBranch = (refName: string) =>
  TEMPORARY_BRANCH.test(refName.trim().toLowerCase());

/** The folder name a repository's worktrees live under: its name and a short hash of its path. */
export const worktreeRepoKey = (repoRoot: string) => {
  const resolved = path.resolve(repoRoot);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);

  return `${path.basename(resolved)}-${hash}`;
};

/** Where a worktree for `branch` of the repository keyed `repoName` lives. */
export const worktreePathFor = (
  worktreesDir: string,
  repoName: string,
  branch: string
) => path.join(worktreesDir, repoName, branch.replaceAll("/", "-"));

/** A worktree operation failed. Nothing it would have made is left behind, unless it says so. */
export class WorktreeError extends Schema.TaggedError<WorktreeError>()(
  "WorktreeError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals([
      /** The base ref does not resolve to a commit. */
      "base_not_found",
      /** The branch name is not one git accepts. */
      "invalid_branch",
      /** The path is not a worktree of the repository. */
      "not_a_worktree",
      /** Every candidate branch name is taken. */
      "no_free_branch",
      "git_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** A worktree as `git worktree list` reports it. */
export interface WorktreeEntry {
  readonly path: string;
  readonly branch: Option.Option<string>;
}

/** What `create` asks for. */
export interface CreateWorktree {
  /** The repository's own checkout (the project root). */
  readonly repoRoot: string;
  /** The folder holding every repository's worktrees. */
  readonly worktreesDir: string;
  readonly baseRef: string;
  /** Fetch `origin <baseRef>` first and start from `origin/<baseRef>`. */
  readonly startFromOrigin: boolean;
  /** The branch the worktree checks out: a new one from the base, or an existing one. */
  readonly branch: string;
}

/** A worktree `create` made or found. */
export interface CreatedWorktree {
  readonly worktreePath: string;
  readonly branch: string;
  /** False when the worktree was already there (a resumed launch). */
  readonly created: boolean;
  /** True when `create` made the branch (so removing the worktree removes it too). */
  readonly branchCreated: boolean;
}

const gitFailed = (operation: string) => (cause: GitError) =>
  new WorktreeError({
    message: cause.message,
    operation,
    reason: "git_failed",
    cause,
  });

const parseWorktreeList = (porcelain: string): ReadonlyArray<WorktreeEntry> =>
  porcelain
    .split("\0\0")
    .map((block) => block.split("\0"))
    .flatMap((lines) => {
      const worktree = lines.find((line) => line.startsWith("worktree "));

      if (worktree === undefined) {
        return [];
      }

      const branch = lines.find((line) => line.startsWith("branch "));

      return [
        {
          path: worktree.slice("worktree ".length),
          branch: Option.map(Option.fromNullishOr(branch), (line) =>
            line.slice("branch ".length).replace(/^refs\/heads\//u, "")
          ),
        },
      ];
    });

const aheadOf = (track: string) =>
  Option.map(
    Option.fromNullishOr(/ahead (?<count>\d+)/u.exec(track)?.groups?.count),
    Number
  );

/** Creates, finds, renames and removes the worktrees threads run in. */
export class Worktrees extends Context.Service<
  Worktrees,
  {
    /** Whether `cwd` is inside a git work tree. */
    isRepository(cwd: string): Effect.Effect<boolean>;
    /** The checked-out branch of `cwd`; none when detached or not a checkout. */
    currentBranch(cwd: string): Effect.Effect<Option.Option<string>>;
    /** Whether a local branch named `name` exists in the repository at `cwd`. */
    branchExists(
      cwd: string,
      name: string
    ): Effect.Effect<boolean, WorktreeError>;
    /** `desired`, or the first of `desired-1` ... `desired-100` no branch has. */
    availableBranchName(
      cwd: string,
      desired: string
    ): Effect.Effect<string, WorktreeError>;
    /** A fresh `cairn/<8 hex>` (or `cairn-<8 hex>`) branch name no branch has yet. */
    temporaryBranchName(cwd: string): Effect.Effect<string, WorktreeError>;
    /**
     * Makes the worktree for `input.branch` at its standard path, or finds it already there.
     * Fails with `base_not_found` when the base ref is no commit; a failed add leaves nothing.
     */
    create(
      input: CreateWorktree
    ): Effect.Effect<CreatedWorktree, WorktreeError>;
    /** Removes a worktree (forced), and its branch when `deleteBranch`. Missing ones are fine. */
    remove(
      repoRoot: string,
      worktreePath: string,
      deleteBranch: Option.Option<string>
    ): Effect.Effect<void, WorktreeError>;
    /** Renames `from` to the first free name for `desired`; returns the name it took. */
    renameBranch(
      cwd: string,
      from: string,
      desired: string
    ): Effect.Effect<string, WorktreeError>;
    /** The worktrees of the repository at `repoRoot`, its own checkout first. */
    list(
      repoRoot: string
    ): Effect.Effect<ReadonlyArray<WorktreeEntry>, WorktreeError>;
    /** Whether `worktreePath` is a checkout of the same repository as `repoRoot`. */
    isWorktreeOf(
      repoRoot: string,
      worktreePath: string
    ): Effect.Effect<boolean>;
    /** The branches a new worktree can start from, local first, with the default marked. */
    branches(cwd: string): Effect.Effect<BranchesResult, WorktreeError>;
  }
>()("cairn/server/projects/Worktrees") {
  /** Over the ambient `Git` and `FileSystem`. */
  static readonly layerNoDeps = Layer.effect(
    Worktrees,
    Effect.gen(function* () {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;

      const isRepository = (cwd: string) =>
        git
          .run("Worktrees.isRepository", cwd, [
            "rev-parse",
            "--is-inside-work-tree",
          ])
          .pipe(
            Effect.map(
              (result) =>
                result.exitCode === 0 && result.stdout.trim() === "true"
            ),
            Effect.orElseSucceed(() => false)
          );

      const currentBranch = (cwd: string) =>
        git
          .stdout("Worktrees.currentBranch", cwd, ["branch", "--show-current"])
          .pipe(
            Effect.map((out) =>
              Option.filter(Option.some(out.trim()), (name) => name !== "")
            ),
            Effect.orElseSucceed(() => Option.none<string>())
          );

      const branchExists = (cwd: string, name: string) =>
        git
          .run("Worktrees.branchExists", cwd, [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${name}`,
          ])
          .pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.mapError(gitFailed("Worktrees.branchExists"))
          );

      const availableBranchName = Effect.fn("Worktrees.availableBranchName")(
        function* (cwd: string, desired: string) {
          for (let suffix = 0; suffix <= 100; suffix += 1) {
            const candidate =
              suffix === 0 ? desired : `${desired}-${String(suffix)}`;

            if (!(yield* branchExists(cwd, candidate))) {
              return candidate;
            }
          }

          return yield* new WorktreeError({
            message: `Worktrees could not find a free branch name for ${desired}: it and ${desired}-1 to ${desired}-100 are all taken.`,
            operation: "Worktrees.availableBranchName",
            reason: "no_free_branch",
          });
        }
      );

      const randomHex = Effect.gen(function* () {
        const high = yield* Random.nextIntBetween(0, 0xff_ff);
        const low = yield* Random.nextIntBetween(0, 0xff_ff);

        return (
          high.toString(16).padStart(4, "0") + low.toString(16).padStart(4, "0")
        );
      });

      const temporaryBranchName = Effect.fn("Worktrees.temporaryBranchName")(
        function* (cwd: string) {
          const flat = yield* branchExists(cwd, WORKTREE_BRANCH_PREFIX);

          for (let attempt = 0; attempt < 16; attempt += 1) {
            const name = buildTemporaryWorktreeBranchName(yield* randomHex);

            const candidate = flat
              ? flattenTemporaryWorktreeBranchName(name)
              : name;

            if (!(yield* branchExists(cwd, candidate))) {
              return candidate;
            }
          }

          return yield* new WorktreeError({
            message:
              "Worktrees drew 16 temporary branch names that were all taken. Retry the launch.",
            operation: "Worktrees.temporaryBranchName",
            reason: "no_free_branch",
          });
        }
      );

      const list = Effect.fn("Worktrees.list")(function* (repoRoot: string) {
        const out = yield* git
          .stdout("Worktrees.list", repoRoot, [
            "worktree",
            "list",
            "--porcelain",
            "-z",
          ])
          .pipe(Effect.mapError(gitFailed("Worktrees.list")));

        return parseWorktreeList(out);
      });

      const commonDir = (cwd: string) =>
        git
          .stdout("Worktrees.commonDir", cwd, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])
          .pipe(
            Effect.map((out) => Option.some(path.resolve(out.trim()))),
            Effect.orElseSucceed(() => Option.none<string>())
          );

      const isWorktreeOf = Effect.fn("Worktrees.isWorktreeOf")(function* (
        repoRoot: string,
        worktreePath: string
      ) {
        const [own, other] = yield* Effect.all([
          commonDir(repoRoot),
          commonDir(worktreePath),
        ]);

        return (
          Option.isSome(own) &&
          Option.isSome(other) &&
          own.value === other.value
        );
      });

      const checkBranchName = Effect.fn("Worktrees.checkBranchName")(function* (
        cwd: string,
        name: string
      ) {
        const result = yield* git
          .run("Worktrees.checkBranchName", cwd, [
            "check-ref-format",
            "--branch",
            name,
          ])
          .pipe(Effect.mapError(gitFailed("Worktrees.checkBranchName")));

        if (result.exitCode !== 0 || name.startsWith("-")) {
          return yield* new WorktreeError({
            message: `${name} is not a branch name git accepts. Pick another name.`,
            operation: "Worktrees.checkBranchName",
            reason: "invalid_branch",
          });
        }

        return name;
      });

      const create = Effect.fn("Worktrees.create")(function* (
        input: CreateWorktree
      ) {
        const { repoRoot } = input;

        const plannedPath = worktreePathFor(
          input.worktreesDir,
          worktreeRepoKey(repoRoot),
          input.branch
        );

        yield* checkBranchName(repoRoot, input.branch);

        const worktrees = yield* list(repoRoot);
        const ownDir = `${path.resolve(input.worktreesDir)}${path.sep}`;

        // The planned folder, or this branch's worktree in Cairn's folder under an older layout.
        const existing =
          worktrees.find((entry) => path.resolve(entry.path) === plannedPath) ??
          worktrees.find(
            (entry) =>
              path.resolve(entry.path).startsWith(ownDir) &&
              Option.contains(entry.branch, input.branch)
          );

        const worktreePath =
          existing === undefined ? plannedPath : path.resolve(existing.path);

        if (existing !== undefined) {
          if (!Option.contains(existing.branch, input.branch)) {
            return yield* new WorktreeError({
              message: `${worktreePath} is already a worktree of another branch. Remove it or pick another branch.`,
              operation: "Worktrees.create",
              reason: "not_a_worktree",
            });
          }

          return {
            worktreePath,
            branch: input.branch,
            created: false,
            branchCreated: false,
          };
        }

        if (input.startFromOrigin) {
          yield* git
            .stdoutWith(
              "Worktrees.create",
              repoRoot,
              ["fetch", "--quiet", "origin", "--", input.baseRef],
              { ...GIT_DEFAULTS, timeout: FETCH_TIMEOUT }
            )
            .pipe(Effect.mapError(gitFailed("Worktrees.create")));
        }

        const startRef = input.startFromOrigin
          ? `origin/${input.baseRef}`
          : input.baseRef;

        const base = yield* git
          .run("Worktrees.create", repoRoot, [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            `${startRef}^{commit}`,
          ])
          .pipe(Effect.mapError(gitFailed("Worktrees.create")));

        if (base.exitCode !== 0) {
          return yield* new WorktreeError({
            message: `The base ${startRef} is not a commit in ${repoRoot}. Pick a branch that exists${input.startFromOrigin ? " on origin" : ""}.`,
            operation: "Worktrees.create",
            reason: "base_not_found",
          });
        }

        const branchCreated = !(yield* branchExists(repoRoot, input.branch));

        const workers = yield* git
          .run("Worktrees.create", repoRoot, [
            "config",
            "--get",
            "checkout.workers",
          ])
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 && result.stdout.trim() !== ""
                ? result.stdout.trim()
                : "0"
            ),
            Effect.mapError(gitFailed("Worktrees.create"))
          );

        yield* fs
          .makeDirectory(path.dirname(worktreePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorktreeError({
                  message: `Worktrees could not create ${path.dirname(worktreePath)}: ${cause.message}. Check the data folder's permissions and free space.`,
                  operation: "Worktrees.create",
                  reason: "git_failed",
                  cause,
                })
            )
          );

        const args = branchCreated
          ? [
              "worktree",
              "add",
              "-b",
              input.branch,
              "--",
              worktreePath,
              startRef,
            ]
          : ["worktree", "add", "--", worktreePath, input.branch];

        yield* git
          .stdoutWith(
            "Worktrees.create",
            repoRoot,
            ["-c", `checkout.workers=${workers}`, ...args],
            { ...GIT_DEFAULTS, timeout: WORKTREE_ADD_TIMEOUT }
          )
          .pipe(Effect.mapError(gitFailed("Worktrees.create")));

        return {
          worktreePath,
          branch: input.branch,
          created: true,
          branchCreated,
        };
      });

      const remove = Effect.fn("Worktrees.remove")(function* (
        repoRoot: string,
        worktreePath: string,
        deleteBranch: Option.Option<string>
      ) {
        const known = (yield* list(repoRoot)).some(
          (entry) => path.resolve(entry.path) === path.resolve(worktreePath)
        );

        if (known) {
          yield* git
            .stdout("Worktrees.remove", repoRoot, [
              "worktree",
              "remove",
              "--force",
              "--force",
              "--",
              worktreePath,
            ])
            .pipe(Effect.mapError(gitFailed("Worktrees.remove")));
        }

        // Only a folder git lists for this repository is deleted: one it does not list may be
        // another repository's, or the user's (T18).
        if (known) {
          yield* fs
            .remove(worktreePath, { recursive: true, force: true })
            .pipe(Effect.ignore);
        }

        yield* git
          .run("Worktrees.remove", repoRoot, ["worktree", "prune"])
          .pipe(Effect.ignore);

        if (Option.isSome(deleteBranch)) {
          yield* git
            .run("Worktrees.remove", repoRoot, [
              "branch",
              "-D",
              "--",
              deleteBranch.value,
            ])
            .pipe(Effect.mapError(gitFailed("Worktrees.remove")));
        }
      });

      const renameBranch = Effect.fn("Worktrees.renameBranch")(function* (
        cwd: string,
        from: string,
        desired: string
      ) {
        yield* checkBranchName(cwd, desired);

        const target = yield* availableBranchName(cwd, desired);

        yield* git
          .stdout("Worktrees.renameBranch", cwd, [
            "branch",
            "-m",
            "--",
            from,
            target,
          ])
          .pipe(Effect.mapError(gitFailed("Worktrees.renameBranch")));

        return target;
      });

      const defaultBranch = Effect.fnUntraced(function* (cwd: string) {
        const head = yield* git
          .run("Worktrees.branches", cwd, [
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
          ])
          .pipe(Effect.mapError(gitFailed("Worktrees.branches")));

        if (head.exitCode === 0 && head.stdout.trim() !== "") {
          return Option.some(head.stdout.trim().replace(/^origin\//u, ""));
        }

        for (const candidate of ["main", "master"]) {
          if (yield* branchExists(cwd, candidate)) {
            return Option.some(candidate);
          }
        }

        return Option.none<string>();
      });

      const branches = Effect.fn("Worktrees.branches")(function* (cwd: string) {
        if (!(yield* isRepository(cwd))) {
          return { current: Option.none<string>(), branches: [] };
        }

        const out = yield* git
          .stdout("Worktrees.branches", cwd, [
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(upstream:track)",
            "refs/heads",
            "refs/remotes",
          ])
          .pipe(Effect.mapError(gitFailed("Worktrees.branches")));

        const fallback = yield* defaultBranch(cwd);

        const found: Array<Branch> = out
          .split("\n")
          .filter((line) => line !== "")
          .flatMap((line) => {
            const [ref = "", name = "", track = ""] = line.split("\0");
            const isRemote = ref.startsWith("refs/remotes/");

            if (name === "" || (isRemote && ref.endsWith("/HEAD"))) {
              return [];
            }

            const local = isRemote ? name.replace(/^[^/]+\//u, "") : name;

            return [
              {
                name,
                isRemote,
                isDefault: Option.contains(fallback, local),
                ahead: aheadOf(track),
              },
            ];
          });

        return {
          current: yield* currentBranch(cwd),
          branches: [
            ...found.filter((branch) => !branch.isRemote),
            ...found.filter((branch) => branch.isRemote),
          ],
        };
      });

      return Worktrees.of({
        isRepository,
        currentBranch,
        branchExists,
        availableBranchName,
        temporaryBranchName,
        create,
        remove,
        renameBranch,
        list,
        isWorktreeOf,
        branches,
      });
    })
  );
}
