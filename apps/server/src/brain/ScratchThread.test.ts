// The scratch thread (the user, 2026-10-29), end to end over real folders: a launch in the scratch
// project runs in a throwaway folder of its own; `ThreadClear` through `shell.dispatch` stops its
// run, deletes its row and removes that folder, leaving every other scratch thread's; the boot
// repair removes folders whose thread is gone and keeps the rest. The clear, which stops a run, is
// judged on both harnesses: the scripted one and pi-durable over pi-ai's faux provider. It sits in
// `brain/` because S42 keeps pi-ai's runtime imports there.

import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import {
  ThreadArchive,
  ThreadClear,
  ThreadDelete,
} from "@cairn/protocol/ShellCommands";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
} from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { FolderRules } from "../projects/FolderRules.ts";
import { folderClaimant, ScratchProject } from "../projects/ScratchProject.ts";
import { ShellHandlers } from "../rpc/ShellHandlers.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ShellRpcs, ViewerTest } from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { ThreadLaunch } from "../threads/ThreadLaunch.ts";
import {
  addProject,
  HeldModel,
  launchInput,
  ModelGate,
  threadsTestLayer,
} from "../threads/ThreadsTestKit.ts";
import { TitleModel } from "../threads/TitleModel.ts";
import { Brain } from "./Brain.ts";
import { piDurableLayer } from "./conformance/Targets.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import { FAUX_MODEL } from "./ModelSource.ts";
import { NO_SUBAGENT_FAULTS } from "./SubagentFaults.ts";

const rootWorkspace = RootWorkspace.make({ branch: Option.none() });

const AllowAllFolders = Layer.mock(FolderRules)({
  config: { home: "/", deny: [] },
  check: (input) => Effect.succeed(input),
});

/** The harness a test runs over. */
type HarnessName = "scripted" | "pi-durable";

const layerFor = (dataDir: string, harness?: Layer.Layer<HarnessSeam>) => {
  const options = {
    dataDir,
    titleModel: TitleModel.layerNone,
    model: HeldModel,
  };

  return ShellHandlers.pipe(
    Layer.provide(AllowAllFolders),
    Layer.provideMerge(
      threadsTestLayer(
        harness === undefined ? options : { ...options, harness }
      )
    ),
    Layer.provideMerge(ViewerTest)
  );
};

type Services = Layer.Success<ReturnType<typeof layerFor>>;

/**
 * A pi-durable brain over `dataDir`, resumed, whose faux model streams one long answer to every
 * request, so a run is still going when the test stops it.
 */
const piDurableBrain = Effect.fn("test.piDurableBrain")(function* (
  dataDir: string
) {
  const context = yield* Layer.build(
    piDurableLayer(path.join(dataDir, "brain"), NO_SUBAGENT_FAULTS).pipe(
      Layer.orDie
    )
  );

  Context.get(context, FauxModels).faux.setResponses(
    Array.from({ length: 8 }, () =>
      fauxAssistantMessage("still thinking ".repeat(40_000))
    )
  );
  yield* Context.get(context, Brain).resume.pipe(Effect.orDie);

  return Layer.succeedContext(context);
});

const withData = <A, E>(
  body: (dataDir: string) => Effect.Effect<A, E, Services | Scope.Scope>,
  harness: HarnessName = "scripted"
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

    const brain =
      harness === "pi-durable" ? yield* piDurableBrain(dataDir) : undefined;

    return yield* body(dataDir).pipe(
      Effect.scoped,
      Effect.provide(layerFor(dataDir, brain))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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

const isRunning = Effect.fn("test.isRunning")(function* (threadId: ThreadId) {
  const states = yield* (yield* HarnessSeam).inspect;

  return states.some(
    (state) => state.threadId === threadId && Option.isSome(state.runId)
  );
});

/** The one folder under the scratch root that `threadId` claimed, read from the names. */
const scratchFolderOf = Effect.fn("test.scratchFolderOf")(function* (
  threadId: ThreadId
) {
  const fs = yield* FileSystem.FileSystem;
  const { root } = yield* ScratchProject;
  const idPart = threadId.toLowerCase().replaceAll("-", "");

  const owned = (yield* fs.readDirectory(root)).filter((name) =>
    Option.exists(folderClaimant(name), (claimant) =>
      idPart.endsWith(claimant.id)
    )
  );

  assert.strictEqual(owned.length, 1, `one folder is ${threadId}'s`);

  return path.join(root, owned[0] ?? "");
});

/**
 * Launches a scratch thread and returns its id and the folder it runs in, once its run started (or,
 * with the model gate open, once its launch settled).
 */
const launchScratch = Effect.fn("test.launchScratch")(function* (
  text: string,
  until: "running" | "settled" = "running"
) {
  const scratch = yield* (yield* ScratchProject).ensure;
  const input = yield* launchInput(scratch.id, rootWorkspace, text);
  // The faux provider answers for this model; the scripted harness takes any.
  const model = FAUX_MODEL;

  yield* (yield* ThreadLaunch).launch({ ...input, model }, "owner@test");

  yield* until === "running"
    ? eventually(isRunning(input.threadId), (running) => running)
    : (yield* ThreadLaunch).settled(input.threadId);

  return {
    threadId: input.threadId,
    folder: yield* scratchFolderOf(input.threadId),
  };
});

const exists = (folder: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(folder));

/** The clear, judged on `harness`. */
const clearCase = (harness: HarnessName) => {
  it.live(
    `a clear stops its run, deletes it and removes its folder, and only its (${harness})`,
    () =>
      withData(
        (dataDir) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const client = yield* RpcTest.makeClient(ShellRpcs);

            // The seam under judgement is the one asked for: the scripted one runs no real model.
            assert.strictEqual(
              (yield* HarnessSeam).capabilities.live,
              harness === "pi-durable"
            );

            const cleared = yield* launchScratch("What is a cairn");
            const kept = yield* launchScratch("Another question");

            assert.strictEqual(
              path.dirname(cleared.folder),
              path.join(dataDir, "scratch")
            );
            yield* fs.writeFileString(
              path.join(cleared.folder, "notes.md"),
              "scratch work"
            );

            const clear = ThreadClear.make({
              commandId: yield* (yield* EventSink).mintCommandId,
              threadId: cleared.threadId,
            });

            const first = yield* client["shell.dispatch"](clear);

            assert.isFalse(yield* isRunning(cleared.threadId));
            assert.isFalse(yield* exists(cleared.folder));

            const row = yield* (yield* ThreadRows).get(cleared.threadId);

            assert.isTrue(
              Option.exists(row, (found) => Option.isSome(found.deletedAt))
            );

            // The other scratch thread keeps its folder and its run.
            assert.isTrue(yield* exists(kept.folder));
            assert.isTrue(yield* isRunning(kept.threadId));

            // A resend answers the same and removes nothing more.
            const again = yield* client["shell.dispatch"](clear);

            assert.strictEqual(again.sequence, first.sequence);
            assert.isTrue(yield* exists(kept.folder));

            yield* (yield* ModelGate).open;
            yield* (yield* ThreadLaunch).settled(kept.threadId);
          }),
        harness
      ),
    30_000
  );
};

