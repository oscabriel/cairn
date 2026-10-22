// The attachment stage turns uploaded files into model content: text inline up to 40,000
// characters per file and 120,000 per turn with a line naming the full text's path, images as the
// prepared bytes with a path hint, files the model cannot read as a path hint, a PDF with no text
// layer said plainly. The `cairn.user` entry carries the references, and a retried send (same
// request id) claims nothing new and builds the same content. Claimed uploads survive the sweep
// and a discard; unclaimed ones do not.
import os from "node:os";

import type { AttachmentRef } from "@cairn/protocol/Attachments";
import { parseAttachmentText } from "@cairn/protocol/Attachments";
import { AttachmentId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { TurnInput } from "@cairn/protocol/Thread";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { TurnContent, textStage } from "../threads/TurnContent.ts";
import { AttachmentIntake } from "./AttachmentIntake.ts";
import { attachmentStage } from "./AttachmentStage.ts";
import { makePdf, makeZip, PNG_1X1 } from "./AttachmentsTestKit.ts";
import { attachmentsTestLayer } from "./AttachmentsTestLayer.ts";
import type { AttachmentServices } from "./AttachmentsTestLayer.ts";
import { AttachmentStore } from "./AttachmentStore.ts";
import { UploadTokens } from "./UploadTokens.ts";

const threadId = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-000000000001");

type Services =
  | AttachmentServices
  | TurnContent
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Scope.Scope;

/** Runs `body` over a fresh upload stack with the text and attachment stages. */
const withStack = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const dir = yield* fs.makeTempDirectoryScoped({
      directory: os.tmpdir(),
      prefix: "cairn-stage-",
    });

    const layer = TurnContent.layerFrom([textStage, attachmentStage]).pipe(
      Layer.provideMerge(attachmentsTestLayer(dir)),
      Layer.orDie
    );

    return yield* body.pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Uploads `data` as `name` through a signed URL, as the route does. */
const upload = (name: string, mimeType: string, data: Uint8Array) =>
  Effect.gen(function* () {
    const tokens = yield* UploadTokens;
    const intake = yield* AttachmentIntake;

    const issued = yield* tokens.issue({
      name,
      mimeType,
      sizeBytes: data.length,
    });

    const claims = yield* tokens.verify(
      issued.uploadPath.split("/").at(-1) ?? ""
    );

    return yield* intake.ingest(claims, Stream.make(data));
  }).pipe(Effect.orDie);

const textFile = (name: string, chars: number, fill = "x") =>
  upload(name, "text/plain", new TextEncoder().encode(fill.repeat(chars)));

const input = (
  attachments: ReadonlyArray<AttachmentRef>,
  requestId = "r1",
  text = "look at these"
): TurnInput => ({
  requestId: RequestId.make(requestId),
  text,
  attachments: attachments.map((ref) => ref.id),
  skillRefs: [],
});

const build = (turn: TurnInput) =>
  TurnContent.use((turns) => turns.build(threadId, "owner@test", turn));

const texts = (content: ReadonlyArray<TextContent | ImageContent>) =>
  content.flatMap((part) => (part.type === "text" ? [part.text] : []));

const parsed = (text: string) => Option.getOrThrow(parseAttachmentText(text));

const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ n: Schema.Int }))
);

const claimCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT COUNT(*) AS n FROM attachment_claims`;
  const [row] = yield* decodeCount(rows);

  return row?.n;
});

describe("the attachment stage", () => {
  it.effect(
    "inlines a text file up to 40,000 characters and names the rest",
    () =>
      withStack(
        Effect.gen(function* () {
          const store = yield* AttachmentStore;
          const ref = yield* textFile("big.txt", 50_000);
          const built = yield* build(input([ref]));
          const [prompt, block] = texts(built.content);

          assert.strictEqual(prompt, "look at these");

          const parts = parsed(block ?? "");
          const path = store.path(ref.id, "original");

          assert.strictEqual(parts.path, path);
          assert.strictEqual(parts.name, "big.txt");
          assert.isTrue(parts.text.startsWith("x".repeat(40_000)));
          assert.isFalse(parts.text.startsWith("x".repeat(40_001)));
          assert.include(
            parts.text,
            `[Truncated after 40,000 of 50,000 characters. The full text is at ${path}.]`
          );
        })
      )
  );

  it.effect("keeps the turn to 120,000 inline characters", () =>
    withStack(
      Effect.gen(function* () {
        const refs = [
          yield* textFile("a.txt", 40_000, "a"),
          yield* textFile("b.txt", 40_000, "b"),
          yield* textFile("c.txt", 30_000, "c"),
          yield* textFile("d.txt", 30_000, "d"),
          yield* textFile("e.txt", 10, "e"),
        ];

        const built = yield* build(input(refs, "r1", ""));
        const blocks = texts(built.content).map(parsed);

        assert.strictEqual(blocks.length, 5);
        assert.deepStrictEqual(
          blocks.map((block) => (block.text.split("\n\n[")[0] ?? "").length),
          [40_000, 40_000, 30_000, 10_000, 0]
        );
        assert.include(
          blocks[3]?.text ?? "",
          "Truncated after 10,000 of 30,000"
        );
        assert.include(blocks[4]?.text ?? "", "Not shown inline");
        assert.include(blocks[4]?.text ?? "", "120,000 characters");
      })
    )
  );

  it.effect("sends an image as its prepared bytes with a path hint", () =>
    withStack(
      Effect.gen(function* () {
        const store = yield* AttachmentStore;
        const ref = yield* upload("dot.png", "image/png", PNG_1X1);

        const prepared = Option.getOrThrow(
          yield* store.read(ref.id, "prepared")
        );

        const built = yield* build(input([ref]));
        const [, image, hint] = built.content;

        assert.strictEqual(image?.type, "image");
        assert.strictEqual(
          image?.type === "image" ? image.data : "",
          Buffer.from(prepared).toString("base64")
        );
        assert.strictEqual(
          hint?.type === "text" ? hint.text : "",
          `[Attached image "dot.png" (image/png, 0 KB) is saved at: ${store.path(ref.id, "original")}]`
        );
      })
    )
  );

  it.effect(
    "points at files the model cannot read and at PDFs with no text",
    () =>
      withStack(
        Effect.gen(function* () {
          const store = yield* AttachmentStore;

          const sheet = yield* upload(
            "plan.xlsx",
            "application/octet-stream",
            makeZip([
              {
                name: "xl/workbook.xml",
                data: new TextEncoder().encode("<w/>"),
              },
            ])
          );

          const scan = yield* upload(
            "scan.pdf",
            "application/pdf",
            makePdf([[], []])
          );

          const built = yield* build(input([sheet, scan], "r1", ""));
          const [hint, note] = texts(built.content);

          assert.include(hint ?? "", store.path(sheet.id, "original"));
          assert.include(hint ?? "", "open it with a tool");

          const parts = parsed(note ?? "");

          assert.include(parts.text, "no text layer");
          assert.include(parts.text, store.path(scan.id, "original"));
        })
      )
  );

  it.effect("records the references on the cairn.user entry", () =>
    withStack(
      Effect.gen(function* () {
        const ref = yield* textFile("a.txt", 10);
        const built = yield* build(input([ref]));
        const entry = Option.getOrThrow(built.entry);

        assert.strictEqual(entry.kind, "cairn.user");
        assert.deepStrictEqual(entry.data, {
          from: "owner@test",
          attachments: [{ ...ref }],
        });
      })
    )
  );

  it.effect("claims once on a retried send and builds the same content", () =>
    withStack(
      Effect.gen(function* () {
        const store = yield* AttachmentStore;
        const ref = yield* textFile("a.txt", 10);
        const first = yield* build(input([ref], "r1"));
        const again = yield* build(input([ref], "r1"));

        assert.deepStrictEqual(again.content, first.content);
        assert.strictEqual(yield* claimCount, 1);

        // A claimed upload outlives a discard and the day-old sweep; an unclaimed one does not.
        const loose = yield* textFile("loose.txt", 10);

        yield* store.discard(ref.id);
        yield* TestClock.adjust(Duration.hours(25));
        yield* store.sweep({ atBoot: true });

        assert.isTrue(Option.isSome(yield* store.get(ref.id)));
        assert.isTrue(Option.isNone(yield* store.get(loose.id)));
        assert.isFalse(
          yield* (yield* FileSystem.FileSystem).exists(
            store.path(loose.id, "original")
          )
        );
      })
    )
  );

  it.effect("refuses an attachment that is not on the server", () =>
    withStack(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          build({
            ...input([]),
            attachments: [AttachmentId.make("missing-attachment-id")],
          })
        );

        assert.strictEqual(failure.reason, "attachment");
        assert.strictEqual(failure.stage, "attachments");
        assert.strictEqual(yield* claimCount, 0);
      })
    )
  );
});
