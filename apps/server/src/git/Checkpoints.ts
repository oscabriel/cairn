// Ported from github.com/pingdotgg/t3code, apps/server/src/vcs/GitVcsDriver.ts (lines 792-1384:
// `resolveGitCommonDir`, `captureCheckpoint`, `hasCheckpointRef`, `diffCheckpoints`,
// `listAuthoredPaths`, `deleteCheckpointRefs`) and apps/server/src/checkpointing/Utils.ts
// (`checkpointRefForThreadTurn`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the capture
// recipe (the real index copied into the git common dir with its racy timestamp kept, `read-tree
// --reset HEAD`, the scratch-index `-c` flags, `add -A`, `write-tree`, `commit-tree -p HEAD`,
// `update-ref`, the scratch index always removed), the durable-write flags, the embedded-repository
// retry, numstat and patch diffs between two refs with `[top,literal]` path specs, and the
// authored-path rule (a turn is credited only with paths HEAD's movement does not explain).
// Changed: Linux only (no sparse checkout, Windows long paths or macOS fsync branches), refs under
// `refs/cairn/checkpoints`, the author `Cairn <cairn@localhost>`, commits never signed, the run a
// checkpoint belongs to recorded as `Cairn-Run` and `Cairn-Point` trailers so a capture is
// idempotent per run, a workspace its repository ignores is refused instead of seeded, and turns
// are listed from the refs themselves. Removed: restore (revert is not Phase 1).
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
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";

import { Git } from "./Git.ts";
import type { GitError } from "./Git.ts";

/** Where every Cairn checkpoint ref lives. Never under `refs/heads`, so `push --all` skips them. */
export const CHECKPOINT_REFS_ROOT = "refs/cairn/checkpoints";

/** The scratch index files a capture makes in the git common dir start with this. */
export const SCRATCH_INDEX_PREFIX = "cairn-checkpoint-index-";

/** The ref folder of one thread's checkpoints. */
export const checkpointRefsOf = (threadId: ThreadId) =>
  `${CHECKPOINT_REFS_ROOT}/${Buffer.from(threadId, "utf-8").toString("base64url")}/turn`;

/** The ref of one thread's checkpoint after `turn` runs (0 is the baseline before the first). */
export const checkpointRef = (threadId: ThreadId, turn: number) =>
  `${checkpointRefsOf(threadId)}/${String(turn)}`;

/** Every command that writes the scratch index: no fsmonitor, no split index to expire. */
const INDEX_CONFIG: ReadonlyArray<string> = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
];

// Git renames loose objects and refs into place without fsync by default, so an unclean restart
// can leave 0-byte files under refs/cairn/** that break every later fetch and push.
const DURABLE_WRITE: ReadonlyArray<string> = [
  "-c",
  "core.fsync=objects,reference",
  "-c",
  "core.fsyncMethod=fsync",
];

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "Cairn",
  GIT_AUTHOR_EMAIL: "cairn@localhost",
  GIT_COMMITTER_NAME: "Cairn",
  GIT_COMMITTER_EMAIL: "cairn@localhost",
} satisfies Readonly<Record<string, string>>;

/** The most untracked folders the embedded-repository retry inspects. */
const RECOVERY_MAX_CANDIDATES = 64;

/** How long the embedded-repository retry may look before giving up with the first failure. */
const RECOVERY_TIMEOUT = Duration.seconds(5);

/** Which end of a run a checkpoint was captured at. */
export const CheckpointPoint = Schema.Literals(["start", "end"]);

export type CheckpointPoint = typeof CheckpointPoint.Type;

