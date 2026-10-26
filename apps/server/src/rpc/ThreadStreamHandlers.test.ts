// The thread stream's RPC handlers and the entry image route over the scripted harness: a fresh
// snapshot first, history paging, full entries, image bytes by reference, the protocol error each
// seam failure becomes, and a subscribe that arrives while its thread is still launching.

import path from "node:path";

import {
  ConversationId,
  EntryId,
  ProjectId,
  RequestId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { NewWorktreeWorkspace } from "@cairn/protocol/Launch";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Latch,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";
import { HttpRouter } from "effect/http";

import { EntryImageRoute } from "../brain/EntryImageRoute.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL } from "../brain/ModelSource.ts";
import { ScriptedHarness } from "../brain/ScriptedHarness.ts";
import { Database } from "../db/Database.ts";
import { Launches0002 } from "../db/migrations/0002Launches.ts";
import { ShellProjector } from "../shell/ShellProjector.ts";
import { LaunchStore } from "../threads/LaunchStore.ts";
import { ThreadLaunch } from "../threads/ThreadLaunch.ts";
import { LaunchWait } from "../threads/Threads.ts";
import {
  addProject,
  heldWorktrees,
  HeldModel,
  launchInput,
  makeRepository,
  ModelGate,
  threadsTestLayer,
  TitleModelScripted,
} from "../threads/ThreadsTestKit.ts";
import {
  ThreadStreamHandlers,
  threadStreamHandlers,
} from "./ThreadStreamHandlers.ts";

const isNotFound = Predicate.isTagged("NotFound");

/** The scripted harness with an empty `thread_launches`: no thread is launching. */
const HarnessNoLaunches = Layer.mergeAll(
  ScriptedHarness.layer,
  LaunchStore.layerNoDeps.pipe(
    Layer.provide(Database.layerTest({ "0002_Launches": Launches0002 }))
  )
);

const launchLayer = (dataDir: string, gate: Latch.Latch) =>
  threadsTestLayer({
    dataDir,
    titleModel: TitleModelScripted({ held: false }),
    model: HeldModel,
    worktrees: heldWorktrees(gate),
  });

/**
 * Runs `body` over the launch services and a repository at `repo/`, with worktree creation held
 * until `gate` opens.
 */
const withHeldLaunches = <A, E>(
  body: (repo: string, gate: Latch.Latch) => Effect.Effect<A, E, LaunchServices>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const repo = path.join(root, "repo");
    const gate = yield* Latch.make(false);

    return yield* Effect.gen(function* () {
      yield* makeRepository(repo);
      yield* (yield* ModelGate).open;

      return yield* body(repo, gate);
    }).pipe(Effect.provide(launchLayer(path.join(root, "data"), gate)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

type LaunchServices = Layer.Success<ReturnType<typeof launchLayer>>;

const worktree = (baseRef: string) =>
  NewWorktreeWorkspace.make({
    baseRef,
    branch: Option.none(),
    startFromOrigin: false,
  });

/** Whether `fiber` is still running after a moment. */
const stillWaiting = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(200));

    return fiber.pollUnsafe() === undefined;
  });

const THREAD = ThreadId.make("0190f0c0-0000-7000-8000-0000000000a1");

const UNKNOWN = ThreadId.make("0190f0c0-0000-7000-8000-0000000000a2");

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** One thread with a turn that carried an image, answered. */
const seeded = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  yield* seam.ensureThread({
    threadId: THREAD,
    projectId: ProjectId.make("rpc"),
    model: FAUX_MODEL,
    thinkingLevel: "off",
    cwd: "/tmp",
    instructions: Option.none(),
  });

  const ended = yield* seam.events.pipe(
    Stream.filter(Predicate.isTagged("RunTerminal")),
    Stream.runHead,
    Effect.forkChild
  );

  yield* Effect.sleep("10 millis");
  yield* seam.submit(THREAD, {
    requestId: RequestId.make("r1"),
    content: [
      { type: "text", text: "look" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ],
    entry: Option.none(),
    whenBusy: "followUp",
  });
  yield* Fiber.join(ended);
});

