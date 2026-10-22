// The `bridge-cwd` extension and the bridge's stop hook under a real pi-durable Harness, over the
// bridge on a scripted Claude Code (`BridgeProvider.layerTest`):
//
// - a thread on a bridge model starts its child in the realpath of the thread's cwd (here reached
//   through a symlink), and the hook records the thread's provider session id;
// - a thread on another model is never noted;
// - the stop hook kills a child held on a tool call, so it does not outlive the stopped run.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  initEvent,
  SCRIPT_SESSION,
  textTurn,
  toolTurn,
} from "@cairn/bridge/ClaudeScriptKit";
import type { FakeScript } from "@cairn/bridge/ClaudeSdk";
import { ClaudeSdkScripts } from "@cairn/bridge/ClaudeSdk";
import type { ThreadId } from "@cairn/protocol/Ids";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import type { ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Schedule } from "effect";

import { BridgeProvider } from "../models/BridgeProvider.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { bridgeStopHook } from "../threads/BridgeStopHook.ts";
import {
  BridgeCwd,
  rememberSession,
  SESSIONS_PER_THREAD,
  THREADS_KEPT,
} from "./BridgeCwdExtension.ts";
import { ThreadMeta } from "./CairnDocs.ts";

const context = BACKGROUND_CONTEXT;

const HAIKU: ModelRef = {
  provider: "claude-bridge",
  modelId: "claude-haiku-5-5",
};

/** A tool that waits until its call is aborted. */
const hold = defineExtension({
  name: "test.hold",
  tools: [
    defineTool({
      name: "hold",
      description: "Waits until stopped.",
      parameters: Type.Object({}),
      execute: async (_args, _api, toolContext) => {
        await wait(600_000, "stopped", {
          signal: toolContext.abortSignal,
        }).catch(() => "stopped");

        return { output: [{ type: "text", text: "stopped" }] };
      },
    }),
  ],
});

/** Answers "hi". */
const answersHi: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(initEvent(SCRIPT_SESSION), ...textTurn("m1", "u1", "hi"));

    return yield* Effect.never;
  });

/** Calls `hold` and waits for its result. */
const callsHold: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(
      initEvent(SCRIPT_SESSION, ["hold"]),
      ...toolTurn("m1", "u1", "toolu-hold", "hold")
    );
    yield* io.callTool("hold", "toolu-hold");

    return yield* Effect.never;
  });

const bridgeOn = (scripts: ReadonlyArray<FakeScript>) =>
  BridgeCwd.layer.pipe(
    Layer.provideMerge(BridgeProvider.layerTest),
    Layer.provideMerge(
      Layer.effect(ClaudeSdkScripts, ClaudeSdkScripts.make(scripts))
    )
  );

const scratch = () => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-bridge-cwd-"));
  const real = path.join(root, "real");

  mkdirSync(real);
  symlinkSync(real, path.join(root, "link"));

  return { root, real: realpathSync(real), link: path.join(root, "link") };
};

type OpenHarness = Awaited<ReturnType<typeof Harness.open>>;

/** A Harness over a fresh store with the bridge, the extension and `hold`, closed with the scope. */
const openHarness = (root: string) =>
  Effect.gen(function* () {
    const bridge = yield* BridgeProvider;
    const cwd = yield* BridgeCwd;
    const models = createModels();

    for (const claude of Option.toArray(bridge.claude)) {
      models.setProvider(claude.provider);
    }

    models.setProvider(
      fauxProvider({ provider: "other", models: [{ id: "small" }] }).provider
    );

    const registry = createRegistry();

    registry.install(cwd.extension.extension);
    registry.install(hold);

    const storage = yield* Effect.promise(
      async () => await openNodeSqliteStorage(path.join(root, "brain.sqlite"))
    );

    return yield* Effect.acquireRelease(
      Effect.promise(
        async () => await Harness.open(storage, { models, registry }, context)
      ),
      (harness) =>
        Effect.promise(async () => {
          await harness.close(context);
        })
    );
  });

/** A thread's conversation on `model` in `cwd`, named `threadId` in `cairn.thread-meta`. */
const createThread = async (
  harness: OpenHarness,
  threadId: ThreadId,
  model: ModelRef,
  cwd: string
) =>
  await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model, cwd },
      init: async (tx, id) => {
        const meta = await tx.doc(ThreadMeta, id);

        meta.threadId = threadId;
      },
    },
    context
  );

const runsOf = Effect.gen(function* () {
  const fake = yield* ClaudeSdkScripts;

  return yield* Ref.get(fake.runs);
});

