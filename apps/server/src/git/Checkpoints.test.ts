// J5 with real git: capture leaves the user's repository as it was, captures run concurrently, the
// refs are durable and private, `diff.turn` equals a hand-computed diff, files HEAD's movement
// explains are filtered out, the output cap marks its cut, and no scratch index survives an
// interrupted capture. Also the capture service's idempotency and the pure helpers.

import { createHash } from "node:crypto";
import path from "node:path";

import type { ProjectId } from "@cairn/protocol/Ids";
import { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
} from "effect";

import { EventSink } from "../shell/EventSink.ts";
import { ThreadCreate } from "../shell/ShellCommands.ts";
import { ShellTestLayer, testThreadId } from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { addProject, COMMIT_OPTIONS } from "../threads/ThreadsTestKit.ts";
import {
  CheckpointCapture,
  CheckpointEntries,
  checkpointRequestId,
  missedRunEnd,
  planEndTurn,
} from "./CheckpointCapture.ts";
import type { CheckpointEntryData } from "./CheckpointCapture.ts";
import {
  checkpointRef,
  checkpointRefsOf,
  Checkpoints,
  parseCheckpointLine,
  SCRATCH_INDEX_PREFIX,
} from "./Checkpoints.ts";
import type { CheckpointCommit } from "./Checkpoints.ts";
import {
  capDiff,
  DIFF_TRUNCATED_MARKER,
  DiffOutputLimit,
  Diffs,
  isGitImport,
  parseNumstat,
} from "./Diffs.ts";
import { Git, GIT_DEFAULTS } from "./Git.ts";

const GitLayer = Git.layerNoDeps.pipe(Layer.provideMerge(NodeServices.layer));

const CheckpointsLayer = Checkpoints.layerNoDeps.pipe(
  Layer.provideMerge(GitLayer)
);

const THREAD_A = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000000a");

const THREAD_B = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000000b");

const sh = (cwd: string, args: ReadonlyArray<string>) =>
  Git.use((git) => git.stdout("test", cwd, args));

const commitAll = (cwd: string, message: string) =>
  Effect.gen(function* () {
    yield* sh(cwd, ["add", "-A"]);
    yield* sh(cwd, [...COMMIT_OPTIONS, "commit", "--quiet", "-m", message]);
  });

/** A repository on `main` with `a.txt` committed and `.gitignore` ignoring `*.log`. */
const makeRepo = Effect.fn("test.makeRepo")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repo = path.join(dir, "repo");

  yield* sh(dir, ["init", "--quiet", "-b", "main", repo]);
  yield* fs.writeFileString(path.join(repo, "a.txt"), "one\n");
  yield* fs.writeFileString(path.join(repo, ".gitignore"), "*.log\n");
  yield* commitAll(repo, "init");

  return { dir, repo };
});

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** What capture must not change: HEAD, the branch, the real index and the status. */
const repoState = Effect.fn("test.repoState")(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem;
  // status first: it may refresh the index's stat data, which is not capture's doing.
  const status = yield* sh(repo, ["status", "--porcelain", "-uall"]);
  const index = sha256(yield* fs.readFile(path.join(repo, ".git", "index")));
  const head = yield* sh(repo, ["rev-parse", "HEAD"]);
  const branch = yield* sh(repo, ["symbolic-ref", "HEAD"]);

  return { status, index, head, branch };
});

const scratchFiles = Effect.fn("test.scratchFiles")(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory(path.join(repo, ".git"));

  return names.filter((name) => name.startsWith(SCRATCH_INDEX_PREFIX));
});

/** Where the interrupting git stops a capture: after the scratch index was written. */
const cut = (args: ReadonlyArray<string>) => args.includes("write-tree");

const captureTurn = (
  repo: string,
  threadId: ThreadId,
  turn: number,
  runId = `run-${String(turn)}`
) =>
  Checkpoints.use((checkpoints) =>
    checkpoints.capture({
      cwd: repo,
      ref: checkpointRef(threadId, turn),
      runId,
      point: turn === 0 ? "start" : "end",
    })
  );

