import path from "node:path";

import { RequestId, SubmissionId } from "@cairn/protocol/Ids";
import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { NewWorktreeWorkspace, RootWorkspace } from "@cairn/protocol/Launch";
import type { ThreadLaunchInput } from "@cairn/protocol/Launch";
import { ThreadSettle } from "@cairn/protocol/ShellCommands";
import type { SendInput } from "@cairn/protocol/Thread";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Latch,
  Option,
  Predicate,
  Ref,
  Schedule,
  Stream,
} from "effect";
import type { Layer } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { ScriptedStore } from "../brain/ScriptedHarness.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ThreadCreate } from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { LaunchStore } from "./LaunchStore.ts";
import { StopHooks } from "./StopHooks.ts";
import { STOPPED_BEFORE_START, ThreadLaunch } from "./ThreadLaunch.ts";
import { LaunchWait, Threads } from "./Threads.ts";
import {
  addProject,
  HeldModel,
  heldWorktrees,
  launchInput,
  makeRepository,
  ModelGate,
  threadsTestLayer,
} from "./ThreadsTestKit.ts";
import { TitleModel } from "./TitleModel.ts";

const stopped = Ref.makeUnsafe<ReadonlyArray<ThreadId>>([]);

const RecordingStopHooks = StopHooks.layerFrom([
  {
    name: "record",
    run: (threadId: ThreadId) =>
      Ref.update(stopped, (all) => [...all, threadId]),
  },
]);

const layerFor = (dataDir: string) =>
  threadsTestLayer({
    dataDir,
    titleModel: TitleModel.layerNone,
    model: HeldModel,
    stopHooks: RecordingStopHooks,
  });

