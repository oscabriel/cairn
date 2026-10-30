// Launches and the project thread (the user's decisions of 2026-10-29): the first launch in a folder
// project marks its project thread, a later one refreshes it (the old one stopped and archived), a
// refresh naming a thread that is no longer the project thread makes nothing, a scratch
// launch never touches a mark, and a thread the project thread manages takes every thread command.

import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { RequestId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schedule,
} from "effect";
import type { Layer } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { Projects } from "../projects/Projects.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ThreadCreate } from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { LaunchStore } from "./LaunchStore.ts";
import { ThreadLaunch } from "./ThreadLaunch.ts";
import { Threads } from "./Threads.ts";
import {
  addProject,
  HeldModel,
  launchInput,
  ModelGate,
  threadsTestLayer,
} from "./ThreadsTestKit.ts";
import { TitleModel } from "./TitleModel.ts";

const rootWorkspace = RootWorkspace.make({ branch: Option.none() });

const layerFor = (dataDir: string) =>
  threadsTestLayer({
    dataDir,
    titleModel: TitleModel.layerNone,
    model: HeldModel,
  });

type Services = Layer.Success<ReturnType<typeof layerFor>>;

/** Runs `body` over a fresh folder project; the model holds every answer until `ModelGate.open`. */
const withProject = <A, E>(
  body: (projectId: ProjectId) => Effect.Effect<A, E, Services>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

    return yield* Effect.gen(function* () {
      return yield* body(yield* addProject(root));
    }).pipe(Effect.provide(layerFor(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const launch = Effect.fn("test.launch")(function* (
  projectId: ProjectId,
  text: string,
  replaces: Option.Option<ThreadId> = Option.none()
) {
  const input = yield* launchInput(projectId, rootWorkspace, text);

  const withReplaces = Option.match(replaces, {
    onNone: () => input,
    onSome: (threadId) => ({ ...input, replaces: threadId }),
  });

  yield* (yield* ThreadLaunch).launch(withReplaces, "owner@test");

  return withReplaces;
});

const markOf = Effect.fn("test.markOf")(function* (projectId: ProjectId) {
  const project = yield* (yield* Projects).get(projectId);

  return Option.flatMap(project, (row) => row.shell.projectThreadId);
});

const shellOf = Effect.fn("test.shellOf")(function* (threadId: ThreadId) {
  const row = yield* (yield* ThreadRows).get(threadId);

  assert.isTrue(Option.isSome(row), `thread ${threadId} has a row`);

  return Option.getOrThrow(row).shell;
});

const liveState = Effect.fn("test.liveState")(function* (threadId: ThreadId) {
  const states = yield* (yield* HarnessSeam).inspect;

  return Option.fromNullishOr(
    states.find((state) => state.threadId === threadId)
  );
});

const isRunning = (
  state: Option.Option<{ readonly runId: Option.Option<unknown> }>
) => Option.exists(state, (live) => Option.isSome(live.runId));

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

describe("launching the project thread", () => {
  it.live("the first launch marks it; a refresh stops and archives it", () =>
    withProject((projectId) =>
      Effect.gen(function* () {
        const first = yield* launch(projectId, "first");

        assert.deepStrictEqual(
          yield* markOf(projectId),
          Option.some(first.threadId)
        );
        yield* eventually(liveState(first.threadId), isRunning);

        const second = yield* launch(
          projectId,
          "second",
          Option.some(first.threadId)
        );

        assert.deepStrictEqual(
          yield* markOf(projectId),
          Option.some(second.threadId)
        );
        assert.isTrue(
          Option.isSome((yield* shellOf(first.threadId)).archivedAt)
        );
        // Stopped as an archive stops a thread: nothing runs on out of the sidebar's sight.
        assert.isFalse(isRunning(yield* liveState(first.threadId)));

        // A launch with nothing named replaces whichever is current.
        const third = yield* launch(projectId, "third");

        assert.deepStrictEqual(
          yield* markOf(projectId),
          Option.some(third.threadId)
        );
        assert.isTrue(
          Option.isSome((yield* shellOf(second.threadId)).archivedAt)
        );

        yield* (yield* ModelGate).open;

        for (const input of [first, second, third]) {
          yield* (yield* ThreadLaunch).settled(input.threadId);
        }
      })
    )
  );

  it.live(
    "a refresh naming a thread that is no longer the project thread makes nothing",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          yield* (yield* ModelGate).open;

          const first = yield* launch(projectId, "first");
          const second = yield* launch(projectId, "second");
          const stale = yield* launchInput(projectId, rootWorkspace, "stale");

          const refused = yield* Effect.flip(
            (yield* ThreadLaunch).launch(
              { ...stale, replaces: first.threadId },
              "owner@test"
            )
          );

          assert.strictEqual(refused._tag, "LaunchError");
          assert.deepStrictEqual(
            Predicate.isTagged(refused, "LaunchError")
              ? refused.field
              : Option.none(),
            Option.some("replaces")
          );
          assert.isTrue(
            Option.isNone(yield* (yield* ThreadRows).get(stale.threadId))
          );
          assert.isTrue(
            Option.isNone(yield* (yield* LaunchStore).byThread(stale.threadId))
          );
          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(second.threadId)
          );

          // A resend of the refused refresh (its answer lost to a reconnect) is refused the same way.
          const resent = yield* Effect.flip(
            (yield* ThreadLaunch).launch(
              { ...stale, replaces: first.threadId },
              "owner@test"
            )
          );

          assert.deepStrictEqual(resent, refused);
          assert.isTrue(
            Option.isNone(yield* (yield* ThreadRows).get(stale.threadId))
          );

          for (const input of [first, second]) {
            yield* (yield* ThreadLaunch).settled(input.threadId);
          }
        })
      )
  );

  it.live("scratch launches touch no mark and take no `replaces`", () =>
    withProject((projectId) =>
      Effect.gen(function* () {
        yield* (yield* ModelGate).open;

        const scratch = yield* (yield* ScratchProject).ensure;
        const project = yield* launch(projectId, "project");
        const one = yield* launch(scratch.id, "one");
        const two = yield* launch(scratch.id, "two");

        assert.deepStrictEqual(yield* markOf(scratch.id), Option.none());
        assert.isTrue(Option.isNone((yield* shellOf(one.threadId)).archivedAt));

        const refused = yield* Effect.flip(
          launch(scratch.id, "three", Option.some(two.threadId))
        );

        assert.strictEqual(refused._tag, "LaunchError");

        for (const input of [project, one, two]) {
          yield* (yield* ThreadLaunch).settled(input.threadId);
        }
      })
    )
  );
});