describe("Checkpoints with real git", () => {
  it.live(
    "capture leaves HEAD, the branch, the index and the status as they were",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { repo } = yield* makeRepo();

        // Staged, unstaged, untracked, ignored and an embedded repository with no commit.
        yield* fs.writeFileString(path.join(repo, "staged.txt"), "staged\n");
        yield* sh(repo, ["add", "staged.txt"]);
        yield* fs.writeFileString(path.join(repo, "a.txt"), "one\nchanged\n");
        yield* fs.writeFileString(path.join(repo, "new.txt"), "untracked\n");
        yield* fs.writeFileString(path.join(repo, "debug.log"), "ignored\n");
        yield* sh(repo, ["init", "--quiet", path.join(repo, "nested")]);
        yield* fs.writeFileString(
          path.join(repo, "nested", "inner.txt"),
          "inner\n"
        );

        const before = yield* repoState(repo);
        const captured = yield* captureTurn(repo, THREAD_A, 1);
        const after = yield* repoState(repo);

        assert.deepStrictEqual(after, before);
        assert.isTrue(Option.contains(captured.headOid, before.head.trim()));

        const tree = yield* sh(repo, [
          "ls-tree",
          "-r",
          "--name-only",
          captured.commit,
        ]);

        const files = tree.trim().split("\n");

        assert.deepStrictEqual(files.toSorted(), [
          ".gitignore",
          "a.txt",
          "new.txt",
          "staged.txt",
        ]);
        assert.strictEqual(
          yield* sh(repo, ["show", `${captured.commit}:a.txt`]),
          "one\nchanged\n"
        );
        assert.deepStrictEqual(yield* scratchFiles(repo), []);
      }).pipe(Effect.scoped, Effect.provide(CheckpointsLayer))
  );

  it.live("two threads capture concurrently in one repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checkpoints = yield* Checkpoints;
      const { repo } = yield* makeRepo();

      yield* fs.writeFileString(path.join(repo, "b.txt"), "b\n");

      const before = yield* repoState(repo);

      const captured = yield* Effect.all(
        [
          captureTurn(repo, THREAD_A, 0),
          captureTurn(repo, THREAD_B, 0),
          captureTurn(repo, THREAD_A, 1),
          captureTurn(repo, THREAD_B, 1),
        ],
        { concurrency: "unbounded" }
      );

      assert.deepStrictEqual(yield* repoState(repo), before);

      const trees = yield* Effect.forEach(captured, (found) =>
        sh(repo, ["rev-parse", `${found.commit}^{tree}`])
      );

      assert.strictEqual(new Set(trees).size, 1);

      const listedA = yield* checkpoints.list(repo, checkpointRefsOf(THREAD_A));
      const listedB = yield* checkpoints.list(repo, checkpointRefsOf(THREAD_B));

      assert.deepStrictEqual(
        listedA.map((found) => [found.turn, found.runId, found.point]),
        [
          [0, Option.some("run-0"), Option.some("start")],
          [1, Option.some("run-1"), Option.some("end")],
        ]
      );
      assert.deepStrictEqual(
        listedB.map((found) => found.turn),
        [0, 1]
      );
      assert.deepStrictEqual(yield* scratchFiles(repo), []);
    }).pipe(Effect.scoped, Effect.provide(CheckpointsLayer))
  );

  it.live("refs survive gc and stay out of git branch and git push --all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, repo } = yield* makeRepo();
      const remote = path.join(dir, "remote.git");

      yield* fs.writeFileString(path.join(repo, "c.txt"), "dangling\n");
      const captured = yield* captureTurn(repo, THREAD_A, 1);

      yield* sh(repo, ["gc", "--quiet", "--prune=now"]);

      assert.strictEqual(
        (yield* sh(repo, ["rev-parse", checkpointRef(THREAD_A, 1)])).trim(),
        captured.commit
      );
      assert.strictEqual(
        yield* sh(repo, ["show", `${checkpointRef(THREAD_A, 1)}:c.txt`]),
        "dangling\n"
      );
      assert.notInclude(yield* sh(repo, ["branch", "--all"]), "cairn");

      yield* sh(dir, ["init", "--quiet", "--bare", remote]);
      yield* sh(repo, ["push", "--quiet", "--all", remote]);

      const pushed = yield* sh(repo, ["ls-remote", remote]);

      assert.include(pushed, "refs/heads/main");
      assert.notInclude(pushed, "refs/cairn");
    }).pipe(Effect.scoped, Effect.provide(CheckpointsLayer))
  );

  it.live("removes the scratch index when a capture is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { repo } = yield* makeRepo();

      yield* fs.writeFileString(path.join(repo, "d.txt"), "d\n");

      const before = yield* repoState(repo);

      const fiber = yield* Effect.forkChild(captureTurn(repo, THREAD_A, 1), {
        startImmediately: true,
      });

      const exit = yield* Fiber.await(fiber);

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.deepStrictEqual(yield* scratchFiles(repo), []);
      assert.deepStrictEqual(yield* repoState(repo), before);
      assert.strictEqual(
        (yield* Git.use((git) =>
          git.run("test", repo, [
            "rev-parse",
            "--verify",
            "--quiet",
            checkpointRef(THREAD_A, 1),
          ])
        )).exitCode,
        1
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Checkpoints.layerNoDeps.pipe(
          // A git that is interrupted at write-tree, after the scratch index was written.
          Layer.provide(
            Layer.effect(
              Git,
              Effect.gen(function* () {
                const real = yield* Git;

                return Git.of({
                  run: (operation, cwd, args) =>
                    cut(args)
                      ? Effect.interrupt
                      : real.run(operation, cwd, args),
                  runWith: (operation, cwd, args, options) =>
                    cut(args)
                      ? Effect.interrupt
                      : real.runWith(operation, cwd, args, options),
                  stdout: (operation, cwd, args) =>
                    cut(args)
                      ? Effect.interrupt
                      : real.stdout(operation, cwd, args),
                  stdoutWith: (operation, cwd, args, options) =>
                    cut(args)
                      ? Effect.interrupt
                      : real.stdoutWith(operation, cwd, args, options),
                });
              })
            ).pipe(Layer.provide(Git.layerNoDeps))
          ),
          Layer.provideMerge(GitLayer)
        )
      )
    )
  );

  it.live(
    "captures a linked worktree with the scratch index in the common dir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { dir, repo } = yield* makeRepo();
        const tree = path.join(dir, "feature");

        yield* sh(repo, ["worktree", "add", "--quiet", "-b", "feature", tree]);
        yield* fs.writeFileString(path.join(tree, "wt.txt"), "worktree\n");

        const before = yield* sh(tree, ["status", "--porcelain", "-uall"]);
        const captured = yield* captureTurn(tree, THREAD_A, 1);

        assert.strictEqual(
          yield* sh(tree, ["status", "--porcelain", "-uall"]),
          before
        );
        assert.strictEqual(
          yield* sh(repo, ["show", `${checkpointRef(THREAD_A, 1)}:wt.txt`]),
          "worktree\n"
        );
        assert.isTrue(
          Option.contains(
            captured.headOid,
            (yield* sh(tree, ["rev-parse", "HEAD"])).trim()
          )
        );
        assert.deepStrictEqual(yield* scratchFiles(repo), []);
      }).pipe(Effect.scoped, Effect.provide(CheckpointsLayer))
  );

  it.live("sweeps a scratch index a killed capture left behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const checkpoints = yield* Checkpoints;
      const { repo } = yield* makeRepo();
      const stale = path.join(repo, ".git", `${SCRATCH_INDEX_PREFIX}dead`);

      yield* fs.writeFileString(stale, "x");
      yield* fs.writeFileString(`${stale}.lock`, "x");

      assert.strictEqual(yield* checkpoints.sweepScratch(repo), 2);
      assert.deepStrictEqual(yield* scratchFiles(repo), []);
    }).pipe(Effect.scoped, Effect.provide(CheckpointsLayer))
  );
});

