// Judges the tools the brain installs (plan D18, D19): the replay policy of every coding tool, the
// code mode guard against self-set deadlines, and that a thread's shell never sees `CAIRN_*`.
// The behaviour checks run real tool calls through pi-durable with a scripted model.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Predicate, Stream } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { setsOwnDeadline, TIMEOUT_REFUSAL } from "./CodeMode.ts";
import { Extensions } from "./Extensions.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const harness = PiDurableHarness.layer.pipe(
  Layer.provideMerge(
    ExtensionSet.layer.pipe(Layer.provide(ExecutorLink.layerDisabled))
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

describe("coding tools", () => {
  it.effect(
    "marks read and the search tools replay-safe, and the writers unsafe",
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
            write: "unsafe",
            edit: "unsafe",
            bash: "unsafe",
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
            "cairn.bridge-cwd",
            "cairn-provider-request-log",
          ]
        );
      }).pipe(
        Effect.provide(
          ExtensionSet.layer.pipe(Layer.provide(ExecutorLink.layerDisabled))
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
