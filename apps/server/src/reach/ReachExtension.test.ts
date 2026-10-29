// The `cairn.reach` artifact tools under a real pi-durable Harness over pi-ai's faux provider and
// the fake porch: a Cairn thread (its `cairn.thread-meta` and `pi.agent` cwd) publishes, publishes
// the same bytes again, lists and revokes, and the transcript carries `ArtifactDetails`; a path
// outside the thread's folder and a conversation that is not a thread are tool errors the model
// reads, not thrown ones.

import path from "node:path";

import { ArtifactDetails } from "@cairn/protocol/Reach";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";

import { ThreadMeta } from "../brain/CairnDocs.ts";
import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ArtifactPublisher } from "./ArtifactPublisher.ts";
import { Artifacts } from "./Artifacts.ts";
import { THREAD_A } from "./ArtifactScenarios.ts";
import { makeFakePorch, PorchClient } from "./PorchClient.ts";
import { PortalTools } from "./PortalTools.ts";
import {
  ARTIFACT_LIST_TOOL,
  ARTIFACT_PUBLISH_TOOL,
  ARTIFACT_REVOKE_TOOL,
  ReachTools,
  REACH_EXTENSION,
} from "./ReachExtension.ts";

const context = BACKGROUND_CONTEXT;

const PROVIDER = "faux";

const MODEL = { provider: PROVIDER, modelId: "small" };

const decodeDetails = Schema.decodeUnknownOption(ArtifactDetails);

const call = (name: string, args: Record<string, JsonValue>, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: "toolUse",
  });

interface ToolAnswer {
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
  readonly details: unknown;
}

const answersOf = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message): ReadonlyArray<ToolAnswer> =>
    message.role === "toolResult"
      ? [
          {
            name: message.toolName,
            text: message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
            isError: message.isError,
            details: message.details,
          },
        ]
      : []
  );

/**
 * Runs one conversation whose model makes `calls` in turn, then says done. `thread` makes it a
 * Cairn thread with its folder at the stage's cwd. Returns every tool answer.
 */
const runThread = (
  calls: ReadonlyArray<readonly [string, Record<string, JsonValue>]>,
  thread: boolean
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "cairn-reach-tools-" })
    );

    const artifactsDir = path.join(root, "artifacts");
    const cwd = path.join(root, "thread");
    yield* fs.makeDirectory(artifactsDir);
    yield* fs.makeDirectory(cwd);
    yield* fs.makeDirectory(path.join(root, "outside"));
    yield* fs.writeFileString(path.join(cwd, "report.html"), "<p>r</p>\n");
    yield* fs.writeFileString(
      path.join(root, "outside", "secret.html"),
      "<p>s</p>\n"
    );

    const fake = yield* makeFakePorch({
      domain: "example.test",
      artifacts: artifactsDir,
    });

    const tools = Context.get(
      yield* Layer.build(
        ReachTools.layerAt(780).pipe(
          Layer.provide(
            Layer.succeed(PortalTools, PortalTools.of({ tools: [] }))
          ),
          Layer.provide(Artifacts.layer),
          Layer.provide(ArtifactPublisher.layer),
          Layer.provide(Layer.succeed(PorchClient, fake.client)),
          Layer.provide(Database.layerTest(migrations)),
          Layer.provide(
            ServerConfig.layerWith({ dataDir: path.join(root, "data") })
          )
        )
      ),
      ReachTools
    );

    assert.strictEqual(tools.extension.extension.name, REACH_EXTENSION);

    const faux = fauxProvider({
      provider: PROVIDER,
      models: [{ id: "small" }],
    });

    faux.setResponses([
      ...calls.map(([name, args], index) =>
        call(name, args, `c${String(index)}`)
      ),
      fauxAssistantMessage("done"),
    ]);

    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(tools.extension.extension);

    const harness = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(new MemoryStorage(), { models, registry }, context)
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close(context);
        })
    );

    const messages = yield* Effect.promise(async () => {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: MODEL, cwd },
          init: async (tx, id) => {
            if (thread) {
              const meta = await tx.doc(ThreadMeta, id);
              meta.threadId = THREAD_A;
              meta.projectId = "prj_judge";
            }
          },
        },
        context
      );

      await conversation.submit(
        { type: "input", content: "Publish it.", requestId: "r-0" },
        context
      );
      await harness.waitForIdle(context);

      const view = await conversation.context(context);

      return view.messages;
    });

    return { answers: answersOf(messages), artifactsDir };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("the cairn.reach artifact tools under a Harness", () => {
  it.live("publish, republish, list and revoke from a thread", () =>
    Effect.gen(function* () {
      const { answers } = yield* runThread(
        [
          [ARTIFACT_PUBLISH_TOOL, { path: "report.html", project: "judge" }],
          [ARTIFACT_PUBLISH_TOOL, { path: "report.html", project: "judge" }],
          [ARTIFACT_LIST_TOOL, {}],
          [ARTIFACT_REVOKE_TOOL, { project: "judge", name: "report.html" }],
          [
            ARTIFACT_PUBLISH_TOOL,
            { path: "../outside/secret.html", project: "judge" },
          ],
        ],
        true
      );

      const url = "https://plans.example.test/judge/report.html";

      assert.deepStrictEqual(
        answers.map(({ name, text, isError }) => ({ name, text, isError })),
        [
          {
            name: ARTIFACT_PUBLISH_TOOL,
            text: `Published report.html at ${url}`,
            isError: false,
          },
          {
            name: ARTIFACT_PUBLISH_TOOL,
            text: `report.html is already published with these bytes at ${url}`,
            isError: false,
          },
          {
            name: ARTIFACT_LIST_TOOL,
            text: `judge/report.html (file, 9 bytes): ${url}`,
            isError: false,
          },
          {
            name: ARTIFACT_REVOKE_TOOL,
            text: `Revoked judge/report.html; ${url} no longer serves it.`,
            isError: false,
          },
          {
            name: ARTIFACT_PUBLISH_TOOL,
            text: answers[4]?.text ?? "",
            isError: true,
          },
        ]
      );
      assert.include(answers[4]?.text ?? "", "outside this thread's folder");

      const details = answers.map((answer) => decodeDetails(answer.details));
      assert.deepStrictEqual(
        details.slice(0, 2).map((each) =>
          Option.map(each, ({ kind, url: at, name, changed, bytes }) => ({
            kind,
            url: at,
            name,
            changed,
            bytes,
          }))
        ),
        [
          Option.some({
            kind: "artifact",
            url,
            name: "report.html",
            changed: true,
            bytes: 9,
          }),
          Option.some({
            kind: "artifact",
            url,
            name: "report.html",
            changed: false,
            bytes: 9,
          }),
        ]
      );
    })
  );

  it.live("a conversation that is not a thread is told so", () =>
    Effect.gen(function* () {
      const { answers } = yield* runThread(
        [[ARTIFACT_PUBLISH_TOOL, { path: "report.html", project: "judge" }]],
        false
      );

      assert.deepStrictEqual(
        answers.map(({ isError, text }) => ({ isError, text })),
        [
          {
            isError: true,
            text: "This conversation is not a Cairn thread, so it has no artifacts.",
          },
        ]
      );
    })
  );
});