/** Records every entry write, as the harness would keep the first per request id. */
const recordedEntries = Effect.gen(function* () {
  const written = yield* Ref.make<
    ReadonlyArray<{ requestId: string; data: CheckpointEntryData }>
  >([]);

  const layer = Layer.succeed(
    CheckpointEntries,
    CheckpointEntries.of({
      write: (_threadId, requestId, data) =>
        Ref.update(written, (all) =>
          all.some((found) => found.requestId === requestId)
            ? all
            : [...all, { requestId, data }]
        ),
    })
  );

  return { written, layer };
});

const threadIn = Effect.fn("test.threadIn")(function* (
  projectId: ProjectId,
  n: number
) {
  const sink = yield* EventSink;
  const threadId = testThreadId(n);

  yield* sink.commitCommand(
    ThreadCreate.make({
      commandId: yield* sink.mintCommandId,
      threadId,
      projectId,
      title: `Thread ${String(n)}`,
      provider: "opencode-go",
      modelId: "small",
      thinkingLevel: "off",
      runtimeMode: "full-access",
      branch: Option.none(),
      worktreePath: Option.none(),
    })
  );

  return threadId;
});

const withCapture = <A, E, R>(
  limit: number,
  body: (
    written: Ref.Ref<
      ReadonlyArray<{ requestId: string; data: CheckpointEntryData }>
    >
  ) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const { written, layer } = yield* recordedEntries;

    return yield* body(written).pipe(
      Effect.provide(
        CheckpointCapture.layerNoDeps.pipe(
          Layer.provideMerge(Diffs.layerNoDeps),
          Layer.provideMerge(layer),
          Layer.provideMerge(CheckpointsLayer),
          Layer.provideMerge(ShellTestLayer),
          Layer.provideMerge(Layer.succeed(DiffOutputLimit, limit))
        )
      )
    );
  }).pipe(Effect.scoped);

