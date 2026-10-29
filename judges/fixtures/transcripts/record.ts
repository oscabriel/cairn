// Records real pi transcripts for the timeline's tests: pi-durable over the user's API models (pi's
// model runtime, read-only over ~/.pi/agent), a throwaway project under the temp directory, and a
// handful of scripted conversations that exercise what the transcript renders: markdown, every
// coding tool, a failing tool, a stopped run, thinking, and a streamed reply. Each conversation's
// thread stream is applied with client-logic's ThreadView, exactly as the client applies it, and
// the final projected view is written to `<name>.json` beside this file. The streamed one also keeps
// every frame (`streaming.frames.json`), so tests can replay the stream item by item.
//
//   node judges/fixtures/transcripts/record.ts [--model opencode-go/<id>] [--thinking-model <ref>]
//                                              [--only <name>] [--list]
//
// It never touches the deployed brain or its data: the store lives in a temporary directory that is
// removed afterwards. Paths of the temporary project are rewritten to /work/demo so the fixtures
// stay byte-stable across runs. Prints one JSON line per conversation (name, entries, ms) and never
// a credential. A run costs a few cents.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import type { ThreadStreamItem } from "@cairn/protocol/Thread";
import { NodeServices } from "@effect/platform-node";
import {
  Clock,
  Data,
  Duration,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  References,
  Ref,
  Schema,
  Result,
  Stream,
} from "effect";

import {
  HarnessBoot,
  PiDurableBrain,
} from "../../../apps/server/src/AppLayer.ts";
import { HarnessSeam } from "../../../apps/server/src/brain/HarnessSeam.ts";
import { ServerConfig } from "../../../apps/server/src/Config.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { ModelHealth } from "../../../apps/server/src/models/ModelHealth.ts";
import { PiModelSource } from "../../../apps/server/src/models/PiModelSource.ts";
import { PiHost } from "../../../apps/server/src/pi-host/PiHost.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "opencode-go/claude-haiku-5-5" },
    "thinking-model": { type: "string" },
    only: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

const OUT_DIR = import.meta.dirname;

/** What the temporary project's path becomes in the fixtures. */
const STABLE_ROOT = "/work/demo";

const parseRef = (text: string): ModelRef => {
  const slash = text.indexOf("/");

  if (slash <= 0) {
    throw new Error(`record.ts: ${text} is not <provider>/<modelId>.`);
  }

  return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
};

/** One step of a conversation. */
type Step = Data.TaggedEnum<{
  Send: { readonly text: string };
  SendWithAttachment: { readonly text: string };
  StopWhenToolRuns: { readonly text: string };
}>;

const Step = Data.taggedEnum<Step>();

interface Conversation {
  readonly name: string;
  readonly thinking: ThinkingLevel;
  readonly useThinkingModel: boolean;
  readonly keepFrames: boolean;
  readonly steps: ReadonlyArray<Step>;
}

const send = (text: string): Step => Step.Send({ text });

const isRunningSlot = Schema.is(
  Schema.Struct({ status: Schema.Literal("running") })
);

// Loops with sleeps until the condition holds or the deadline passes.
const poll = (condition: Effect.Effect<boolean>, timeoutMs: number) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;

    while (!(yield* condition)) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return false;
      }

      yield* Effect.sleep(Duration.millis(100));
    }

    return true;
  });