describe("the scratch thread", () => {
  clearCase("scripted");
  clearCase("pi-durable");

  it.live(
    "a clear of a folder project's thread is refused and stops nothing",
    () =>
      withData((dataDir) =>
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(ShellRpcs);
          const fs = yield* FileSystem.FileSystem;
          const repo = path.join(dataDir, "repo");

          yield* fs.makeDirectory(repo);

          const projectId = yield* addProject(repo);
          const input = yield* launchInput(projectId, rootWorkspace, "work");

          yield* (yield* ThreadLaunch).launch(input, "owner@test");
          yield* eventually(isRunning(input.threadId), (running) => running);

          const refused = yield* client["shell.dispatch"](
            ThreadClear.make({
              commandId: yield* (yield* EventSink).mintCommandId,
              threadId: input.threadId,
            })
          ).pipe(Effect.flip);

          assert.strictEqual(refused._tag, "InvalidInput");
          assert.isTrue(yield* isRunning(input.threadId));

          yield* (yield* ModelGate).open;
          yield* (yield* ThreadLaunch).settled(input.threadId);
        })
      )
  );

  it.live(
    "the boot repair removes folders whose thread is gone and keeps live, archived and unknown ones",
    () =>
      withData(() =>
        Effect.gen(function* () {
          yield* (yield* ModelGate).open;

          const fs = yield* FileSystem.FileSystem;
          const scratch = yield* ScratchProject;
          const sink = yield* EventSink;
          const live = yield* launchScratch("Still here", "settled");
          const deleted = yield* launchScratch("Deleted by hand", "settled");

          const archived = yield* launchScratch(
            "Archived for later",
            "settled"
          );

          yield* sink.commitCommand(
            ThreadDelete.make({
              commandId: yield* sink.mintCommandId,
              threadId: deleted.threadId,
            })
          );
          yield* sink.commitCommand(
            ThreadArchive.make({
              commandId: yield* sink.mintCommandId,
              threadId: archived.threadId,
            })
          );

          // A folder a launch claimed for a thread that never came to be, a name the scratch
          // project never makes, and a file with a claimant's name.
          const orphan = path.join(scratch.root, "2026-10-29-orphan-deadbeef");
          const unknown = path.join(scratch.root, "my-notes");
          const file = path.join(scratch.root, "2026-10-29-file-0123abcd");

          yield* fs.makeDirectory(orphan);
          yield* fs.makeDirectory(unknown);
          yield* fs.writeFileString(file, "");

          const removed = yield* scratch.repair;

          assert.deepStrictEqual(
            [...removed].toSorted(),
            [deleted.folder, orphan].toSorted()
          );

          for (const kept of [live.folder, archived.folder, unknown, file]) {
            assert.isTrue(yield* exists(kept), `${kept} is kept`);
          }

          assert.deepStrictEqual(yield* scratch.repair, []);
        })
      )
  );
});

describe(folderClaimant, () => {
  it("reads the id part of each name folderForThread makes, and nothing else", () => {
    const full = "0199f0c26a4e7d4c8a6b000000000001";

    assert.deepStrictEqual(
      folderClaimant("2026-10-29-plan-a-trip-0000abcd"),
      Option.some({ kind: "short" as const, id: "0000abcd" })
    );
    assert.deepStrictEqual(
      folderClaimant(`2026-10-29-plan-${full}`),
      Option.some({ kind: "full" as const, id: full })
    );
    assert.deepStrictEqual(
      folderClaimant(`2026-10-29-plan-${full}-00ff0a`),
      Option.some({ kind: "full" as const, id: full })
    );
    assert.isTrue(Option.isNone(folderClaimant("my-notes")));
    assert.isTrue(Option.isNone(folderClaimant("2026-10-29-plan-00ff0a")));
  });
});