describe("turn diffs and the capture service", () => {
  it.live(
    "diff.turn equals a hand-computed diff and capture is idempotent per run",
    () =>
      withCapture(2_000_000, (written) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const capture = yield* CheckpointCapture;
          const diffs = yield* Diffs;
          const { repo } = yield* makeRepo();
          const projectId = yield* addProject(repo);
          const threadId = yield* threadIn(projectId, 1);

          const zero = yield* capture.runStarted(threadId, "7");
          assert.isTrue(Option.isSome(zero));
          // A second start (a resumed run) captures nothing.
          assert.isTrue(
            Option.isNone(yield* capture.runStarted(threadId, "7"))
          );

          yield* fs.writeFileString(path.join(repo, "a.txt"), "one\ntwo\n");
          yield* fs.writeFileString(path.join(repo, "b.txt"), "bee\n");

          const one = yield* capture.runEnded(threadId, "7", Option.some(42));
          const again = yield* capture.runEnded(threadId, "7", Option.none());

          assert.deepStrictEqual(
            Option.map(one, (found) => found.turn),
            Option.some(1)
          );
          assert.deepStrictEqual(
            Option.map(again, (found) => found.commit),
            Option.map(one, (found) => found.commit)
          );

          const hashOf = (file: string) =>
            sh(repo, ["hash-object", file]).pipe(
              Effect.map((out) => out.trim())
            );

          const oldA = (yield* sh(repo, ["rev-parse", "HEAD:a.txt"])).trim();
          const newA = yield* hashOf("a.txt");
          const newB = yield* hashOf("b.txt");

          const result = yield* diffs.turn({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
            ignoreWhitespace: false,
          });

          const expected = [
            "diff --git a/a.txt b/a.txt",
            `index ${oldA.slice(0, 7)}..${newA.slice(0, 7)} 100644`,
            "--- a/a.txt",
            "+++ b/a.txt",
            "@@ -1 +1,2 @@",
            " one",
            "+two",
            "diff --git a/b.txt b/b.txt",
            "new file mode 100644",
            `index 0000000..${newB.slice(0, 7)}`,
            "--- /dev/null",
            "+++ b/b.txt",
            "@@ -0,0 +1 @@",
            "+bee",
            "",
          ].join("\n");

          // git abbreviates object ids to at least 7 characters; compare with the ids cut to 7.
          assert.strictEqual(
            result.diff.replaceAll(
              /^index (?<from>[0-9a-f]+)\.\.(?<to>[0-9a-f]+)/gmu,
              (_line, from: string, to: string) =>
                `index ${from.slice(0, 7)}..${to.slice(0, 7)}`
            ),
            expected
          );

          const full = yield* diffs.full({
            threadId,
            toTurnCount: 1,
            ignoreWhitespace: false,
          });

          assert.strictEqual(full.diff, result.diff);

          // The entry for turn 1 was written once, with the card's files.
          const entries = yield* Ref.get(written);

          assert.deepStrictEqual(
            entries.map((found) => found.requestId),
            [checkpointRequestId(threadId, 1)]
          );
          assert.deepStrictEqual(entries[0]?.data.files, [
            { path: "a.txt", additions: 1, deletions: 0 },
            { path: "b.txt", additions: 1, deletions: 0 },
          ]);
          assert.strictEqual(entries[0]?.data.turn, 1);
          // The user entry the run answered places the card in its turn.
          assert.strictEqual(entries[0]?.data.userEntryId, 42);

          const missing = yield* diffs
            .turn({
              threadId,
              fromTurnCount: 1,
              toTurnCount: 2,
              ignoreWhitespace: false,
            })
            .pipe(Effect.flip);

          assert.strictEqual(missing.reason, "checkpoint_missing");
        })
      )
  );

  it.live("filters out files HEAD's movement explains", () =>
    withCapture(2_000_000, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const capture = yield* CheckpointCapture;
        const diffs = yield* Diffs;
        const { repo } = yield* makeRepo();
        const projectId = yield* addProject(repo);
        const threadId = yield* threadIn(projectId, 2);

        yield* capture.runStarted(threadId, "1");
        // Mid-turn, a pull lands upstream.txt (HEAD moves to a commit made before the turn began)
        // while the agent edits a.txt.
        yield* fs.writeFileString(path.join(repo, "upstream.txt"), "pulled\n");
        yield* sh(repo, ["add", "upstream.txt"]);
        yield* Git.use((git) =>
          git.stdoutWith(
            "test",
            repo,
            [...COMMIT_OPTIONS, "commit", "--quiet", "-m", "upstream"],
            {
              ...GIT_DEFAULTS,
              env: {
                GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
                GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
              },
            }
          )
        );
        yield* fs.writeFileString(path.join(repo, "a.txt"), "one\nagent\n");
        yield* capture.runEnded(threadId, "1", Option.none());

        const result = yield* diffs.turn({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: false,
        });

        assert.include(result.diff, "diff --git a/a.txt b/a.txt");
        assert.notInclude(result.diff, "upstream.txt");
      })
    )
  );

  it.live("caps a large diff with the truncation marker", () =>
    withCapture(400, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const capture = yield* CheckpointCapture;
        const diffs = yield* Diffs;
        const { repo } = yield* makeRepo();
        const projectId = yield* addProject(repo);
        const threadId = yield* threadIn(projectId, 3);

        yield* capture.runStarted(threadId, "1");
        yield* fs.writeFileString(
          path.join(repo, "big.txt"),
          Array.from({ length: 200 }, (_, line) => `line ${String(line)}`).join(
            "\n"
          )
        );
        yield* capture.runEnded(threadId, "1", Option.none());

        const result = yield* diffs.turn({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: false,
        });

        assert.isTrue(result.diff.endsWith(DIFF_TRUNCATED_MARKER));
        assert.isAtMost(Buffer.byteLength(result.diff), 400);
      })
    )
  );

  it.live("a folder that is not a git repository has no checkpoints", () =>
    withCapture(2_000_000, (written) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const capture = yield* CheckpointCapture;
        const diffs = yield* Diffs;
        const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const projectId = yield* addProject(dir);
        const threadId = yield* threadIn(projectId, 4);

        assert.isTrue(Option.isNone(yield* capture.runStarted(threadId, "1")));
        assert.isTrue(
          Option.isNone(yield* capture.runEnded(threadId, "1", Option.none()))
        );
        assert.deepStrictEqual(yield* Ref.get(written), []);

        const failure = yield* diffs
          .full({ threadId, toTurnCount: 1, ignoreWhitespace: false })
          .pipe(Effect.flip);

        assert.strictEqual(failure.reason, "no_checkpoints");
      })
    )
  );

  it.live("the boot repair captures a run end the brain missed", () =>
    withCapture(2_000_000, (written) =>
      Effect.gen(function* () {
        const capture = yield* CheckpointCapture;
        const checkpoints = yield* Checkpoints;
        const { repo } = yield* makeRepo();
        const projectId = yield* addProject(repo);
        const threadId = yield* threadIn(projectId, 5);

        const rows = yield* ThreadRows;
        const fs = yield* FileSystem.FileSystem;
        const stale = path.join(repo, ".git", `${SCRATCH_INDEX_PREFIX}killed`);

        // The thread row has no completed run: nothing to capture.
        yield* capture.repair;
        assert.deepStrictEqual(
          yield* checkpoints.list(repo, checkpointRefsOf(threadId)),
          []
        );

        // A run completed while the brain was going down, and a capture was killed mid-way.
        const row = yield* rows.get(threadId);
        const now = yield* DateTime.now;

        assert.isTrue(Option.isSome(row));

        if (Option.isSome(row)) {
          yield* rows.write({
            ...row.value,
            shell: {
              ...row.value.shell,
              latestRunCompletedAt: Option.some(
                DateTime.subtract(now, { seconds: 5 })
              ),
            },
          });
        }

        yield* fs.writeFileString(stale, "x");

        // A thread with no checkpoints predates them: the sweep runs, the capture does not.
        yield* capture.repair;
        assert.deepStrictEqual(yield* scratchFiles(repo), []);
        assert.deepStrictEqual(
          yield* checkpoints.list(repo, checkpointRefsOf(threadId)),
          []
        );
        assert.deepStrictEqual(yield* Ref.get(written), []);

        // Once the thread has its baseline, a missed run end is captured once.
        yield* capture.runStarted(threadId, "1");
        yield* fs.writeFileString(stale, "x");
        yield* capture.repair;
        yield* capture.repair;

        const listed = yield* checkpoints.list(
          repo,
          checkpointRefsOf(threadId)
        );

        assert.deepStrictEqual(
          listed.map((found) => [found.turn, found.point]),
          [
            [0, Option.some("start")],
            [1, Option.some("end")],
          ]
        );
        assert.deepStrictEqual(yield* scratchFiles(repo), []);
        assert.deepStrictEqual(
          (yield* Ref.get(written)).map((found) => found.requestId),
          [checkpointRequestId(threadId, 1)]
        );
      })
    )
  );
});

