// The wave 3 turn-content order, end to end on a real pi-durable brain over the faux model: one
// turn carrying a `$skill` reference and a 3-page PDF runs the production stages (text, skill
// expansion, attachments) and reaches the model as pi's skill block followed by the PDF's text,
// recorded as exactly one `cairn.user` entry.

import os from "node:os";

import {
  AttachmentRef,
  parseAttachmentText,
} from "@cairn/protocol/Attachments";
import { RequestId } from "@cairn/protocol/Ids";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";

import { PiDurableBrain } from "../AppLayer.ts";
import { makePdf } from "../attachments/AttachmentsTestKit.ts";
import {
  attachmentMigrations,
  attachmentServices,
  postUpload,
  uploadHandler,
} from "../attachments/AttachmentsTestLayer.ts";
import { AttachmentStore } from "../attachments/AttachmentStore.ts";
import { UploadTokens } from "../attachments/UploadTokens.ts";
import { FauxModels } from "../brain/FauxModels.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { EventSink } from "../shell/EventSink.ts";
import { projectIdFor } from "../shell/ShellCommands.ts";
import { ShellLayer } from "../shell/ShellLayer.ts";
import { createThread, testCommandId } from "../shell/ShellTestKit.ts";
import { SkillCatalog } from "../skills/SkillCatalog.ts";
import { makeFixtureHome } from "../skills/SkillsTestKit.ts";
import { TurnContent } from "./TurnContent.ts";
import { TurnContentLive } from "./TurnContentStages.ts";

const NONCES = ["heron-5821", "quartz-1907", "lantern-4466"];

const reply = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: FAUX_MODEL.provider,
  model: FAUX_MODEL.modelId,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

/** The production stages over the brain, the shell store, the upload stack and the fixture's project skills. */
const stack = (dir: string, userSkills: string) =>
  TurnContentLive.pipe(
    Layer.provideMerge(attachmentServices),
    Layer.provideMerge(SkillCatalog.layerProjectOnly(userSkills)),
    Layer.provideMerge(
      PiDurableBrain({
        models: ModelSource.layerFaux({ tokensPerSecond: 5000, settings: {} }),
      }).pipe(Layer.provide(ExecutorLink.layerDisabled))
    ),
    Layer.provideMerge(
      ShellLayer.pipe(
        Layer.provideMerge(Database.layerTest(attachmentMigrations))
      )
    ),
    Layer.provideMerge(
      ServerConfig.layerWith({
        dataDir: `${dir}/data`,
        configDir: `${dir}/config`,
      })
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.orDie
  );

const userTexts = (messages: ReadonlyArray<Message>) => {
  const user = messages.findLast((message) => message.role === "user");

  if (user === undefined || Predicate.isString(user.content)) {
    return [];
  }

  return user.content.flatMap((part) =>
    part.type === "text" ? [part.text] : []
  );
};

describe("turn content, every stage in order", () => {
  it.live(
    "a $skill reference and a 3-page PDF reach the model as the skill block, then the PDF text, in one cairn.user entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = makeFixtureHome();

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            fixture.remove();
          })
        );

        const dir = yield* fs.makeTempDirectoryScoped({
          directory: os.tmpdir(),
          prefix: "cairn-turn-content-",
        });

        yield* Effect.gen(function* () {
          const sink = yield* EventSink;
          const harness = yield* HarnessSeam;
          const store = yield* AttachmentStore;
          const { faux } = yield* FauxModels;

          const commandId = testCommandId(1);
          const projectId = projectIdFor(commandId);

          yield* sink.commitCommand(
            ProjectCreate.make({
              commandId,
              workspaceRoot: fixture.project,
              title: Option.none(),
            })
          );

          const create = createThread(projectId, 1);

          yield* sink.commitCommand(create);

          const { threadId } = create;

          yield* harness.ensureThread({
            threadId,
            projectId,
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: fixture.project,
            instructions: Option.none(),
          });

          const pdfBytes = makePdf(
            NONCES.map((nonce, index) => [
              {
                x: 72,
                y: 700,
                text: `Page ${String(index + 1)} nonce ${nonce}`,
              },
            ])
          );

          const issued = yield* UploadTokens.use((tokens) =>
            tokens.issue({
              name: "brief.pdf",
              mimeType: "application/pdf",
              sizeBytes: pdfBytes.length,
            })
          );

          const answer = yield* postUpload(
            yield* uploadHandler,
            issued.uploadPath,
            pdfBytes
          );

          assert.strictEqual(answer.status, 200, JSON.stringify(answer.json));

          const { id: pdfId } = yield* Schema.decodeUnknownEffect(
            Schema.toCodecJson(AttachmentRef)
          )(answer.json);

          const seen = yield* Deferred.make<ReadonlyArray<Message>>();

          const respond: FauxResponseFactory = (context) => {
            Deferred.doneUnsafe(seen, Effect.succeed([...context.messages]));

            return reply("done");
          };

          faux.setResponses([respond]);

          const text = "$shared summarize the brief";

          const built = yield* TurnContent.use((turns) =>
            turns.build(threadId, "owner@test", {
              requestId: RequestId.make("r-skill-pdf"),
              text,
              attachments: [pdfId],
              skillRefs: ["shared"],
            })
          );

          yield* harness.submit(threadId, {
            requestId: "r-skill-pdf",
            content: built.content,
            entry: built.entry,
            whenBusy: "followUp",
          });

          const messages = yield* Deferred.await(seen).pipe(
            Effect.timeout(Duration.seconds(20))
          );

          const texts = userTexts(messages);

          assert.strictEqual(texts.length, 2, texts.join("\n---\n"));

          const [skillText = "", pdfText = ""] = texts;

          // pi's skill block (judged byte for byte by SkillExpansionStage.test.ts), the project's
          // `shared` skill, with the typed text after it.
          assert.isTrue(
            skillText.startsWith(
              `<skill name="shared" location="${fixture.project}/.agents/skills/shared/SKILL.md">`
            ),
            skillText
          );
          assert.isTrue(skillText.endsWith(`</skill>\n\n${text}`), skillText);

          const pdf = Option.getOrThrow(parseAttachmentText(pdfText));

          assert.strictEqual(pdf.path, store.path(pdfId, "text"));

          for (const nonce of NONCES) {
            assert.include(pdf.text, nonce);
          }

          assert.include(pdf.text, "--- Page 3 of 3 ---");

          const first = yield* harness.watch(threadId).pipe(Stream.runHead);

          const userEntries = Option.match(first, {
            onNone: () => [],
            onSome: (frame) =>
              Predicate.isTagged(frame, "Snapshot")
                ? frame.view.entries.filter(
                    (entry) => entry.kind === "cairn.user"
                  )
                : [],
          });

          assert.strictEqual(userEntries.length, 1);
        }).pipe(Effect.provide(stack(dir, `${fixture.home}/nobody`)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000
  );
});