const CONVERSATIONS: ReadonlyArray<Conversation> = [
  {
    name: "coding",
    thinking: "off",
    useThinkingModel: false,
    keepFrames: false,
    steps: [
      send(
        "In a few sentences, tell me what a README is for. Format the answer with a level-two heading, a bullet list of three items, one fenced bash code block, and a small two-column markdown table. Use no tools."
      ),
      send(
        "Read notes.txt with the read tool. Fix its one spelling mistake with the edit tool. Then create summary.txt containing one line that describes the project, using the write tool. Then run `ls` and `wc -l notes.txt` with the bash tool. Finish with one sentence."
      ),
      send(
        "Run `cat does-not-exist.txt` with the bash tool and tell me in one sentence what happened."
      ),
      send(
        "Use the grep tool to find the word cairn in this folder, and the find tool to list the .txt files. Answer in one sentence."
      ),
      Step.SendWithAttachment({
        text: "Here is a file I attached. Just reply with: got it.",
      }),
    ],
  },
  {
    name: "interrupted",
    thinking: "off",
    useThinkingModel: false,
    keepFrames: true,
    steps: [
      Step.StopWhenToolRuns({
        text: "Run `sleep 20 && echo finished` with the bash tool, then tell me what it printed.",
      }),
      send("Never mind that. Reply with the single word: ok."),
    ],
  },
  {
    name: "thinking",
    thinking: "low",
    useThinkingModel: true,
    keepFrames: false,
    steps: [
      send(
        "What is 17 times 23? Think it through, then answer with one short sentence."
      ),
    ],
  },
  {
    name: "streaming",
    thinking: "off",
    useThinkingModel: false,
    keepFrames: true,
    steps: [
      send(
        "Write about 250 words on why durable agent transcripts matter. Use two level-two headings, one bullet list, and one short fenced TypeScript code block. Use no tools."
      ),
    ],
  },
  {
    name: "streaming-tools",
    thinking: "off",
    useThinkingModel: false,
    keepFrames: true,
    steps: [
      send(
        "Run `ls` with the bash tool, then read README.md with the read tool, then answer in one sentence."
      ),
    ],
  },
];

const PROJECT_ID = ProjectId.make("prj_transcript_fixtures");

/** A UUIDv7-shaped thread id, fixed per conversation so fixtures are stable. */
const threadIdFor = (index: number) =>
  ThreadId.make(
    `019a0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`
  );

const makeProject = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cairn-transcripts-"));

  writeFileSync(
    path.join(dir, "README.md"),
    "# demo\n\nA tiny folder the cairn transcript recorder works in.\n"
  );
  writeFileSync(
    path.join(dir, "notes.txt"),
    "This project is a small exmaple for the transcript recorder.\nIt has two lines.\n"
  );
  execFileSync("git", ["init", "-q", dir]);

  return dir;
};

/** Replaces the temporary project's path (and its realpath) with the stable one. */
const stabilize = (json: string, projectDir: string): string =>
  json.replaceAll(projectDir, STABLE_ROOT);

const ATTACHMENT_ENTRY_DATA = {
  from: "owner@loopback",
  attachments: [
    {
      id: "att_0123456789abcdef0123456789abcdef",
      name: "release-notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 48_213,
      kind: "pdf",
      sha256:
        "3f0c1d4b2e8a9f7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
    },
  ],
};

const ATTACHMENT_TEXT = `<attachment name="release-notes.pdf" type="application/pdf" path="${STABLE_ROOT}/.attachments/att_0123456789abcdef0123456789abcdef.txt">\nRelease notes. Version 2 adds durable threads.\n</attachment>`;