const commitAt = (
  turn: number,
  seconds: number,
  point: "start" | "end",
  runId: string
): CheckpointCommit => ({
  ref: `refs/cairn/checkpoints/x/turn/${String(turn)}`,
  turn,
  commit: `c${String(turn)}`,
  headOid: Option.none(),
  runId: Option.some(runId),
  point: Option.some(point),
  capturedAtSeconds: seconds,
});

describe("checkpoint helpers", () => {
  it("plans an end turn: the run's own, else the next free one", () => {
    const captured = [
      commitAt(0, 10, "start", "1"),
      commitAt(1, 20, "end", "1"),
    ];

    assert.strictEqual(planEndTurn(captured, "1").turn, 1);
    assert.isTrue(Option.isSome(planEndTurn(captured, "1").existing));
    assert.strictEqual(planEndTurn(captured, "2").turn, 2);
    assert.strictEqual(planEndTurn([], "2").turn, 1);
  });

  it("finds a missed run end by commit time", () => {
    const captured = [
      commitAt(0, 10, "start", "1"),
      commitAt(1, 20, "end", "1"),
    ];

    assert.isFalse(missedRunEnd(captured, 20_999));
    assert.isTrue(missedRunEnd(captured, 21_000));
    assert.isTrue(missedRunEnd([commitAt(0, 10, "start", "1")], 5000));
    // A thread with no checkpoints predates the feature: boot never repairs it.
    assert.isFalse(missedRunEnd([], 5000));
  });

  it("reads a for-each-ref line", () => {
    const line = [
      "refs/cairn/checkpoints/abc/turn/3",
      "c0ffee",
      "beef",
      "1700000000",
      "42",
      "end",
    ].join("\t");

    assert.deepStrictEqual(
      parseCheckpointLine(line),
      Option.some({
        ref: "refs/cairn/checkpoints/abc/turn/3",
        turn: 3,
        commit: "c0ffee",
        headOid: Option.some("beef"),
        runId: Option.some("42"),
        point: Option.some("end" as const),
        capturedAtSeconds: 1_700_000_000,
      })
    );
    assert.isTrue(
      Option.isNone(parseCheckpointLine("refs/heads/main\tc0ffee"))
    );
  });

  it("reads numstat with renames and binary files", () => {
    const numstat = [
      "3\t1\tz.txt",
      "-\t-\timage.png",
      "0\t0\t",
      "old/name.txt",
      "new/name.txt",
      "",
    ].join("\0");

    assert.deepStrictEqual(parseNumstat(numstat), [
      {
        path: "image.png",
        previousPath: Option.none(),
        additions: 0,
        deletions: 0,
      },
      {
        path: "new/name.txt",
        previousPath: Option.some("old/name.txt"),
        additions: 0,
        deletions: 0,
      },
      {
        path: "z.txt",
        previousPath: Option.none(),
        additions: 3,
        deletions: 1,
      },
    ]);
  });

  it("treats a file as imported only when neither path was authored", () => {
    const renamed = {
      path: "new.txt",
      previousPath: Option.some("old.txt"),
      additions: 1,
      deletions: 1,
    };

    assert.isFalse(isGitImport(renamed, Option.none()));
    assert.isFalse(isGitImport(renamed, Option.some(new Set(["old.txt"]))));
    assert.isTrue(isGitImport(renamed, Option.some(new Set(["other.txt"]))));
  });

  it("cuts on a UTF-8 boundary and marks the cut", () => {
    const text = "é".repeat(100);
    const capped = capDiff(text, 50);

    assert.isTrue(capped.endsWith(DIFF_TRUNCATED_MARKER));
    assert.isAtMost(Buffer.byteLength(capped), 50);
    assert.notInclude(capped, "�");
    assert.strictEqual(capDiff("short", 50), "short");
  });
});
