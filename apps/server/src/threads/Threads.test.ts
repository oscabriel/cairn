import { RequestId, SubmissionId } from "@cairn/protocol/Ids";
import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { SendInput } from "@cairn/protocol/Thread";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Option, Ref, Schedule } from "effect";
import type { Layer } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { ScriptedStore } from "../brain/ScriptedHarness.ts";
import { LaunchStore } from "./LaunchStore.ts";
import { StopHooks } from "./StopHooks.ts";
import { Threads } from "./Threads.ts";
import {
  addProject,
  HeldModel,
  launchInput,
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

        yield* (yield* Threads).stop({ threadId, clearQueue: false });

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

        yield* (yield* Threads).stop({ threadId, clearQueue: true });

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

  it.live("a thread still launching refuses a turn without submitting it", () =>
    withThread((threadId, projectId) =>
      Effect.gen(function* () {
        const launches = yield* LaunchStore;

        const input = yield* launchInput(
          projectId,
          RootWorkspace.make({ branch: Option.none() }),
          "still launching"
        );

        yield* launches.insert({ ...input, threadId }, "owner@test");

        const refused = yield* Effect.flip(send(threadId, "r1", "followUp"));

        assert.strictEqual(refused._tag, "ThreadNotReady");
        assert.strictEqual(yield* userEntryCount(threadId), 0);
      })
    )
  );
});