/** A checkpoint operation failed. */
export class CheckpointError extends Schema.TaggedError<CheckpointError>()(
  "CheckpointError",
  {
    message: Schema.String,
    /** The Cairn operation, such as `Checkpoints.capture`. */
    operation: Schema.String,
    cwd: Schema.String,
    reason: Schema.Literals([
      /** The folder is not inside a git work tree. */
      "not_a_repository",
      /** The workspace folder is ignored by its own repository. */
      "workspace_ignored",
      /** A ref the operation needs does not exist. */
      "ref_missing",
      /** git ran and failed, or printed nothing where an id was expected. */
      "git_failed",
      /** A file operation on the scratch index failed. */
      "file_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** What a capture records about the run it belongs to. */
export interface CaptureInput {
  readonly cwd: string;
  readonly ref: string;
  /** The run the checkpoint belongs to, written as the `Cairn-Run` trailer. */
  readonly runId: string;
  readonly point: CheckpointPoint;
}

/** One captured checkpoint as its ref and commit show it. */
export interface CheckpointCommit {
  readonly ref: string;
  readonly turn: number;
  readonly commit: string;
  /** HEAD when it was captured; none when the branch had no commit yet. */
  readonly headOid: Option.Option<string>;
  readonly runId: Option.Option<string>;
  readonly point: Option.Option<CheckpointPoint>;
  /** The commit time, in epoch seconds. */
  readonly capturedAtSeconds: number;
}

/** A diff between two checkpoint refs. */
export interface CheckpointDiffInput {
  readonly cwd: string;
  readonly fromRef: string;
  readonly toRef: string;
  readonly ignoreWhitespace: boolean;
  readonly format: "patch" | "numstat";
  /** Repository-relative paths to limit the diff to; none diffs every path. */
  readonly filePaths: Option.Option<ReadonlyArray<string>>;
}

const decodePoint = Schema.decodeUnknownOption(CheckpointPoint);

const nonEmpty = (text: string) => {
  const trimmed = text.trim();

  return trimmed === "" ? Option.none() : Option.some(trimmed);
};

/** Splits git's `-z` output into its records, without the empty tail. */
export const splitNul = (output: string): ReadonlyArray<string> =>
  output.split("\0").filter((record) => record !== "");

/** The turn a checkpoint ref names. */
export const turnOf = (ref: string): Option.Option<number> =>
  Option.map(
    Option.fromNullishOr(/\/turn\/(?<turn>\d+)$/u.exec(ref)?.groups?.turn),
    Number
  );

const FOR_EACH_REF_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(parent)",
  "%(committerdate:unix)",
  "%(trailers:key=Cairn-Run,valueonly=true,separator=%x2C)",
  "%(trailers:key=Cairn-Point,valueonly=true,separator=%x2C)",
].join("%09");

/** Reads one `for-each-ref` line in `FOR_EACH_REF_FORMAT`; none for a ref that is not a turn. */
export const parseCheckpointLine = (
  line: string
): Option.Option<CheckpointCommit> => {
  const [ref = "", commit = "", parent = "", time = "", run = "", point = ""] =
    line.split("\t");

  const turn = turnOf(ref);

  if (Option.isNone(turn) || commit === "") {
    return Option.none();
  }

  return Option.some({
    ref,
    turn: turn.value,
    commit,
    // A checkpoint has at most one parent: HEAD at capture.
    headOid: nonEmpty(parent),
    runId: nonEmpty(run),
    point: Option.flatMap(nonEmpty(point), decodePoint),
    capturedAtSeconds: Number(time),
  });
};

/** The authored-path inputs `listAuthoredPaths` reads from `log --no-walk`. */
const parseHeads = (output: string) => {
  const [fromLine = "", toLine = ""] = output.trimEnd().split("\n");
  const [startHead = "", capturedAt = ""] = fromLine.split(" ");
  const [endHead = ""] = toLine.split(" ");

  return { startHead, capturedAt, endHead };
};

const gitFailed =
  (operation: string, cwd: string) =>
  (cause: GitError): CheckpointError =>
    new CheckpointError({
      message: `${operation} failed in ${cwd}: ${cause.message}`,
      operation,
      cwd,
      reason: "git_failed",
      cause,
    });

/** Git's checkpoint refs of the user's repositories: capture, list, diff and delete. */
export class Checkpoints extends Context.Service<
  Checkpoints,
  {
    /** Whether `cwd` is inside a git work tree. */
    isRepository(cwd: string): Effect.Effect<boolean>;
    /** The repository's common dir (shared by its worktrees), as an absolute path. */
    commonDir(cwd: string): Effect.Effect<string, CheckpointError>;
    /**
     * Captures the work tree (tracked, untracked, not ignored) as a commit whose parent is HEAD and
     * points `ref` at it, leaving HEAD, the branch, the real index and the work tree as they were.
     */
    capture(
      input: CaptureInput
    ): Effect.Effect<CheckpointCommit, CheckpointError>;
    /** Every checkpoint under `refsOf`, by turn. */
    list(
      cwd: string,
      refsOf: string
    ): Effect.Effect<ReadonlyArray<CheckpointCommit>, CheckpointError>;
    /** The patch or `-z` numstat between two checkpoint refs. */
    diff(input: CheckpointDiffInput): Effect.Effect<string, CheckpointError>;
    /**
     * The paths the turn between two checkpoints wrote itself; none when HEAD did not move (every
     * change is the turn's). A pull or checkout mid-turn is not credited to the agent.
     */
    listAuthoredPaths(
      cwd: string,
      fromRef: string,
      toRef: string
    ): Effect.Effect<Option.Option<ReadonlySet<string>>, CheckpointError>;
    /** Removes refs; a missing one is fine. */
    deleteRefs(
      cwd: string,
      refs: ReadonlyArray<string>
    ): Effect.Effect<void, CheckpointError>;
    /**
     * Removes scratch index files a killed capture left in the repository's common dir, except the
     * ones a capture of this process is using. Returns how many it removed.
     */
    sweepScratch(cwd: string): Effect.Effect<number, CheckpointError>;
  }
>()("cairn/server/git/Checkpoints") {
  /** Runs git through the ambient `Git` and touches the scratch index through `FileSystem`. */
  static readonly layerNoDeps = Layer.effect(
    Checkpoints,
    Effect.gen(function* () {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;
      /** Scratch index paths of captures running now. */
      const active = new Set<string>();

      const stdout = (
        operation: string,
        cwd: string,
        args: ReadonlyArray<string>,
        env?: Readonly<Record<string, string>>
      ) =>
        git
          .stdout(operation, cwd, args, env === undefined ? {} : { env })
          .pipe(Effect.mapError(gitFailed(operation, cwd)));

      const run = (
        operation: string,
        cwd: string,
        args: ReadonlyArray<string>,
        env?: Readonly<Record<string, string>>
      ) =>
        git
          .run(operation, cwd, args, env === undefined ? {} : { env })
          .pipe(Effect.mapError(gitFailed(operation, cwd)));

      const isRepository = Effect.fn("Checkpoints.isRepository")(function* (
        cwd: string
      ) {
        const result = yield* git
          .run("Checkpoints.isRepository", cwd, [
            "rev-parse",
            "--is-inside-work-tree",
          ])
          .pipe(Effect.option);

        return Option.exists(
          result,
          (found) => found.exitCode === 0 && found.stdout.trim() === "true"
        );
      });

      const commonDir = Effect.fn("Checkpoints.commonDir")(function* (
        cwd: string
      ) {
        const operation = "Checkpoints.commonDir";

        const result = yield* run(operation, cwd, [
          "rev-parse",
          "--git-common-dir",
        ]);

        if (result.exitCode !== 0) {
          return yield* new CheckpointError({
            message: `${operation}: ${cwd} is not inside a git repository, so it has no checkpoints.`,
            operation,
            cwd,
            reason: "not_a_repository",
          });
        }

        const dir = result.stdout.trim();

        if (path.isAbsolute(dir)) {
          return dir;
        }

        // Git answers relative to the physical cwd, which differs from a symlinked one.
        const physical = yield* fs
          .realPath(cwd)
          .pipe(Effect.orElseSucceed(() => cwd));

        return path.resolve(physical, dir);
      });

      const hasHead = (cwd: string) =>
        git
          .run("Checkpoints.hasHead", cwd, ["rev-parse", "--verify", "HEAD"])
          .pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.orElseSucceed(() => false)
          );

      const headOf = (cwd: string) =>
        git
          .run("Checkpoints.head", cwd, ["rev-parse", "--verify", "HEAD"])
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 ? nonEmpty(result.stdout) : Option.none()
            ),
            Effect.orElseSucceed(() => Option.none<string>())
          );

      // Seeds the scratch index from a copy of the real one, so `add -A` reuses its stat data
      // instead of hashing every file. False when the copy is unusable; the caller reads HEAD.
      const seedFromRealIndex = (
        operation: string,
        cwd: string,
        scratch: string,
        env: Readonly<Record<string, string>>
      ) =>
        Effect.gen(function* () {
          const indexPath = (yield* stdout(operation, cwd, [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "index",
          ])).trim();

          const { mtime } = yield* fs.stat(indexPath);

          if (Option.isNone(mtime)) {
            return false;
          }

          // Stay below the source's timestamp, preserving git's racy-clean check.
          const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);

          if (indexTime <= 0) {
            return false;
          }

          yield* fs.copyFile(indexPath, scratch);
          yield* stdout(
            operation,
            cwd,
            [...INDEX_CONFIG, "read-tree", "--reset", "HEAD"],
            env
          );
          // read-tree can rewrite the index, so restore its racy timestamp afterwards.
          yield* fs.utimes(scratch, indexTime, indexTime);

          // Assume-unchanged and skip-worktree flags would hide changes from `add`: start over.
          const flags = yield* stdout(
            operation,
            cwd,
            [...INDEX_CONFIG, "ls-files", "-v", "-z"],
            env
          );

          return !splitNul(flags).some((record) => /^[a-zS]/u.test(record));
        }).pipe(Effect.orElseSucceed(() => false));

      // Git cannot stage an embedded repository until it has a commit: exclude those and retry.
      const embeddedExclusions = (
        operation: string,
        cwd: string,
        env: Readonly<Record<string, string>>
      ) =>
        Effect.gen(function* () {
          const untracked = yield* stdout(
            operation,
            cwd,
            ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
            env
          );

          const candidates = splitNul(untracked).filter((entry) =>
            entry.endsWith("/")
          );

          if (candidates.length > RECOVERY_MAX_CANDIDATES) {
            return [];
          }

          const exclusions: Array<string> = [];

          for (const entry of candidates) {
            const nested = path.join(cwd, entry);

            const isRepo = yield* fs
              .exists(path.join(nested, ".git"))
              .pipe(Effect.orElseSucceed(() => false));

            if (isRepo && !(yield* hasHead(nested))) {
              exclusions.push(`:(exclude,literal)${entry}`);
            }
          }

          return exclusions;
        }).pipe(
          Effect.timeoutOrElse({
            duration: RECOVERY_TIMEOUT,
            orElse: () => Effect.succeed<ReadonlyArray<string>>([]),
          }),
          Effect.orElseSucceed((): ReadonlyArray<string> => [])
        );

      const capture = Effect.fn("Checkpoints.capture")(function* (
        input: CaptureInput
      ) {
        const operation = "Checkpoints.capture";
        const { cwd } = input;

        yield* Effect.annotateCurrentSpan({ ref: input.ref, cwd });

        const common = yield* commonDir(cwd);

        const scratch = path.join(
          common,
          `${SCRATCH_INDEX_PREFIX}${randomUUID()}`
        );

        const env = { ...AUTHOR_ENV, GIT_INDEX_FILE: scratch };

        // Removes the files only: the scratch path stays in `active` so a concurrent boot sweep
        // never deletes an index `read-tree` is about to recreate (git reads a missing index as
        // empty and the capture would commit an empty tree).
        const removeScratchFiles = Effect.forEach(
          [scratch, `${scratch}.lock`],
          (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
          { discard: true }
        );

        const removeScratch = removeScratchFiles.pipe(
          Effect.andThen(
            Effect.sync(() => {
              active.delete(scratch);
            })
          )
        );

        const ignored = yield* run(operation, cwd, [
          "check-ignore",
          "-q",
          "--",
          ".",
        ]);

        if (ignored.exitCode === 0) {
          return yield* new CheckpointError({
            message: `${operation}: ${cwd} is ignored by its own git repository, so Cairn cannot capture it. Un-ignore the folder or open its repository root as the project.`,
            operation,
            cwd,
            reason: "workspace_ignored",
          });
        }

        return yield* Effect.gen(function* () {
          active.add(scratch);
          const head = yield* headOf(cwd);

          if (Option.isSome(head)) {
            const seeded = yield* seedFromRealIndex(
              operation,
              cwd,
              scratch,
              env
            );

            if (!seeded) {
              yield* removeScratchFiles;
              yield* stdout(
                operation,
                cwd,
                [...INDEX_CONFIG, "read-tree", "HEAD"],
                env
              );
            }
          }

          const stage = (exclusions: ReadonlyArray<string>) =>
            stdout(
              operation,
              cwd,
              [
                ...INDEX_CONFIG,
                ...DURABLE_WRITE,
                "add",
                "-A",
                "--",
                ".",
                ...exclusions,
              ],
              env
            );

          yield* stage([]).pipe(
            Effect.catchTag("CheckpointError", (failure) =>
              Effect.gen(function* () {
                const exclusions = yield* embeddedExclusions(
                  operation,
                  cwd,
                  env
                );

                if (exclusions.length === 0) {
                  return yield* failure;
                }

                return yield* stage(exclusions);
              })
            )
          );

          const tree = (yield* stdout(
            operation,
            cwd,
            [...INDEX_CONFIG, ...DURABLE_WRITE, "write-tree"],
            env
          )).trim();

          const message = [
            `cairn checkpoint ${input.ref}`,
            "",
            `Cairn-Run: ${input.runId}`,
            `Cairn-Point: ${input.point}`,
          ].join("\n");

          // HEAD is the parent, so listAuthoredPaths sees how HEAD moved between checkpoints.
          const commit = (yield* stdout(
            operation,
            cwd,
            [
              ...DURABLE_WRITE,
              "commit-tree",
              "--no-gpg-sign",
              tree,
              ...Option.match(head, {
                onNone: () => [],
                onSome: (oid) => ["-p", oid],
              }),
              "-m",
              message,
            ],
            env
          )).trim();

          if (tree === "" || commit === "") {
            return yield* new CheckpointError({
              message: `${operation}: git printed no ${tree === "" ? "tree" : "commit"} id in ${cwd}. Retry; if it repeats, run git fsck in the repository.`,
              operation,
              cwd,
              reason: "git_failed",
            });
          }

          yield* stdout(operation, cwd, [
            ...DURABLE_WRITE,
            "update-ref",
            input.ref,
            commit,
          ]);

          const time = yield* stdout(operation, cwd, [
            "log",
            "-1",
            "--format=%ct",
            commit,
          ]);

          return {
            ref: input.ref,
            turn: Option.getOrElse(turnOf(input.ref), () => -1),
            commit,
            headOid: head,
            runId: Option.some(input.runId),
            point: Option.some(input.point),
            capturedAtSeconds: Number(time.trim()),
          } satisfies CheckpointCommit;
        }).pipe(Effect.ensuring(removeScratch));
      });

      const list = Effect.fn("Checkpoints.list")(function* (
        cwd: string,
        refsOf: string
      ) {
        const output = yield* stdout("Checkpoints.list", cwd, [
          "for-each-ref",
          `--format=${FOR_EACH_REF_FORMAT}`,
          `${refsOf}/`,
        ]);

        return output
          .split("\n")
          .flatMap((line) => Option.toArray(parseCheckpointLine(line)))
          .toSorted((left, right) => left.turn - right.turn);
      });

      const diff = Effect.fn("Checkpoints.diff")(function* (
        input: CheckpointDiffInput
      ) {
        const operation = "Checkpoints.diff";

        if (Option.exists(input.filePaths, (paths) => paths.length === 0)) {
          return "";
        }

        const result = yield* run(operation, input.cwd, [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${input.fromRef}^{commit}`,
          `${input.toRef}^{commit}`,
          // Paths are repository-relative, while cwd can be a subdirectory.
          ...Option.match(input.filePaths, {
            onNone: () => [],
            onSome: (paths) => [
              "--",
              ...paths.map((file) => `:(top,literal)${file}`),
            ],
          }),
        ]);

        if (result.exitCode !== 0) {
          return yield* new CheckpointError({
            message: `${operation}: git diff exited ${String(result.exitCode)} in ${input.cwd}; a checkpoint ref is missing or unreadable. Retry after the next turn captures again.`,
            operation,
            cwd: input.cwd,
            reason: "ref_missing",
          });
        }

        return result.stdout;
      });

      const listAuthoredPaths = Effect.fn("Checkpoints.listAuthoredPaths")(
        function* (cwd: string, fromRef: string, toRef: string) {
          const operation = "Checkpoints.listAuthoredPaths";

          const { startHead, capturedAt, endHead } = parseHeads(
            yield* stdout(operation, cwd, [
              "log",
              "--no-walk=unsorted",
              "--format=%P %ct",
              `${fromRef}^{commit}`,
              `${toRef}^{commit}`,
            ])
          );

          if (startHead === "" || endHead === "" || startHead === endHead) {
            return Option.none<ReadonlySet<string>>();
          }

          const listPaths = (args: ReadonlyArray<string>) =>
            stdout(operation, cwd, [
              ...args,
              "--name-only",
              "-z",
              "--no-renames",
              "--no-ext-diff",
            ]).pipe(Effect.map(splitNul));

          // Remerge diff lists a merge's paths only where the result differs from git's automatic
          // merge, so a merge keeps its conflict fixes and drops clean upstream changes.
          const lists = yield* Effect.all(
            [
              listPaths(["diff", startHead, `${fromRef}^{commit}`]),
              listPaths(["diff", endHead, `${toRef}^{commit}`]),
              listPaths([
                "log",
                "--format=",
                "--diff-merges=remerge",
                `${endHead}..${startHead}`,
              ]),
              listPaths([
                "log",
                "--format=",
                "--diff-merges=remerge",
                `--since=@${capturedAt}`,
                `${startHead}..${endHead}`,
              ]),
            ],
            { concurrency: "unbounded" }
          );

          return Option.some<ReadonlySet<string>>(new Set(lists.flat()));
        }
      );

      const deleteRefs = Effect.fn("Checkpoints.deleteRefs")(function* (
        cwd: string,
        refs: ReadonlyArray<string>
      ) {
        yield* Effect.forEach(
          refs,
          (ref) =>
            run("Checkpoints.deleteRefs", cwd, ["update-ref", "-d", ref]),
          { discard: true }
        );
      });

      const sweepScratch = Effect.fn("Checkpoints.sweepScratch")(function* (
        cwd: string
      ) {
        const common = yield* commonDir(cwd);

        const names = yield* fs.readDirectory(common).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointError({
                message: `Checkpoints.sweepScratch could not read ${common}: ${cause.message}`,
                operation: "Checkpoints.sweepScratch",
                cwd,
                reason: "file_failed",
                cause,
              })
          )
        );

        const stale = names
          .filter((name) => name.startsWith(SCRATCH_INDEX_PREFIX))
          .map((name) => path.join(common, name))
          .filter((file) => !active.has(file.replace(/\.lock$/u, "")));

        yield* Effect.forEach(
          stale,
          (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
          { discard: true }
        );

        return stale.length;
      });

      return Checkpoints.of({
        sweepScratch,
        isRepository,
        commonDir,
        capture,
        list,
        diff,
        listAuthoredPaths,
        deleteRefs,
      });
    })
  );

  /** With Node's git spawner and file system. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Git.layerNoDeps),
    Layer.provide(NodeServices.layer)
  );
}