describe("thread stream handlers", () => {
  it.live("serve a snapshot, history and full entries, and map failures", () =>
    Effect.gen(function* () {
      yield* seeded;

      const handlers = yield* threadStreamHandlers;

      const [first] = yield* handlers
        .subscribe({ threadId: THREAD, conversationId: Option.none() })
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(first?._tag, "Snapshot");

      const entries = first?._tag === "Snapshot" ? first.view.entries : [];
      const user = entries.find((entry) => entry.kind === "pi.user");
      const last = entries.at(-1);

      assert.isDefined(user);
      assert.notInclude(JSON.stringify(entries), PNG_BASE64.slice(0, 20));

      const page = yield* handlers.history({
        threadId: THREAD,
        conversationId: Option.none(),
        before: last?.id ?? EntryId.make(1),
        limit: 10,
      });

      assert.deepStrictEqual(
        page.entries.map((entry) => entry.id),
        entries.slice(0, -1).map((entry) => entry.id)
      );
      assert.isFalse(page.hasMore);

      const full = yield* handlers.entry({
        threadId: THREAD,
        entryId: user?.id ?? EntryId.make(1),
      });

      assert.isFalse(full.truncated);
      assert.strictEqual(full.entry.kind, "pi.user");

      const unknown = yield* handlers
        .subscribe({ threadId: UNKNOWN, conversationId: Option.none() })
        .pipe(Stream.runCollect, Effect.flip);

      assert.strictEqual(unknown._tag, "NotFound");
      assert.strictEqual(isNotFound(unknown) ? unknown.resource : "", "thread");

      const subagent = yield* handlers
        .history({
          threadId: THREAD,
          conversationId: Option.some(ConversationId.make(99)),
          before: EntryId.make(5),
          limit: 5,
        })
        .pipe(Effect.flip);

      assert.strictEqual(subagent._tag, "NotFound");

      const missingEntry = yield* handlers
        .entry({ threadId: THREAD, entryId: EntryId.make(9999) })
        .pipe(Effect.flip);

      assert.strictEqual(
        isNotFound(missingEntry) ? missingEntry.resource : "",
        "entry"
      );

      const missingTask = yield* handlers
        .retryTask({ threadId: THREAD, taskId: TaskId.make(77) })
        .pipe(Effect.flip);

      assert.strictEqual(
        isNotFound(missingTask) ? missingTask.resource : "",
        "task"
      );

      // The handler group builds over the seam.
      const built = yield* Layer.build(ThreadStreamHandlers.layer).pipe(
        Effect.exit
      );

      assert.isTrue(Exit.isSuccess(built));
    }).pipe(Effect.scoped, Effect.provide(HarnessNoLaunches))
  );

  it.live("the entry image route returns the bytes an entry holds", () =>
    Effect.gen(function* () {
      yield* seeded;

      const seam = yield* HarnessSeam;

      const [first] = yield* seam
        .watch(THREAD)
        .pipe(Stream.take(1), Stream.runCollect);

      const user =
        first?._tag === "Snapshot"
          ? first.view.entries.find((entry) => entry.kind === "pi.user")
          : undefined;

      const { handler, dispose } = HttpRouter.toWebHandler(
        EntryImageRoute.pipe(Layer.provide(Layer.succeed(HarnessSeam, seam))),
        { disableLogger: true }
      );

      const get = (address: string) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request(`http://cairn.test${address}`)
          );

          const body = await response.arrayBuffer();

          return {
            status: response.status,
            type: response.headers.get("content-type"),
            cache: response.headers.get("cache-control"),
            bytes: body.byteLength,
          };
        });

      const image = yield* get(
        `/api/threads/${THREAD}/entries/${user?.id ?? 0}/images/0`
      );

      assert.deepStrictEqual(image, {
        status: 200,
        type: "image/png",
        cache: "private, max-age=31536000, immutable",
        bytes: Buffer.from(PNG_BASE64, "base64").byteLength,
      });

      const missing = yield* get(
        `/api/threads/${THREAD}/entries/${user?.id ?? 0}/images/3`
      );

      assert.strictEqual(missing.status, 404);

      const malformed = yield* get(
        `/api/threads/${THREAD}/entries/abc/images/0`
      );

      assert.strictEqual(malformed.status, 400);

      yield* Effect.promise(async () => {
        await dispose();
      });
    }).pipe(Effect.provide(ScriptedHarness.layer))
  );

  it.live(
    "a subscribe while the thread is launching waits for its ensure, then starts with a snapshot",
    () =>
      withHeldLaunches((repo, gate) =>
        Effect.gen(function* () {
          const projectId = yield* addProject(repo);

          const input = yield* launchInput(
            projectId,
            worktree("main"),
            "Wait for me"
          );

          yield* (yield* ThreadLaunch).launch(input, "owner@test");

          const handlers = yield* threadStreamHandlers;

          const first = yield* handlers
            .subscribe({
              threadId: input.threadId,
              conversationId: Option.none(),
            })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          assert.isTrue(
            yield* stillWaiting(first),
            "the subscribe waits while the worktree is held"
          );

          yield* gate.open;

          const [item] = yield* Fiber.join(first);

          assert.strictEqual(item?._tag, "Snapshot");
          yield* (yield* ThreadLaunch).settled(input.threadId);
        })
      )
  );

  it.live(
    "a subscribe waiting on a launch that fails before its ensure ends NotFound",
    () =>
      withHeldLaunches((repo, gate) =>
        Effect.gen(function* () {
          const projectId = yield* addProject(repo);

          const input = yield* launchInput(
            projectId,
            worktree("no-such-ref"),
            "This launch fails"
          );

          yield* (yield* ThreadLaunch).launch(input, "owner@test");

          const ended = yield* (yield* threadStreamHandlers)
            .subscribe({
              threadId: input.threadId,
              conversationId: Option.none(),
            })
            .pipe(Stream.runCollect, Effect.flip, Effect.forkChild);

          assert.isTrue(yield* stillWaiting(ended));

          yield* gate.open;

          const failure = yield* Fiber.join(ended);

          assert.strictEqual(failure._tag, "NotFound");
          yield* (yield* ThreadLaunch).settled(input.threadId);
        })
      )
  );

  it.live("a subscribe gives up on a launch after LaunchWait", () =>
    withHeldLaunches((repo, gate) =>
      Effect.gen(function* () {
        const projectId = yield* addProject(repo);

        const input = yield* launchInput(
          projectId,
          worktree("main"),
          "Held for good"
        );

        yield* (yield* ThreadLaunch).launch(input, "owner@test");

        const failure = yield* (yield* threadStreamHandlers)
          .subscribe({
            threadId: input.threadId,
            conversationId: Option.none(),
          })
          .pipe(
            Stream.runCollect,
            Effect.flip,
            Effect.provideService(LaunchWait, Duration.millis(300))
          );

        assert.strictEqual(failure._tag, "NotFound");

        // Let the launch finish, so the test's scope closes over a quiet fiber.
        yield* gate.open;
        yield* (yield* ThreadLaunch).settled(input.threadId);
      })
    )
  );

  it.effect(
    "a retried task's row is refreshed at once, not at the next reconcile",
    () =>
      Effect.gen(function* () {
        const refreshed: Array<string> = [];

        const projector = ShellProjector.of({
          reconcile: Effect.succeed({ threads: 0, live: 0, patched: 0 }),
          refresh: (threadId) =>
            Effect.sync(() => {
              refreshed.push(threadId);
            }),
          flushAll: Effect.void,
        });

        const retrying = Layer.effect(
          HarnessSeam,
          HarnessSeam.useSync((seam) =>
            HarnessSeam.of({ ...seam, retry: () => Effect.void })
          )
        ).pipe(Layer.provide(ScriptedHarness.layer));

        const handlers = yield* threadStreamHandlers.pipe(
          Effect.provideService(ShellProjector, projector),
          Effect.provide(
            Layer.merge(
              retrying,
              LaunchStore.layerNoDeps.pipe(
                Layer.provide(
                  Database.layerTest({ "0002_Launches": Launches0002 })
                )
              )
            )
          )
        );

        yield* handlers.retryTask({
          threadId: THREAD,
          taskId: TaskId.make(77),
        });

        assert.deepStrictEqual(refreshed, [THREAD]);
      })
  );
});
