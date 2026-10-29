// `shell.dispatch` stops the runs a delete or an archive removes before it commits (T4 of the full
// review): a hung thread that is deleted must free its run, its queue and its Claude Code child.
// Clearing a scratch thread stops its run and its subagents' first and releases its folder after
// the commit; a clear refused for a folder project's thread stops and releases nothing.

import type { ThreadId } from "@cairn/protocol/Ids";
import { ProjectId } from "@cairn/protocol/Ids";
import {
  ProjectDelete,
  ThreadArchive,
  ThreadClear,
  ThreadDelete,
  ThreadRename,
} from "@cairn/protocol/ShellCommands";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { HarnessError } from "../brain/HarnessSeam.ts";
import { FolderRules } from "../projects/FolderRules.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ProjectRegister } from "../shell/ShellCommands.ts";
import {
  createProject,
  createThread,
  ShellRpcs,
  ShellTestLayer,
  testCommandId,
  testThreadId,
  ViewerTest,
} from "../shell/ShellTestKit.ts";
import { Threads } from "../threads/Threads.ts";
import { ShellHandlers } from "./ShellHandlers.ts";

/** The stops each test saw, in order: thread id and whether the queue was cleared. */
const stops: Array<readonly [ThreadId, boolean]> = [];

/** The subagent policy of each stop, in order. */
const policies: Array<string> = [];

/** The threads whose scratch folders were released, in order. */
const released: Array<ThreadId> = [];

/** Thread 3 was never ensured in the brain: its stop fails the way the seam reports that. */
const RecordingThreads = Layer.mock(Threads)({
  stop: (input) =>
    input.threadId === testThreadId(3)
      ? Effect.fail(
          new HarnessError({
            message: "no such thread",
            reason: "thread_not_found",
            retryable: false,
            threadId: Option.some(input.threadId),
          })
        )
      : Effect.sync(() => {
          stops.push([input.threadId, input.clearQueue]);
          policies.push(Option.getOrElse(input.subagents, () => "keep"));
        }),
});

const RecordingScratch = Layer.mock(ScratchProject)({
  root: "/srv/data/scratch",
  releaseThread: (threadId) =>
    Effect.sync(() => {
      released.push(threadId);

      return [];
    }),
});

const AllowAllFolders = Layer.mock(FolderRules)({
  config: { home: "/", deny: [] },
  check: (input) => Effect.succeed(input),
});

const TestLayer = ShellHandlers.pipe(
  Layer.provide(AllowAllFolders),
  Layer.provide(RecordingThreads),
  Layer.provide(RecordingScratch),
  Layer.provideMerge(ShellTestLayer),
  Layer.provideMerge(ViewerTest)
);

const run = <A, E>(
  body: Effect.Effect<A, E, Layer.Success<typeof TestLayer> | Scope.Scope>
) =>
  Effect.sync(() => {
    stops.length = 0;
    policies.length = 0;
    released.length = 0;
  }).pipe(Effect.andThen(body), Effect.scoped, Effect.provide(TestLayer));

const makeClient = RpcTest.makeClient(ShellRpcs);

/** One project with threads 1 to 3. */
const seed = Effect.gen(function* () {
  const client = yield* makeClient;
  const sink = yield* EventSink;
  const { projectId, command } = createProject(1);

  yield* client["shell.dispatch"](command);

  for (const n of [1, 2, 3]) {
    yield* sink.commitCommand(createThread(projectId, n));
  }

  return { client, projectId };
});

describe("shell.dispatch stops the runs it removes", () => {
  it.effect(
    "stops a deleted thread's run, queue cleared, before the delete commits",
    () =>
      run(
        Effect.gen(function* () {
          const { client } = yield* seed;

          yield* client["shell.dispatch"](
            ThreadDelete.make({
              commandId: testCommandId(1),
              threadId: testThreadId(1),
            })
          );

          assert.deepStrictEqual(stops, [[testThreadId(1), true]]);
        })
      )
  );

  it.effect("stops an archived thread's run", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* seed;

        yield* client["shell.dispatch"](
          ThreadArchive.make({
            commandId: testCommandId(2),
            threadId: testThreadId(2),
          })
        );

        assert.deepStrictEqual(stops, [[testThreadId(2), true]]);
      })
    )
  );

  it.effect(
    "stops every live thread of a deleted project, and deletes it even when one was never ensured",
    () =>
      run(
        Effect.gen(function* () {
          const { client, projectId } = yield* seed;

          const result = yield* client["shell.dispatch"](
            ProjectDelete.make({ commandId: testCommandId(3), projectId })
          );

          assert.deepStrictEqual(
            [...stops].toSorted(([a], [b]) => a.localeCompare(b)),
            [
              [testThreadId(1), true],
              [testThreadId(2), true],
            ]
          );
          assert.isAbove(result.sequence, 0);
        })
      )
  );

  it.effect("stops nothing for a command that keeps the thread", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* seed;

        yield* client["shell.dispatch"](
          ThreadRename.make({
            commandId: testCommandId(4),
            threadId: testThreadId(1),
            title: "Renamed",
          })
        );

        assert.deepStrictEqual(stops, []);
      })
    )
  );
});

/** A scratch project with scratch thread 7 in it. */
const seedScratch = Effect.gen(function* () {
  const sink = yield* EventSink;
  const projectId = ProjectId.make("prj_scratch");

  yield* sink.commitCommand(
    ProjectRegister.make({
      commandId: testCommandId(70),
      projectId,
      kind: "scratch",
      title: "No project",
      workspaceRoot: "/srv/data/scratch",
      repository: Option.none(),
    })
  );
  yield* sink.commitCommand(createThread(projectId, 7));
});

describe("shell.dispatch clears a scratch thread", () => {
  it.effect(
    "stops its run and its subagents' first, then releases its folder after the commit",
    () =>
      run(
        Effect.gen(function* () {
          const { client } = yield* seed;

          yield* seedScratch;

          yield* client["shell.dispatch"](
            ThreadClear.make({
              commandId: testCommandId(71),
              threadId: testThreadId(7),
            })
          );

          assert.deepStrictEqual(stops, [[testThreadId(7), true]]);
          assert.deepStrictEqual(policies, ["stop"]);
          assert.deepStrictEqual(released, [testThreadId(7)]);
        })
      )
  );

  it.effect(
    "refuses a folder project's thread without stopping or releasing anything",
    () =>
      run(
        Effect.gen(function* () {
          const { client } = yield* seed;

          const refused = yield* client["shell.dispatch"](
            ThreadClear.make({
              commandId: testCommandId(72),
              threadId: testThreadId(1),
            })
          ).pipe(Effect.flip);

          assert.strictEqual(refused._tag, "InvalidInput");
          assert.deepStrictEqual(stops, []);
          assert.deepStrictEqual(released, []);
        })
      )
  );
});
