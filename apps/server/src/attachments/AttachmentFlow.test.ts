// The whole path on a real pi-durable brain over the faux model: a 3-page PDF with a nonce on each
// page is uploaded through the signed route, built into a turn by the attachment stage and
// submitted; the faux model's request carries every nonce as text content inside the attachment
// block (not only a path). A pasted PNG reaches the model as the prepared image, and the
// `provider.request` line logs the sha256 of exactly the base64 the model received.
import { createHash } from "node:crypto";
import os from "node:os";

import {
  AttachmentRef,
  parseAttachmentText,
} from "@cairn/protocol/Attachments";
import { ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
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
  Logger,
  Option,
  Predicate,
  References,
  Schema,
} from "effect";

import { PiDurableBrain } from "../AppLayer.ts";
import { FauxModels } from "../brain/FauxModels.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { ShellLayer } from "../shell/ShellLayer.ts";
import { TurnContent, textStage } from "../threads/TurnContent.ts";
import { attachmentStage } from "./AttachmentStage.ts";
import { makePdf, PNG_1X1 } from "./AttachmentsTestKit.ts";
import {
  attachmentMigrations,
  attachmentServices,
  postUpload,
  uploadHandler,
} from "./AttachmentsTestLayer.ts";
import { AttachmentStore } from "./AttachmentStore.ts";
import {
  providerRequestExtension,
  requestImages,
} from "./ProviderRequestExtension.ts";
import { UploadTokens } from "./UploadTokens.ts";

const NONCES = ["heron-5821", "quartz-1907", "lantern-4466"];

const threadId = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-0000000000a1");

const decodeRef = Schema.decodeUnknownSync(Schema.toCodecJson(AttachmentRef));

/** The `event` and `images` annotations of one log line. */
interface LoggedLine {
  readonly event: unknown;
  readonly images: unknown;
}

/** Every log line, for the `provider.request` check. */
const logged: Array<LoggedLine> = [];

const capture = Logger.make((options) => {
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);

  logged.push({ event: annotations.event, images: annotations.images });
});

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

/** The brain, the shell store and the upload stack over `dir`. */
const stack = (dir: string) => {
  // A copy of the hook under its own name, logging to `capture`, so the test holds whether or not
  // the production extension set already installs the original.
  const brain = Layer.unwrap(
    Effect.gen(function* () {
      const log = yield* providerRequestExtension({
        name: "cairn-provider-request-log-test",
        order: 751,
      }).pipe(
        Effect.provide(Logger.layer([capture], { mergeWithExisting: true }))
      );

      return PiDurableBrain({
        models: ModelSource.layerFaux({ tokensPerSecond: 5000, settings: {} }),
        extraExtensions: [log],
      });
    })
  );

  return TurnContent.layerFrom([textStage, attachmentStage]).pipe(
    Layer.provideMerge(attachmentServices),
    Layer.provideMerge(brain),
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
};

/** Uploads `data` through the signed route and answers its reference. */
const uploadThroughRoute = (name: string, mimeType: string, data: Uint8Array) =>
  Effect.gen(function* () {
    const handler = yield* uploadHandler;

    const issued = yield* UploadTokens.use((tokens) =>
      tokens.issue({ name, mimeType, sizeBytes: data.length })
    );

    const answer = yield* postUpload(handler, issued.uploadPath, data);

    assert.strictEqual(answer.status, 200, JSON.stringify(answer.json));

    return decodeRef(answer.json);
  });

/** Sends one turn with `attachments` and answers the messages the faux model was asked with. */
const sendAndCapture = (
  requestId: string,
  text: string,
  attachments: ReadonlyArray<AttachmentRef>
) =>
  Effect.gen(function* () {
    const { faux } = yield* FauxModels;
    const harness = yield* HarnessSeam;
    const seen = yield* Deferred.make<ReadonlyArray<Message>>();

    const answer: FauxResponseFactory = (context) => {
      Deferred.doneUnsafe(seen, Effect.succeed([...context.messages]));

      return reply("read it");
    };

    faux.setResponses([answer]);

    const built = yield* TurnContent.use((turns) =>
      turns.build(threadId, "owner@test", {
        requestId: RequestId.make(requestId),
        text,
        attachments: attachments.map((ref) => ref.id),
        skillRefs: [],
      })
    );

    yield* harness.submit(threadId, {
      requestId,
      content: built.content,
      entry: built.entry,
      whenBusy: "followUp",
    });

    return yield* Deferred.await(seen).pipe(
      Effect.timeout(Duration.seconds(20))
    );
  });

const userTexts = (messages: ReadonlyArray<Message>) => {
  const user = messages.findLast((message) => message.role === "user");

  if (user === undefined || Predicate.isString(user.content)) {
    return [];
  }

  return user.content.flatMap((part) =>
    part.type === "text" ? [part.text] : []
  );
};

describe("attachments reach the model", () => {
  it.live(
    "a 3-page PDF reaches the faux model as text, and an image as the prepared bytes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const dir = yield* fs.makeTempDirectoryScoped({
          directory: os.tmpdir(),
          prefix: "cairn-flow-",
        });

        yield* Effect.gen(function* () {
          const harness = yield* HarnessSeam;
          const store = yield* AttachmentStore;

          yield* harness.ensureThread({
            threadId,
            projectId: ProjectId.make("project-flow"),
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: dir,
            instructions: Option.none(),
          });

          const pdf = yield* uploadThroughRoute(
            "brief.pdf",
            "application/pdf",
            makePdf(
              NONCES.map((nonce, index) => [
                {
                  x: 72,
                  y: 700,
                  text: `Page ${String(index + 1)} nonce ${nonce}`,
                },
              ])
            )
          );

          assert.strictEqual(pdf.kind, "pdf");

          const messages = yield* sendAndCapture("r-pdf", "summarize", [pdf]);
          const texts = userTexts(messages);

          const block = texts
            .map((text) => parseAttachmentText(text))
            .find(Option.isSome);

          assert.isDefined(block, texts.join("\n---\n"));

          const parts = Option.getOrThrow(block ?? Option.none());

          assert.strictEqual(parts.path, store.path(pdf.id, "text"));

          for (const nonce of NONCES) {
            assert.include(parts.text, nonce);
          }

          assert.include(parts.text, "--- Page 3 of 3 ---");

          const png = yield* uploadThroughRoute(
            "paste.png",
            "image/png",
            PNG_1X1
          );

          const imageMessages = yield* sendAndCapture("r-png", "what is this", [
            png,
          ]);

          const prepared = Option.getOrThrow(
            yield* store.read(png.id, "prepared")
          );

          const base64 = Buffer.from(prepared).toString("base64");
          const sha256 = createHash("sha256").update(base64).digest("hex");
          const [image] = requestImages(imageMessages);

          assert.strictEqual(image?.sha256, sha256);

          const line = logged.find(
            (annotations) => annotations.event === "provider.request"
          );

          assert.isDefined(line);
          assert.deepStrictEqual(line?.images, [
            { mimeType: image?.mimeType, base64Chars: base64.length, sha256 },
          ]);
        }).pipe(Effect.provide(stack(dir)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000
  );
});