describe("the bridge-cwd extension", () => {
  it.live(
    "starts a bridge thread's child in the realpath of its cwd and records its session; other models are not noted",
    () =>
      Effect.gen(function* () {
        const dirs = scratch();
        const thread = testThreadId(1);
        const other = testThreadId(2);
        const cwd = yield* BridgeCwd;

        const harness = yield* openHarness(dirs.root);

        const sessionId = yield* Effect.promise(async () => {
          const conversation = await createThread(
            harness,
            thread,
            HAIKU,
            dirs.link
          );

          const plain = await createThread(
            harness,
            other,
            { provider: "other", modelId: "small" },
            dirs.link
          );

          await Promise.all(
            (
              [
                [conversation, "hi"],
                [plain, "hello"],
              ] as const
            ).map(
              async ([target, text]) =>
                await target.submit(
                  { type: "input", content: text, requestId: `r-${text}` },
                  context
                )
            )
          );

          await harness.waitForIdle(context);

          const provider = await harness.snapshot(
            ProviderDoc,
            conversation.id,
            context
          );

          return provider?.sessionId ?? "";
        });

        const runs = yield* runsOf;
        const noted = yield* cwd.sessionsOf(thread);
        const notedOther = yield* cwd.sessionsOf(other);

        rmSync(dirs.root, { recursive: true, force: true });

        assert.deepStrictEqual(
          runs.map((run) => run.options.cwd),
          [dirs.real]
        );
        assert.deepStrictEqual(noted, [sessionId]);
        assert.deepStrictEqual(notedOther, []);
      }).pipe(Effect.scoped, Effect.provide(bridgeOn([answersHi])))
  );

  it.live("the stop hook kills a child held on a tool call", () =>
    Effect.gen(function* () {
      const dirs = scratch();
      const thread = testThreadId(3);
      const bridge = yield* BridgeProvider;
      const claude = Option.getOrThrow(bridge.claude);

      const harness = yield* openHarness(dirs.root);

      const { conversation, sessionId } = yield* Effect.promise(async () => {
        const created = await createThread(harness, thread, HAIKU, dirs.link);

        await created.submit(
          { type: "input", content: "hold", requestId: "r-hold" },
          context
        );

        const provider = await harness.snapshot(
          ProviderDoc,
          created.id,
          context
        );

        return { conversation: created, sessionId: provider?.sessionId ?? "" };
      });

      // Wait until the child holds the tool call.
      const before = yield* claude.hasChild(sessionId).pipe(
        Effect.repeat({
          until: (alive) => alive,
          schedule: Schedule.spaced("10 millis"),
          times: 300,
        })
      );

      const held = (yield* runsOf).length;

      yield* bridgeStopHook.run(thread);

      const after = yield* claude.hasChild(sessionId);

      // The child's close lands on its own fiber; give it up to 2 s, before the run is aborted.
      const closed = yield* Effect.map(
        runsOf,
        (runs) => runs[0]?.closed ?? 0
      ).pipe(
        Effect.repeat({
          until: (count) => count > 0,
          schedule: Schedule.spaced("10 millis"),
          times: 200,
        })
      );

      yield* Effect.promise(async () => {
        await conversation.abort(context);
      });

      rmSync(dirs.root, { recursive: true, force: true });

      assert.deepStrictEqual(
        [before, held, after, closed],
        [true, 1, false, 1]
      );
    }).pipe(Effect.scoped, Effect.provide(bridgeOn([callsHold])))
  );
});

describe("the sessions bridge-cwd remembers", () => {
  it("keeps the last sessions per thread and the most recent threads", () => {
    let all: ReadonlyMap<ThreadId, ReadonlyArray<string>> = new Map();
    const thread = testThreadId(1);

    for (let index = 0; index < SESSIONS_PER_THREAD + 5; index += 1) {
      all = rememberSession(all, thread, `s${String(index)}`);
    }

    all = rememberSession(all, thread, "s6");

    const kept = all.get(thread) ?? [];

    assert.strictEqual(kept.length, SESSIONS_PER_THREAD);
    assert.strictEqual(kept.at(-1), "s6");
    assert.notInclude(kept, "s0");

    for (let index = 2; index <= THREADS_KEPT + 1; index += 1) {
      all = rememberSession(all, testThreadId(index), "x");
    }

    assert.strictEqual(all.size, THREADS_KEPT);
    assert.isFalse(all.has(thread));
    assert.isTrue(all.has(testThreadId(THREADS_KEPT + 1)));
  });
});
