// The five proxies inside pi-durable: offered to code mode only (never to the model), and a code
// mode script's `executor_call` running through the approval sandwich against the fake Executor,
// with the `cairn.approvals` record left `done` and nothing for the boot sweep.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";

import { BrainConfig } from "../brain/BrainConfig.ts";
import { CodeMode } from "../brain/CodeMode.ts";
import { CodingTools } from "../brain/CodingTools.ts";
import { Extensions } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { FauxModels } from "../brain/FauxModels.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { PiDurableHarness } from "../brain/PiDurableHarness.ts";
import {
  EXECUTOR_EXTENSION,
  EXECUTOR_TOOL_NAMES,
  ExecutorExtension,
  unfinishedExecutorRequests,
} from "./ExecutorExtension.ts";
import { fakeLink } from "./ExecutorTestKit.ts";
import { startFakeExecutor } from "./FakeExecutor.ts";
import type { FakeExecutorHandle } from "./FakeExecutor.ts";

class Fake extends Context.Service<Fake, FakeExecutorHandle>()(
  "cairn/test/executor/Fake"
) {}

const FakeLive = Layer.effect(Fake, startFakeExecutor);

const LinkLive = Layer.unwrap(Fake.useSync((fake) => fakeLink(fake))).pipe(
  Layer.provideMerge(FakeLive)
);

const sources: ReadonlyArray<
  Effect.Effect<
    CairnExtension,
    never,
    CodingTools | CodeMode | ExecutorExtension
  >
> = [
  CodingTools.useSync((tools) => tools.extension),
  CodeMode.useSync((codemode) => codemode.extension),
  ExecutorExtension.useSync((executor) => executor.extension),
];

const ExtensionsLive = Extensions.fromSources(sources).pipe(
  Layer.provide(
    Layer.mergeAll(CodingTools.layer, CodeMode.layer, ExecutorExtension.layer)
  )
);

const harness = PiDurableHarness.layer.pipe(
  Layer.provideMerge(ExtensionsLive),
  Layer.provideMerge(
    ModelSource.layerFaux({
      tokensPerSecond: 4000,
      settings: { retry: { enabled: false } },
    })
  ),
  Layer.provide(
    BrainConfig.layerFrom(mkdtempSync(path.join(tmpdir(), "cairn-executor-")))
  ),
  Layer.provideMerge(LinkLive)
);

const isRunEnd = Predicate.isTagged("RunTerminal");

const thread = ThreadId.make("0190f0c0-0000-7000-8000-00000000e001");

/** A scripted answer; the faux provider stamps its own api, provider and model on it. */
const answer = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"]
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
});

describe("the Executor extension", () => {
  it.effect("offers its five tools to code mode only", () =>
    Effect.gen(function* () {
      const { installed } = yield* Extensions;

      const tools =
        installed.find((extension) => extension.name === EXECUTOR_EXTENSION)
          ?.tools ?? [];

      assert.deepStrictEqual(
        tools.map((tool) => tool.name).toSorted(),
        [...EXECUTOR_TOOL_NAMES].toSorted()
      );
      assert.isTrue(
        tools.every((tool) => JSON.stringify(tool.callers) === '["tools"]')
      );
      assert.deepStrictEqual(
        installed.map((extension) => extension.name),
        ["coding-tools", "codemode", EXECUTOR_EXTENSION]
      );
    }).pipe(Effect.provide(ExtensionsLive.pipe(Layer.provide(LinkLive))))
  );

  it.live(
    "runs a code mode script's call through the approval sandwich",
    () =>
      Effect.gen(function* () {
        const seam = yield* HarnessSeam;
        const { faux } = yield* FauxModels;
        const fake = yield* Fake;
        const cwd = mkdtempSync(path.join(tmpdir(), "cairn-executor-cwd-"));

        faux.setResponses([
          answer(
            [
              {
                type: "toolCall",
                id: "c1",
                name: "codemode",
                arguments: {
                  code: 'const found = await tools.executor_search({ query: "mark" });\nconst marked = await tools.executor_call({ path: "tools.spike.mark", input: { id: "e2e" } });\ntext(JSON.stringify({ found, marked }));',
                },
              },
            ],
            "toolUse"
          ),
          answer([{ type: "text", text: "done" }], "stop"),
        ]);

        yield* seam.ensureThread({
          threadId: thread,
          projectId: ProjectId.make("executor"),
          model: FAUX_MODEL,
          thinkingLevel: "off",
          cwd,
          instructions: Option.none(),
        });

        const ended = yield* seam.events.pipe(
          Stream.filter(
            (event) => isRunEnd(event) && event.threadId === thread
          ),
          Stream.runHead,
          Effect.forkChild
        );

        yield* Effect.sleep("20 millis");
        yield* seam.submit(thread, {
          requestId: RequestId.make("r1"),
          content: [{ type: "text", text: "go" }],
          entry: Option.none(),
          whenBusy: "followUp",
        });
        yield* Fiber.join(ended);

        const [snapshot] = yield* seam
          .watch(thread)
          .pipe(Stream.take(1), Stream.runCollect);

        const result =
          snapshot?._tag === "Snapshot"
            ? snapshot.view.entries.find(
                (entry) => entry.kind === "pi.tool-result"
              )
            : undefined;

        const text = JSON.stringify(result?.model ?? null);

        assert.include(text, "marked");
        assert.include(text, "tools.github.repos.get");
        assert.deepStrictEqual(fake.marks, ["e2e"]);
        assert.strictEqual(fake.calls("resume").length, 1);
        assert.deepStrictEqual(yield* unfinishedExecutorRequests, []);
      }).pipe(Effect.provide(harness)),
    30_000
  );
});
