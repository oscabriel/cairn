import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import {
  ExistingWorktreeWorkspace,
  NewWorktreeWorkspace,
  RootWorkspace,
} from "@cairn/protocol/Launch";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Option, Ref, Schedule } from "effect";
import type { Layer } from "effect";

import { ScriptedStore } from "../brain/ScriptedHarness.ts";
import { Git } from "../git/Git.ts";
import { Projects } from "../projects/Projects.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import { Worktrees } from "../projects/Worktrees.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ThreadCreate } from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { LaunchStore } from "./LaunchStore.ts";
import { ThreadLaunch } from "./ThreadLaunch.ts";
import {
  addProject,
  HeldModel,
  launchInput,
  makeRepository,
  ModelGate,
  threadsTestLayer,
  TitleModelScripted,
  TitleScript,
} from "./ThreadsTestKit.ts";
import { TurnContent, TurnContentError, textStage } from "./TurnContent.ts";
import { TurnContentLive } from "./TurnContentStages.ts";

const rootWorkspace = RootWorkspace.make({ branch: Option.none() });

const newWorktree = NewWorktreeWorkspace.make({
  baseRef: "main",
  branch: Option.none(),
  startFromOrigin: false,
});

type Services = Layer.Success<ReturnType<typeof testLayer>>;

const testLayer = (
  dataDir: string,
  options: {
    readonly held: boolean;
    readonly turnContent?: Layer.Layer<TurnContent>;
  }
) =>
  threadsTestLayer({
    dataDir,
    titleModel: TitleModelScripted({ held: options.held }),
    model: HeldModel,
    turnContent: options.turnContent ?? TurnContentLive,
  });