describe("a thread the project thread manages", () => {
  it.live(
    "takes send, steer, stop and configure like any thread, and leaves the mark alone",
    () =>
      withProject((projectId) =>
        Effect.gen(function* () {
          const parent = yield* launch(projectId, "coordinate");
          const sink = yield* EventSink;

          const child = (yield* launchInput(projectId, rootWorkspace, "x"))
            .threadId;

          // Created as a subagent's row is: no launch, a lineage, then its conversation.
          yield* sink.commitCommand(
            ThreadCreate.make({
              commandId: yield* sink.mintCommandId,
              threadId: child,
              projectId,
              title: "child",
              provider: "scripted",
              modelId: "scripted",
              thinkingLevel: "off",
              runtimeMode: "full-access",
              branch: Option.none(),
              worktreePath: Option.none(),
              lineage: Option.some({
                parentThreadId: parent.threadId,
                relationshipToParent: "subagent",
                rootThreadId: parent.threadId,
              }),
            })
          );
          yield* (yield* HarnessSeam).ensureThread({
            threadId: child,
            projectId,
            model: { provider: "scripted", modelId: "scripted" },
            thinkingLevel: "off",
            cwd: "/tmp",
            instructions: Option.none(),
            runtimeMode: "full-access",
          });

          assert.deepStrictEqual(
            yield* markOf(projectId),
            Option.some(parent.threadId)
          );

          const threads = yield* Threads;

          const turn = (requestId: string, whenBusy: "followUp" | "steer") =>
            threads.send(
              {
                threadId: child,
                input: {
                  requestId: RequestId.make(requestId),
                  text: requestId,
                  attachments: [],
                  skillRefs: [],
                },
                whenBusy,
              },
              "owner@test"
            );

          yield* turn("first", "followUp");
          yield* eventually(liveState(child), isRunning);
          yield* turn("steer", "steer");
          yield* threads.configure({
            threadId: child,
            model: Option.none(),
            thinkingLevel: Option.some("low"),
            runtimeMode: Option.none(),
          });
          yield* threads.stop({
            threadId: child,
            clearQueue: true,
            subagents: Option.none(),
          });
          yield* eventually(liveState(child), (state) => !isRunning(state));

          assert.strictEqual((yield* shellOf(child)).thinkingLevel, "low");

          yield* (yield* ModelGate).open;
          yield* (yield* ThreadLaunch).settled(parent.threadId);
        })
      )
  );
});
