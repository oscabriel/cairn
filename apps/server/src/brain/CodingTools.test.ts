// Judges the tools the brain installs (plan D18, D19): the replay policy of every coding tool, the
// code mode guard against self-set deadlines, and that a thread's shell never sees `CAIRN_*`.
// The behaviour checks run real tool calls through pi-durable with a scripted model.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { CodemodeRunOptions } from "@earendil-works/pi-codemode";
import { createRegistry } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Fiber,
  Function,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { BrainConfig } from "./BrainConfig.ts";
import {
  ScriptSlots,
  setsOwnDeadline,
  TIMEOUT_REFUSAL,
  WaitingSandbox,
} from "./CodeMode.ts";
import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  bashTimeoutSeconds,
} from "./CodingTools.ts";
import { Extensions } from "./Extensions.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const harness = PiDurableHarness.layer.pipe(
  Layer.provideMerge(
    ExtensionSet.layer.pipe(
      Layer.provide(ExecutorLink.layerDisabled),
      Layer.provide(PiHost.layerEmpty),
      Layer.provide(ModelHealth.layerTest),
      Layer.provide(SettingsStore.layerTest),
      Layer.provide(ReachServicesTest),
      Layer.provide(Subagents.layerTest),
      Layer.provide(PiModelSource.layerFromModelSource)
    )
  ),
  Layer.provideMerge(
    ModelSource.layerFaux({
      tokensPerSecond: 4000,
      settings: { retry: { enabled: false } },
    })
  ),
  Layer.provide(
    BrainConfig.layerFrom(mkdtempSync(path.join(tmpdir(), "cairn-tools-")))
  )
);

const isRunEnd = Predicate.isTagged("RunTerminal");