/** Runs `body` over a fresh temporary folder holding `data/` and a repository at `repo/`. */
const withRepo = <A, E>(
  options: {
    readonly held: boolean;
    readonly turnContent?: Layer.Layer<TurnContent>;
  },
  body: (dirs: {
    readonly dataDir: string;
    readonly repo: string;
  }) => Effect.Effect<A, E, Services>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const dataDir = path.join(root, "data");
    const repo = path.join(root, "repo");

    return yield* Effect.gen(function* () {
      yield* makeRepository(repo);
      // Answers arrive only after the model gate opens; the scripted run stays busy until then.
      yield* (yield* ModelGate).open;

      return yield* body({ dataDir, repo });
    }).pipe(Effect.provide(testLayer(dataDir, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const row = Effect.fn("test.row")(function* (threadId: ThreadId) {
  const found = yield* (yield* ThreadRows).get(threadId);

  assert.isTrue(Option.isSome(found), `thread ${threadId} has a row`);

  return Option.getOrThrow(found).shell;
});

/** Polls `check` until it holds, for up to five seconds. */
const eventually = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  check: (value: A) => boolean
) =>
  read.pipe(
    Effect.repeat({
      until: check,
      schedule: Schedule.spaced(Duration.millis(20)),
    }),
    Effect.timeout(Duration.seconds(5))
  );

const branchesOf = Effect.fn("test.branchesOf")(function* (repo: string) {
  const out = yield* (yield* Git).stdout("test", repo, [
    "branch",
    "--format=%(refname:short)",
  ]);

  return out.split("\n").filter((line) => line !== "");
});

const scriptedThread = Effect.fn("test.scriptedThread")(function* (
  threadId: ThreadId
) {
  const thread = (yield* ScriptedStore).threads.get(threadId);

  assert.isDefined(thread, `the harness holds thread ${threadId}`);

  return thread;
});

const userEntries = Effect.fn("test.userEntries")(function* (
  threadId: ThreadId
) {
  const thread = yield* scriptedThread(threadId);

  return thread === undefined
    ? []
    : thread.entries.filter((entry) => entry.kind === "cairn.user");
});

describe("launching threads", () => {
  it.live(
    "launches in the project root on its branch, sends the first message and names the thread",
    () =>
      withRepo({ held: false }, ({ repo }) =>
        Effect.gen(function* () {
          const script = yield* TitleScript;

          yield* Ref.set(
            script.title,
            Option.some(
              '{"title": "Root launch title", "needsRefinement": false}'
            )
          );

          const projectId = yield* addProject(repo);
          const launcher = yield* ThreadLaunch;

          const input = yield* launchInput(
            projectId,
            rootWorkspace,
            "Explain the build"
          );

          const result = yield* launcher.launch(input, "owner@test");

          assert.deepStrictEqual(result, {
            threadId: input.threadId,
            resumed: false,
          });

          yield* launcher.settled(input.threadId);

          const shell = yield* row(input.threadId);

          assert.deepStrictEqual(shell.branch, Option.some("main"));
          assert.isTrue(Option.isNone(shell.worktreePath));
          assert.strictEqual(shell.title, "Root launch title");
          assert.strictEqual(shell.activity, "idle");

          const thread = yield* scriptedThread(input.threadId);

          assert.strictEqual(thread?.agent.cwd, repo);
          assert.strictEqual((yield* userEntries(input.threadId)).length, 1);
          assert.isTrue(
            Option.isNone(yield* (yield* LaunchStore).get(input.commandId))
          );
        })
      )
  );

  it.live(
    "a new worktree gets a temporary cairn/<8 hex> branch, then the model's name",
    () =>
      withRepo({ held: true }, ({ dataDir, repo }) =>
        Effect.gen(function* () {
          const script = yield* TitleScript;

          yield* Ref.set(script.branch, Option.some('{"branch": "fix-login"}'));

          const projectId = yield* addProject(repo);
          const launcher = yield* ThreadLaunch;

          const input = yield* launchInput(
            projectId,
            newWorktree,
            "Fix the login page"
          );

          yield* launcher.launch(input, "owner@test");

          const prepared = yield* eventually(row(input.threadId), (shell) =>
            Option.isSome(shell.worktreePath)
          );

          const temporary = Option.getOrThrow(prepared.branch);

          assert.match(temporary, /^cairn\/[0-9a-f]{8}$/u);
          assert.deepStrictEqual(
            prepared.worktreePath,
            Option.some(
              path.join(
                dataDir,
                "worktrees",
                "repo",
                temporary.replace("/", "-")
              )
            )
          );

          yield* script.gate.open;
          yield* launcher.settled(input.threadId);

          const named = yield* row(input.threadId);

          assert.deepStrictEqual(named.branch, Option.some("fix-login"));
          assert.include(yield* branchesOf(repo), "fix-login");
          assert.notInclude(yield* branchesOf(repo), temporary);

          const thread = yield* scriptedThread(input.threadId);

          assert.strictEqual(
            thread?.agent.cwd,
            Option.getOrThrow(named.worktreePath)
          );
        })
      )
  );

  it.live("flattens to cairn-<8 hex> when a plain cairn branch exists", () =>
    withRepo({ held: true }, ({ repo }) =>
      Effect.gen(function* () {
        yield* (yield* Git).stdout("test", repo, ["branch", "cairn"]);

        const projectId = yield* addProject(repo);
        const launcher = yield* ThreadLaunch;

        const input = yield* launchInput(
          projectId,
          newWorktree,
          "Tidy the readme"
        );

        yield* launcher.launch(input, "owner@test");

        const prepared = yield* eventually(row(input.threadId), (shell) =>
          Option.isSome(shell.worktreePath)
        );

        assert.match(
          Option.getOrThrow(prepared.branch),
          /^cairn-[0-9a-f]{8}$/u
        );
        yield* (yield* TitleScript).gate.open;
        yield* launcher.settled(input.threadId);
      })
    )
  );

  it.live("a rename takes the next free name when the model's is taken", () =>
    withRepo({ held: false }, ({ repo }) =>
      Effect.gen(function* () {
        yield* (yield* Git).stdout("test", repo, ["branch", "fix-login"]);
        yield* Ref.set(
          (yield* TitleScript).branch,
          Option.some('Sure: {"branch": "fix-login"}')
        );

        const projectId = yield* addProject(repo);
        const launcher = yield* ThreadLaunch;

        const input = yield* launchInput(
          projectId,
          newWorktree,
          "Fix the login page"
        );

        yield* launcher.launch(input, "owner@test");
        yield* launcher.settled(input.threadId);

        assert.deepStrictEqual(
          (yield* row(input.threadId)).branch,
          Option.some("fix-login-1")
        );
      })
    )
  );

  it.live(
    "a rename falls back to a slug of the message when the model fails",
    () =>
      withRepo({ held: false }, ({ repo }) =>
        Effect.gen(function* () {
          const projectId = yield* addProject(repo);
          const launcher = yield* ThreadLaunch;

          const input = yield* launchInput(
            projectId,
            newWorktree,
            "Fix the flaky login test, then tell me"
          );

          yield* launcher.launch(input, "owner@test");
          yield* launcher.settled(input.threadId);

          const shell = yield* row(input.threadId);

          assert.deepStrictEqual(
            shell.branch,
            Option.some("fix-the-flaky-login-test")
          );
          // No model title either: the placeholder stays.
          assert.strictEqual(
            shell.title,
            "Fix the flaky login test, then tell me"
          );
        })
      )
  );

  it.live(
    "a rename moves every thread that shares the worktree and branch",
    () =>
      withRepo({ held: true }, ({ repo }) =>
        Effect.gen(function* () {
          const script = yield* TitleScript;

          yield* Ref.set(
            script.branch,
            Option.some('{"branch": "shared-work"}')
          );

          const projectId = yield* addProject(repo);
          const launcher = yield* ThreadLaunch;

          const first = yield* launchInput(
            projectId,
            newWorktree,
            "Start the shared work"
          );

          yield* launcher.launch(first, "owner@test");

          const prepared = yield* eventually(row(first.threadId), (shell) =>
            Option.isSome(shell.worktreePath)
          );

          const worktreePath = Option.getOrThrow(prepared.worktreePath);

          const second = yield* launchInput(
            projectId,
            ExistingWorktreeWorkspace.make({
              worktreePath,
              branch: Option.none(),
            }),
            "Help with the shared work"
          );

          yield* launcher.launch(second, "owner@test");
          yield* eventually(row(second.threadId), (shell) =>
            Option.isSome(shell.worktreePath)
          );

          assert.deepStrictEqual(
            (yield* row(second.threadId)).branch,
            prepared.branch
          );

          yield* script.gate.open;
          yield* launcher.settled(first.threadId);
          yield* launcher.settled(second.threadId);

          assert.deepStrictEqual(
            (yield* row(first.threadId)).branch,
            Option.some("shared-work")
          );
          assert.deepStrictEqual(
            (yield* row(second.threadId)).branch,
            Option.some("shared-work")
          );
        })
      )
  );

  it.live("the same command twice gives one thread and one worktree", () =>
    withRepo({ held: false }, ({ repo }) =>
      Effect.gen(function* () {
        const projectId = yield* addProject(repo);
        const launcher = yield* ThreadLaunch;

        const input = yield* launchInput(projectId, newWorktree, "Only once");

        const results = yield* Effect.all(
          [
            launcher.launch(input, "owner@test"),
            launcher.launch(input, "owner@test"),
          ],
          { concurrency: 2 }
        );

        assert.deepStrictEqual(
          results
            .map((result) => String(result.resumed))
            .toSorted((a, b) => a.localeCompare(b)),
          ["false", "true"]
        );

        yield* launcher.settled(input.threadId);

        const again = yield* launcher.launch(input, "owner@test");

        assert.isTrue(again.resumed);

        const threads = yield* (yield* ThreadRows).listByProject(projectId);

        assert.strictEqual(threads.length, 1);
        assert.strictEqual((yield* (yield* Worktrees).list(repo)).length, 2);
        assert.strictEqual((yield* userEntries(input.threadId)).length, 1);
      })
    )
  );

  it.live("a failure after the worktree is added removes it", () => {
    // The first build (the launch's check) passes; the second (the first message) fails.
    const failSecond = Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      return TurnContent.layerFrom([
        textStage,
        {
          name: "flaky",
          run: (draft) =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(calls, (n) => n + 1);

              if (count > 1) {
                return yield* new TurnContentError({
                  message: "The flaky stage refused the turn.",
                  stage: "flaky",
                  reason: "unavailable",
                  field: Option.none(),
                });
              }

              return draft;
            }),
        },
      ]);
    });

    return Effect.flatMap(failSecond, (turnContent) =>
      withRepo({ held: false, turnContent }, ({ repo }) =>
        Effect.gen(function* () {
          const projectId = yield* addProject(repo);
          const launcher = yield* ThreadLaunch;

          const input = yield* launchInput(
            projectId,
            newWorktree,
            "This will fail"
          );

          yield* launcher.launch(input, "owner@test");
          yield* launcher.settled(input.threadId);

          const shell = yield* row(input.threadId);

          assert.strictEqual(shell.activity, "failed");
          assert.deepStrictEqual(
            shell.lastError,
            Option.some("The flaky stage refused the turn.")
          );

          const worktreePath = Option.getOrThrow(shell.worktreePath);
          const fs = yield* FileSystem.FileSystem;

          assert.isFalse(yield* fs.exists(worktreePath));
          assert.strictEqual((yield* (yield* Worktrees).list(repo)).length, 1);
          assert.deepStrictEqual(yield* branchesOf(repo), ["main"]);
          assert.isTrue(
            Option.isNone(yield* (yield* LaunchStore).get(input.commandId))
          );
        })
      )
    );
  });

  it.live("an existing worktree of another repository is refused", () =>
    withRepo({ held: false }, ({ dataDir, repo }) =>
      Effect.gen(function* () {
        const other = path.join(path.dirname(dataDir), "other");

        yield* makeRepository(other);

        const projectId = yield* addProject(repo);
        const launcher = yield* ThreadLaunch;

        const input = yield* launchInput(
          projectId,
          ExistingWorktreeWorkspace.make({
            worktreePath: other,
            branch: Option.none(),
          }),
          "Wrong place"
        );

        yield* launcher.launch(input, "owner@test");
        yield* launcher.settled(input.threadId);

        const shell = yield* row(input.threadId);

        assert.strictEqual(shell.activity, "failed");
        assert.isTrue(
          Option.exists(shell.lastError, (text) =>
            text.includes("is not a worktree of")
          )
        );
      })
    )
  );

  it.live("a launch a restart cut off resumes at boot", () =>
    withRepo({ held: false }, ({ repo }) =>
      Effect.gen(function* () {
        const projectId = yield* addProject(repo);
        const launcher = yield* ThreadLaunch;
        const launches = yield* LaunchStore;

        const input = yield* launchInput(projectId, rootWorkspace, "Resume me");

        // What a launch leaves when the brain stops right after its first commit.
        assert.isTrue(yield* launches.insert(input, "owner@test"));
        yield* (yield* EventSink).commitCommand(
          ThreadCreate.make({
            commandId: input.commandId,
            threadId: input.threadId,
            projectId,
            title: "Resume me",
            provider: input.model.provider,
            modelId: input.model.modelId,
            thinkingLevel: input.thinkingLevel,
            runtimeMode: input.runtimeMode,
            branch: Option.none(),
            worktreePath: Option.none(),
          })
        );

        yield* launcher.resumePending;
        yield* launcher.settled(input.threadId);

        assert.strictEqual((yield* row(input.threadId)).activity, "idle");
        assert.strictEqual((yield* userEntries(input.threadId)).length, 1);
        assert.strictEqual((yield* launches.listPending).length, 0);
      })
    )
  );

  it.live("a thread with no project runs in its own scratch folder", () =>
    withRepo({ held: false }, ({ dataDir }) =>
      Effect.gen(function* () {
        const scratch = yield* (yield* ScratchProject).ensure;
        const launcher = yield* ThreadLaunch;

        const input = yield* launchInput(
          scratch.id,
          rootWorkspace,
          "Plan a trip to Lisbon"
        );

        yield* launcher.launch(input, "owner@test");
        yield* launcher.settled(input.threadId);

        const thread = yield* scriptedThread(input.threadId);
        const cwd = thread?.agent.cwd ?? "";

        assert.strictEqual(path.dirname(cwd), path.join(dataDir, "scratch"));
        assert.match(
          path.basename(cwd),
          /^\d{4}-\d{2}-\d{2}-plan-a-trip-to-lisbon-[0-9a-f]{8}$/u
        );

        const refused = yield* Effect.flip(
          launcher.launch(
            yield* launchInput(scratch.id, newWorktree, "No worktrees here"),
            "owner@test"
          )
        );

        assert.strictEqual(refused._tag, "LaunchError");
      })
    )
  );

  it.live(
    "scratch folder claims are distinct under 20 concurrent callers",
    () =>
      withRepo({ held: false }, () =>
        Effect.gen(function* () {
          const scratch = yield* ScratchProject;

          const input = yield* launchInput(
            (yield* scratch.ensure).id,
            rootWorkspace,
            "Same words for everyone"
          );

          const folders = yield* Effect.all(
            Array.from({ length: 20 }, () =>
              scratch.folderForThread(input.threadId, "Same words for everyone")
            ),
            { concurrency: "unbounded" }
          );

          assert.strictEqual(new Set(folders).size, 20);
        })
      )
  );

  it.live(
    "the scratch project is created once under 20 concurrent callers",
    () =>
      withRepo({ held: false }, () =>
        Effect.gen(function* () {
          const scratch = yield* ScratchProject;

          const projects = yield* Effect.all(
            Array.from({ length: 20 }, () => scratch.ensure),
            { concurrency: "unbounded" }
          );

          assert.strictEqual(
            new Set(projects.map((project) => project.id)).size,
            1
          );

          const live = yield* (yield* Projects).listActive;

          assert.strictEqual(
            live.filter((project) => project.kind === "scratch").length,
            1
          );
        })
      )
  );
});