/** Runs `body` with a fresh thread ensured in the scripted harness; its model answers on `open`. */
const withThread = <A, E>(
  body: (
    threadId: ThreadId,
    projectId: ProjectId
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>>>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

    return yield* Effect.gen(function* () {
      const projectId = yield* addProject(root);

      const input = yield* launchInput(
        projectId,
        RootWorkspace.make({ branch: Option.none() }),
        "x"
      );

      yield* (yield* HarnessSeam).ensureThread({
        threadId: input.threadId,
        projectId,
        model: input.model,
        thinkingLevel: "off",
        cwd: root,
        instructions: Option.none(),
      });

      return yield* body(input.threadId, projectId);
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const newWorktree = NewWorktreeWorkspace.make({
  baseRef: "main",
  branch: Option.none(),
  startFromOrigin: false,
});

/**
 * Runs `body` with a project over a fresh repository whose new worktrees wait for `gate`, so a
 * launch into one stays in its workspace phase until the test opens it.
 */
const withHeldWorkspace = <A, E>(
  body: (
    projectId: ProjectId,
    gate: Latch.Latch
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>>>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const repo = path.join(root, "repo");
    const gate = yield* Latch.make(false);

    const layer = threadsTestLayer({
      dataDir: path.join(root, "data"),
      titleModel: TitleModel.layerNone,
      model: HeldModel,
      stopHooks: RecordingStopHooks,
      worktrees: heldWorktrees(gate),
    });

    return yield* Effect.gen(function* () {
      yield* makeRepository(repo);
      yield* (yield* ModelGate).open;

      return yield* body(yield* addProject(repo), gate);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** The thread row a launch commits first, as a launch a restart cut off leaves it. */
const createThreadRow = Effect.fn("test.createThreadRow")(function* (
  input: ThreadLaunchInput
) {
  yield* (yield* EventSink).commitCommand(
    ThreadCreate.make({
      commandId: input.commandId,
      threadId: input.threadId,
      projectId: input.projectId,
      title: "still launching",
      provider: input.model.provider,
      modelId: input.model.modelId,
      thinkingLevel: input.thinkingLevel,
      runtimeMode: input.runtimeMode,
      branch: Option.none(),
      worktreePath: Option.none(),
    })
  );
});

const send = (
  threadId: ThreadId,
  requestId: string,
  whenBusy: SendInput["whenBusy"]
) =>
  Threads.use((threads) =>
    threads.send(
      {
        threadId,
        input: {
          requestId: RequestId.make(requestId),
          text: `message ${requestId}`,
          attachments: [],
          skillRefs: [],
        },
        whenBusy,
      },
      "owner@test"
    )
  );

const liveState = Effect.fn("test.liveState")(function* (threadId: ThreadId) {
  const states = yield* (yield* HarnessSeam).inspect;

  return Option.fromNullishOr(
    states.find((state) => state.threadId === threadId)
  );
});

const eventually = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  check: (value: A) => boolean
) =>
  read.pipe(
    Effect.repeat({
      until: check,
      schedule: Schedule.spaced(Duration.millis(10)),
    }),
    Effect.timeout(Duration.seconds(5))
  );

const isRunning = (
  state: Option.Option<{ readonly runId: Option.Option<unknown> }>
) => Option.exists(state, (live) => Option.isSome(live.runId));

const queueLength = (state: Option.Option<{ readonly queueLength: number }>) =>
  Option.match(state, { onNone: () => 0, onSome: (live) => live.queueLength });

const userEntryCount = Effect.fn("test.userEntryCount")(function* (
  threadId: ThreadId
) {
  const thread = (yield* ScriptedStore).threads.get(threadId);

  return thread === undefined
    ? 0
    : thread.entries.filter((entry) => entry.kind === "cairn.user").length;
});

describe("thread commands", () => {
  it.live(
    "a sent message brings a thread settled by hand back to the active shelf",
    () =>
      withThread((threadId, projectId) =>
        Effect.gen(function* () {
          const sink = yield* EventSink;
          const rows = yield* ThreadRows;

          yield* sink.commitCommand(
            ThreadCreate.make({
              commandId: yield* sink.mintCommandId,
              threadId,
              projectId,
              title: "settled by hand",
              provider: "faux",
              modelId: "faux",
              thinkingLevel: "off",
              runtimeMode: "full-access",
              branch: Option.none(),
              worktreePath: Option.none(),
            })
          );
          yield* sink.commitCommand(
            ThreadSettle.make({
              commandId: yield* sink.mintCommandId,
              threadId,
            })
          );

          yield* send(threadId, "r1", "followUp");

          const row = yield* rows.get(threadId);

          assert.isTrue(
            Option.exists(row, ({ shell }) =>
              Option.isNone(shell.settledOverride)
            )
          );
          yield* (yield* ModelGate).open;
          yield* eventually(liveState(threadId), (state) => !isRunning(state));
        })
      )
  );

  it.live("a resent turn with the same request id is admitted once", () =>
    withThread((threadId) =>
      Effect.gen(function* () {
        const first = yield* send(threadId, "r1", "followUp");
        const again = yield* send(threadId, "r1", "followUp");

        assert.strictEqual(again.submissionId, first.submissionId);
        yield* (yield* ModelGate).open;
        yield* eventually(liveState(threadId), (state) => !isRunning(state));
        assert.strictEqual(yield* userEntryCount(threadId), 1);
      })
    )
  );

  it.live("stop keeps the queued inputs and runs the stop hooks", () =>
    withThread((threadId) =>
      Effect.gen(function* () {
        yield* send(threadId, "r1", "followUp");
        yield* eventually(liveState(threadId), isRunning);
        yield* send(threadId, "r2", "followUp");
        assert.strictEqual(queueLength(yield* liveState(threadId)), 1);

        yield* (yield* Threads).stop({
          threadId,
          clearQueue: false,
          subagents: Option.none(),
        });

        const after = yield* eventually(
          liveState(threadId),
          (state) => !isRunning(state)
        );

        assert.strictEqual(queueLength(after), 1);
        assert.include(yield* Ref.get(stopped), threadId);
      })
    )
  );

  it.live("stop with clear withdraws the queued inputs too", () =>
    withThread((threadId) =>
      Effect.gen(function* () {
        yield* send(threadId, "r1", "followUp");
        yield* eventually(liveState(threadId), isRunning);
        yield* send(threadId, "r2", "followUp");

        yield* (yield* Threads).stop({
          threadId,
          clearQueue: true,
          subagents: Option.none(),
        });

        const after = yield* eventually(
          liveState(threadId),
          (state) => !isRunning(state)
        );

        assert.strictEqual(queueLength(after), 0);
      })
    )
  );

  it.live("withdraw takes back a queued input but not one already placed", () =>
    withThread((threadId) =>
      Effect.gen(function* () {
        const threads = yield* Threads;
        const placed = yield* send(threadId, "r1", "followUp");

        yield* eventually(liveState(threadId), isRunning);

        const queued = yield* send(threadId, "r2", "followUp");

        assert.deepStrictEqual(
          yield* threads.withdraw({
            threadId,
            submissionId: placed.submissionId,
          }),
          { withdrawn: false }
        );
        assert.deepStrictEqual(
          yield* threads.withdraw({
            threadId,
            submissionId: queued.submissionId,
          }),
          { withdrawn: true }
        );
        assert.strictEqual(queueLength(yield* liveState(threadId)), 0);

        const missing = yield* Effect.flip(
          threads.withdraw({ threadId, submissionId: SubmissionId.make(9999) })
        );

        assert.strictEqual(missing.reason, "submission_not_found");
      })
    )
  );

  it.live("a busy thread refuses a turn sent with whenBusy reject", () =>
    withThread((threadId) =>
      Effect.gen(function* () {
        yield* send(threadId, "r1", "followUp");
        yield* eventually(liveState(threadId), isRunning);

        const refused = yield* Effect.flip(send(threadId, "r2", "reject"));

        assert.strictEqual(refused._tag, "HarnessError");
      })
    )
  );

  it.live(
    "a turn sent during a launch that outlasts LaunchWait follows it and lands after the first message",
    () =>
      withHeldWorkspace((projectId, gate) =>
        Effect.gen(function* () {
          const launcher = yield* ThreadLaunch;

          const input = yield* launchInput(
            projectId,
            newWorktree,
            "first message"
          );

          yield* launcher.launch(input, "owner@test");

          const sending = yield* Effect.forkChild(
            send(input.threadId, "r1", "followUp").pipe(
              Effect.provideService(LaunchWait, Duration.millis(250))
            )
          );

          // The launch finishes at 400 ms, after the 250 ms wait would have refused the turn.
          yield* Effect.sleep(Duration.millis(400));
          yield* gate.open;

          yield* Fiber.join(sending);

          yield* eventually(
            userEntryCount(input.threadId),
            (count) => count >= 2
          );

          const thread = (yield* ScriptedStore).threads.get(input.threadId);

          const texts = (thread?.entries ?? [])
            .filter((entry) => entry.kind === "cairn.user")
            .map((entry) => JSON.stringify(entry.model));

          assert.strictEqual(texts.length, 2);
          assert.include(texts[0], "first message");
          assert.include(texts[1], "message r1");
        })
      )
  );

  it.live(
    "a turn sent while a restart's launch waits to resume polls for it, then lands",
    () =>
      withThread((threadId, projectId) =>
        Effect.gen(function* () {
          const launches = yield* LaunchStore;

          const input = yield* launchInput(
            projectId,
            RootWorkspace.make({ branch: Option.none() }),
            "still launching"
          );

          yield* launches.insert({ ...input, threadId }, "owner@test");
          yield* createThreadRow({ ...input, threadId });

          const sending = yield* Effect.forkChild(
            send(threadId, "r1", "followUp")
          );

          yield* Effect.sleep(Duration.millis(300));
          assert.strictEqual(yield* userEntryCount(threadId), 0);

          // The launch finishes.
          yield* launches.remove(input.commandId);

          yield* Fiber.join(sending);
          assert.strictEqual(yield* userEntryCount(threadId), 1);
        })
      )
  );

  it.live(
    "a restart's launch that does not resume within LaunchWait refuses a turn without submitting it",
    () =>
      withThread((threadId, projectId) =>
        Effect.gen(function* () {
          const launches = yield* LaunchStore;

          const input = yield* launchInput(
            projectId,
            RootWorkspace.make({ branch: Option.none() }),
            "still launching"
          );

          yield* launches.insert({ ...input, threadId }, "owner@test");
          yield* createThreadRow({ ...input, threadId });

          const refused = yield* Effect.flip(
            send(threadId, "r1", "followUp").pipe(
              Effect.provideService(LaunchWait, Duration.millis(250))
            )
          );

          assert.strictEqual(refused._tag, "ThreadNotReady");
          assert.strictEqual(yield* userEntryCount(threadId), 0);
        })
      )
  );

  it.live(
    "a turn for a launch row whose thread was never created is refused at once",
    () =>
      withThread((threadId, projectId) =>
        Effect.gen(function* () {
          const launches = yield* LaunchStore;

          const input = yield* launchInput(
            projectId,
            RootWorkspace.make({ branch: Option.none() }),
            "cut off"
          );

          // What a launch leaves when the brain stops between its two inserts.
          yield* launches.insert({ ...input, threadId }, "owner@test");

          const started = yield* Clock.currentTimeMillis;
          const refused = yield* Effect.flip(send(threadId, "r1", "followUp"));
          const took = (yield* Clock.currentTimeMillis) - started;

          assert.strictEqual(refused._tag, "ThreadLaunchLost");
          assert.isBelow(took, 1000);
          assert.strictEqual(yield* userEntryCount(threadId), 0);
        })
      )
  );

  it.live(
    "a stop during the workspace phase cancels the launch: no run starts and the row is failed",
    () =>
      withHeldWorkspace((projectId, gate) =>
        Effect.gen(function* () {
          const launcher = yield* ThreadLaunch;
          const launches = yield* LaunchStore;
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

          yield* Effect.forkChild(
            (yield* HarnessSeam).events.pipe(
              Stream.runForEach((event) =>
                Ref.update(events, (all) => [...all, event])
              )
            )
          );

          const input = yield* launchInput(
            projectId,
            newWorktree,
            "Never runs"
          );

          yield* launcher.launch(input, "owner@test");

          // The worktree is planned and its creation held: the launch is in its workspace phase.
          const planned = yield* eventually(
            launches.get(input.commandId),
            (found) =>
              Option.exists(found, (row) => Option.isSome(row.worktreePath))
          );

          yield* (yield* Threads).stop({
            threadId: input.threadId,
            clearQueue: false,
            subagents: Option.none(),
          });

          // A launch that carried on would now make its worktree and start the run.
          yield* gate.open;
          yield* launcher.settled(input.threadId);
          yield* Effect.sleep(Duration.millis(200));

          const { shell } = Option.getOrThrow(
            yield* (yield* ThreadRows).get(input.threadId)
          );

          assert.strictEqual(shell.activity, "failed");
          assert.deepStrictEqual(
            shell.lastError,
            Option.some(STOPPED_BEFORE_START)
          );
          assert.isFalse(
            (yield* Ref.get(events)).some(
              (event) =>
                Predicate.isTagged(event, "RunStarted") &&
                event.threadId === input.threadId
            )
          );
          assert.isUndefined(
            (yield* ScriptedStore).threads.get(input.threadId)
          );
          assert.isTrue(Option.isNone(yield* launches.get(input.commandId)));

          const worktreePath = Option.getOrThrow(
            Option.flatMap(planned, (row) => row.worktreePath)
          );

          assert.isFalse(
            yield* (yield* FileSystem.FileSystem).exists(worktreePath)
          );
        })
      )
  );
});