/** Runs one turn whose model calls `call` and returns the tool result's text. */
const toolResult = (
  threadId: ThreadId,
  cwd: string,
  call: ReturnType<typeof fauxToolCall>
) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const { faux } = yield* FauxModels;

    faux.setResponses([
      fauxAssistantMessage([call], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    yield* seam.ensureThread({
      threadId,
      projectId: ProjectId.make("tools"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd,
      instructions: Option.none(),
      runtimeMode: "full-access",
    });

    const ended = yield* seam.events.pipe(
      Stream.filter((event) => isRunEnd(event) && event.threadId === threadId),
      Stream.runHead,
      Effect.forkChild
    );

    yield* Effect.sleep("20 millis");
    yield* seam.submit(threadId, {
      requestId: RequestId.make("r1"),
      content: [{ type: "text", text: "go" }],
      entry: Option.none(),
      whenBusy: "followUp",
    });
    yield* Fiber.join(ended);

    const [snapshot] = yield* seam
      .watch(threadId)
      .pipe(Stream.take(1), Stream.runCollect);

    const result =
      snapshot?._tag === "Snapshot"
        ? snapshot.view.entries.find((entry) => entry.kind === "pi.tool-result")
        : undefined;

    return JSON.stringify(result?.model ?? null);
  });

const codemodeCall = (code: string) => ({
  type: "toolCall" as const,
  id: "c1",
  name: "codemode",
  arguments: { code },
});

const thread = (n: number) =>
  ThreadId.make(
    `0190f0c0-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`
  );

/** Starts `code` in `sandbox` with the fewest options a run takes. */
const startScript = (
  sandbox: WaitingSandbox,
  code: string,
  signal?: AbortSignal
) => {
  const options: CodemodeRunOptions = {
    startedAt: 0,
    seed: 1,
    onCall: Function.constVoid,
  };

  if (signal !== undefined) {
    options.signal = signal;
  }

  return sandbox.start(code, options);
};

const pause = async (ms: number) => {
  await Effect.runPromise(Effect.sleep(ms));
};

describe("code mode slots", () => {
  it("a script past the limit waits for a slot, and Stop ends the wait", async () => {
    const sandbox = new WaitingSandbox(
      { memoryLimitBytes: 64 * 1024 * 1024, timeoutMs: Infinity },
      new ScriptSlots(1)
    );

    const stuck = new AbortController();
    const first = startScript(sandbox, "while (true) {}", stuck.signal);
    const second = startScript(sandbox, "return 2;");
    const stopped = new AbortController();
    const third = startScript(sandbox, "return 3;", stopped.signal);

    await pause(300);
    assert.isFalse(second.finished, "the second waits behind the first");

    stopped.abort();
    assert.deepInclude(await third.result, { ok: false });

    stuck.abort();

    const [firstResult, secondResult] = await Promise.all([
      first.result,
      second.result,
    ]);

    assert.isFalse(firstResult.ok);
    assert.deepInclude(secondResult, { ok: true, value: 2 });

    await sandbox.close();
  });

  it("frees slots in the order scripts asked", async () => {
    const slots = new ScriptSlots(1);
    const order: Array<string> = [];

    assert.isTrue(slots.tryTake());

    const a = (async () => {
      await slots.take();
      order.push("a");
    })();

    const b = (async () => {
      await slots.take();
      order.push("b");
    })();

    await pause(10);
    slots.release();
    await a;
    slots.release();
    await b;

    assert.deepStrictEqual(order, ["a", "b"]);
    assert.isFalse(slots.tryTake());
  });
});

describe("bash timeouts", () => {
  it("defaults to 120 seconds and caps a model's ask at 600", () => {
    assert.strictEqual(bashTimeoutSeconds(), BASH_DEFAULT_TIMEOUT_SECONDS);
    assert.strictEqual(BASH_DEFAULT_TIMEOUT_SECONDS, 120);
    assert.strictEqual(bashTimeoutSeconds(30), 30);
    assert.strictEqual(bashTimeoutSeconds(3600), BASH_MAX_TIMEOUT_SECONDS);
    assert.strictEqual(BASH_MAX_TIMEOUT_SECONDS, 600);
  });
});

describe("coding tools", () => {
  it.effect(
    "marks every coding tool replay-safe: the writers are gated wrappers with an effect mark",
    () =>
      Effect.gen(function* () {
        const { installed } = yield* Extensions;
        const registry = createRegistry();

        for (const extension of installed) {
          registry.install(extension);
        }

        const policy = Object.fromEntries(
          registry
            .snapshot()
            .tools()
            .map(({ tool }) => [tool.name, tool.replay ?? "unsafe"])
        );

        assert.deepStrictEqual(
          {
            read: policy.read,
            grep: policy.grep,
            find: policy.find,
            ls: policy.ls,
            codemode: policy.codemode,
            write: policy.write,
            edit: policy.edit,
            bash: policy.bash,
          },
          {
            read: "safe",
            grep: "safe",
            find: "safe",
            ls: "safe",
            codemode: "safe",
            write: "safe",
            edit: "safe",
            bash: "safe",
          }
        );
        assert.deepStrictEqual(
          installed.map((extension) => extension.name),
          [
            "coding-tools",
            "cairn",
            "skills",
            "context",
            "codemode",
            "cairn-executor",
            "cairn.budgets",
            "cairn.subagents",
            "cairn.workflows",
            "cairn.bridge-cwd",
            "cairn-provider-request-log",
            "cairn.reach",
            "cairn.pi-tools",
            "cairn.model-health",
            "cairn.roles",
            "cairn.ask-user",
            "cairn.results",
          ]
        );
      }).pipe(
        Effect.provide(
          ExtensionSet.layer.pipe(
            Layer.provide(ExecutorLink.layerDisabled),
            Layer.provide(PiHost.layerEmpty),
            Layer.provide(ModelHealth.layerTest),
            Layer.provide(SettingsStore.layerTest),
            Layer.provide(ReachServicesTest),
            Layer.provide(Subagents.layerTest),
            Layer.provide(PiModelSource.layerFromModelSource),
            Layer.provide(
              ModelSource.layerFaux({ tokensPerSecond: 4000, settings: {} })
            )
          )
        )
      )
  );

  it("refuses code mode scripts that set their own deadline, and only those", () => {
    assert.isTrue(
      setsOwnDeadline(
        codemodeCall('// @options: {"timeout_ms": 30000}\ntext("x");')
      )
    );
    assert.isFalse(
      setsOwnDeadline(
        codemodeCall('// @options: {"max_output_tokens": 10}\ntext("x");')
      )
    );
    assert.isFalse(setsOwnDeadline(codemodeCall('text("x");')));
    assert.isFalse(
      setsOwnDeadline({
        ...codemodeCall('// @options: {"timeout_ms": 5}'),
        name: "bash",
      })
    );
  });

  it.live(
    "blocks a deadline script in a real run and runs a plain one",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(path.join(tmpdir(), "cairn-codemode-"));

        const blocked = yield* toolResult(
          thread(1),
          cwd,
          fauxToolCall(
            "codemode",
            { code: '// @options: {"timeout_ms": 1000}\ntext("ran");' },
            { id: "c1" }
          )
        );

        assert.include(blocked, TIMEOUT_REFUSAL.slice(0, 40));

        const plain = yield* toolResult(
          thread(2),
          cwd,
          fauxToolCall(
            "codemode",
            { code: 'text("ran plainly");' },
            { id: "c2" }
          )
        );

        assert.include(plain, "ran plainly");
      }).pipe(Effect.provide(harness)),
    30_000
  );

  it.live(
    "keeps CAIRN_ variables out of a thread's shell and searches with rg and fd",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(path.join(tmpdir(), "cairn-shell-"));

        writeFileSync(path.join(cwd, "notes.txt"), "the needle is here\n");
        process.env.CAIRN_TOOLS_TEST_SECRET = "leaked";

        const shell = yield* toolResult(
          thread(3),
          cwd,
          fauxToolCall(
            "bash",
            { command: "printf '[%s]' \"$CAIRN_TOOLS_TEST_SECRET\"" },
            { id: "c3" }
          )
        );

        assert.include(shell, "[]");
        assert.notInclude(shell, "leaked");

        const grep = yield* toolResult(
          thread(4),
          cwd,
          fauxToolCall("grep", { pattern: "needle" }, { id: "c4" })
        );

        assert.include(grep, "notes.txt:1:the needle is here");

        const find = yield* toolResult(
          thread(5),
          cwd,
          fauxToolCall("find", { pattern: "notes" }, { id: "c5" })
        );

        assert.include(find, "notes.txt");
        assert.isTrue(Predicate.isString(find));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            delete process.env.CAIRN_TOOLS_TEST_SECRET;
          })
        ),
        Effect.provide(harness)
      ),
    30_000
  );
});