const program = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  yield* HarnessBoot.use((boot) => boot.resume);

  if (values.list) {
    const source = yield* PiModelSource;
    const catalog = yield* source.catalog({ bridgeEnabled: false });

    for (const listing of catalog.models.filter((model) => model.available)) {
      yield* Effect.sync(() => {
        process.stdout.write(
          `${listing.provider}/${listing.modelId} thinking=${listing.thinkingLevels.join(",")}\n`
        );
      });
    }

    return;
  }

  const model = parseRef(values.model);
  const thinkingModel = parseRef(values["thinking-model"] ?? values.model);

  for (const [index, conversation] of CONVERSATIONS.entries()) {
    if (values.only !== undefined && values.only !== conversation.name) {
      continue;
    }

    const projectDir = makeProject();
    const threadId = threadIdFor(index);
    const started = yield* Clock.currentTimeMillis;
    const state = yield* Ref.make(Option.none<ThreadViewState>());
    const frames = yield* Ref.make<ReadonlyArray<ThreadStreamItem>>([]);

    yield* seam.ensureThread({
      threadId,
      projectId: PROJECT_ID,
      model: conversation.useThinkingModel ? thinkingModel : model,
      thinkingLevel: conversation.thinking,
      cwd: projectDir,
      instructions: Option.none(),
    });

    const watcher = yield* seam.watch(threadId).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          if (conversation.keepFrames) {
            yield* Ref.update(frames, (all) => [...all, item]);
          }

          const previous = yield* Ref.get(state);
          const next = applyThreadStreamItem(previous, item);

          if (Result.isSuccess(next)) {
            yield* Ref.set(state, Option.some(next.success));
          }
        })
      ),
      Effect.forkScoped
    );

    const isRunning = Effect.map(Ref.get(state), (current) =>
      Option.exists(current, (view) =>
        Predicate.hasProperty(view.view.docs["pi.live"], "run")
      )
    );

    const toolRunning = Effect.map(Ref.get(state), (current) =>
      Option.exists(current, (view) => {
        const live = view.view.docs["pi.live"];

        return (
          Predicate.hasProperty(live, "tools") &&
          Array.isArray(live.tools) &&
          live.tools.some(isRunningSlot)
        );
      })
    );

    for (const [stepIndex, step] of conversation.steps.entries()) {
      const requestId = `rec-${conversation.name}-${stepIndex}-${started}`;

      yield* seam.submit(threadId, {
        requestId,
        content: Step.$is("SendWithAttachment")(step)
          ? [
              { type: "text", text: step.text },
              { type: "text", text: ATTACHMENT_TEXT },
            ]
          : [{ type: "text", text: step.text }],
        entry: Step.$is("SendWithAttachment")(step)
          ? Option.some({ kind: "cairn.user", data: ATTACHMENT_ENTRY_DATA })
          : Option.none(),
        whenBusy: "followUp",
      });

      yield* poll(isRunning, 10_000);

      if (Step.$is("StopWhenToolRuns")(step)) {
        yield* poll(toolRunning, 60_000);
        yield* Effect.sleep(Duration.millis(800));
        yield* seam.stop(threadId, { clearQueue: false });
      }

      yield* poll(
        Effect.map(isRunning, (running) => !running),
        180_000
      );
      yield* Effect.sleep(Duration.millis(300));
    }

    yield* Fiber.interrupt(watcher);

    const final = yield* Effect.flatMap(Ref.get(state), (current) =>
      Option.match(current, {
        onNone: () =>
          Effect.die(
            new Error(`record.ts: ${conversation.name} produced no view.`)
          ),
        onSome: Effect.succeed,
      })
    );

    yield* Effect.sync(() => {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(
        path.join(OUT_DIR, `${conversation.name}.json`),
        `${stabilize(JSON.stringify(final.view, null, 2), projectDir)}\n`
      );
    });

    if (conversation.keepFrames) {
      const all = yield* Ref.get(frames);

      yield* Effect.sync(() => {
        writeFileSync(
          path.join(OUT_DIR, `${conversation.name}.frames.json`),
          `${stabilize(JSON.stringify(all, null, 1), projectDir)}\n`
        );
      });
    }

    const ended = yield* Clock.currentTimeMillis;

    yield* Effect.sync(() => {
      rmSync(projectDir, { recursive: true, force: true });
      process.stdout.write(
        `${JSON.stringify({
          name: conversation.name,
          entries: final.view.entries.length,
          ms: ended - started,
        })}\n`
      );
    });
  }
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-record-data-"));

const Brain = PiDurableBrain({
  models: PiModelSource.layer.pipe(
    Layer.orDie,
    Layer.provide(ServerConfig.layerWith({ dataDir }))
  ),
}).pipe(
  Layer.provide(ExecutorLink.layerDisabled),
  Layer.provide(PiHost.layerEmpty),
  Layer.provide(ModelHealth.layerTest),
  Layer.provide(ServerConfig.layerWith({ dataDir })),
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error"))
);

const runtime = ManagedRuntime.make(Brain);

try {
  await runtime.runPromise(Effect.scoped(program));
} finally {
  await runtime.dispose();
  rmSync(dataDir, { recursive: true, force: true });
}
