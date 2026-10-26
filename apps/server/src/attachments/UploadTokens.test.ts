// Signed upload URLs: a token is refused when tampered with, signed by another key, malformed or
// past its ten minutes (on the test clock); the upload route refuses a wrong `Content-Length`, a
// body shorter or longer than the signed size, and a second upload to a URL already used, before
// and after the attachment is claimed. Nothing of a refused upload stays on disk.

import os from "node:os";
import path from "node:path";

import { RequestId, ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, FileSystem, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../Config.ts";
import {
  attachmentsTestLayer,
  postUpload,
  uploadHandler,
} from "./AttachmentsTestLayer.ts";
import type { AttachmentServices } from "./AttachmentsTestLayer.ts";
import { AttachmentStore } from "./AttachmentStore.ts";
import { SIGNING_KEY_FILE, UploadTokens } from "./UploadTokens.ts";

const decodeProblem = Schema.decodeUnknownEffect(
  Schema.Struct({ message: Schema.String })
);

const TEXT = new TextEncoder().encode("hello from the upload test\n");

const issueText = (sizeBytes = TEXT.length) =>
  UploadTokens.use((tokens) =>
    tokens.issue({ name: "note.txt", mimeType: "text/plain", sizeBytes })
  );

const tokenOf = (uploadPath: string) => uploadPath.split("/").at(-1) ?? "";

/** Runs `body` over a fresh upload stack in a temporary directory. */
const withStack = <A, E>(
  body: (
    dir: string
  ) => Effect.Effect<
    A,
    E,
    AttachmentServices | FileSystem.FileSystem | Scope.Scope
  >
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const dir = yield* fs.makeTempDirectoryScoped({
      directory: os.tmpdir(),
      prefix: "cairn-upload-",
    });

    return yield* body(dir).pipe(
      Effect.provide(attachmentsTestLayer(dir).pipe(Layer.orDie))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const partFiles = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmp = path.join(dir, "data", "attachments", ".tmp");

    return yield* fs.readDirectory(tmp);
  });

describe("upload tokens", () => {
  it.effect("verifies its own token and answers the signed claims", () =>
    withStack(() =>
      Effect.gen(function* () {
        const issued = yield* issueText();

        const claims = yield* UploadTokens.use((tokens) =>
          tokens.verify(tokenOf(issued.uploadPath))
        );

        assert.strictEqual(claims.attachmentId, issued.attachmentId);
        assert.strictEqual(claims.sizeBytes, TEXT.length);
        assert.strictEqual(claims.name, "note.txt");
        assert.isTrue(
          DateTime.toEpochMillis(issued.expiresAt) -
            DateTime.toEpochMillis(yield* DateTime.now) ===
            10 * 60_000
        );
      })
    )
  );

  it.effect("keeps its key in a 32-byte 0600 file", () =>
    withStack((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(path.join(dir, "config", SIGNING_KEY_FILE));

        assert.strictEqual(Number(info.size), 32);
        assert.strictEqual(info.mode % 0o1000, 0o600);
      })
    )
  );

  it.effect(
    "keeps its key in memory unless the entry point asks for the file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const dir = yield* fs.makeTempDirectoryScoped({
          directory: os.tmpdir(),
          prefix: "cairn-upload-key-",
        });

        const tokens = UploadTokens.layerNoDeps.pipe(
          Layer.provide(ServerConfig.layerWith({ configDir: dir }))
        );

        const issued = yield* issueText().pipe(Effect.provide(tokens));

        assert.isTrue(issued.uploadPath.length > 0);
        assert.isFalse(yield* fs.exists(path.join(dir, SIGNING_KEY_FILE)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("refuses a tampered token", () =>
    withStack(() =>
      Effect.gen(function* () {
        const issued = yield* issueText();

        const [payload = "", signature = ""] = tokenOf(issued.uploadPath).split(
          "."
        );

        const claims = Buffer.from(payload, "base64url").toString("utf-8");

        const larger = claims.replace(
          `"sizeBytes":${String(TEXT.length)}`,
          '"sizeBytes":1000000'
        );

        assert.notStrictEqual(larger, claims);

        const forged = Buffer.from(larger).toString("base64url");

        const refused = yield* Effect.flip(
          UploadTokens.use((tokens) => tokens.verify(`${forged}.${signature}`))
        );

        assert.strictEqual(refused.reason, "bad_signature");

        const flipped = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;

        const bad = yield* Effect.flip(
          UploadTokens.use((tokens) => tokens.verify(flipped))
        );

        assert.strictEqual(bad.reason, "bad_signature");
      })
    )
  );

  it.effect("refuses malformed tokens", () =>
    withStack(() =>
      Effect.gen(function* () {
        for (const token of ["", "abc", "a.b.c", "a b.c", "%%%.###"]) {
          const refused = yield* Effect.flip(
            UploadTokens.use((tokens) => tokens.verify(token))
          );

          assert.strictEqual(refused.reason, "malformed", token);
        }
      })
    )
  );

  it.effect("expires a token after ten minutes on the clock", () =>
    withStack(() =>
      Effect.gen(function* () {
        const issued = yield* issueText();
        const token = tokenOf(issued.uploadPath);

        yield* TestClock.adjust(Duration.minutes(9));
        yield* UploadTokens.use((tokens) => tokens.verify(token));

        yield* TestClock.adjust(Duration.minutes(1));

        const refused = yield* Effect.flip(
          UploadTokens.use((tokens) => tokens.verify(token))
        );

        assert.strictEqual(refused.reason, "expired");
      })
    )
  );

  it.effect("refuses HEIC and oversized images before issuing a URL", () =>
    withStack(() =>
      Effect.gen(function* () {
        const heic = yield* Effect.flip(
          UploadTokens.use((tokens) =>
            tokens.issue({
              name: "IMG_0001.HEIC",
              mimeType: "image/heic",
              sizeBytes: 2_000_000,
            })
          )
        );

        assert.strictEqual(heic.reason, "unsupported_type");

        const large = yield* Effect.flip(
          UploadTokens.use((tokens) =>
            tokens.issue({
              name: "huge.png",
              mimeType: "image/png",
              sizeBytes: 11 * 1024 * 1024,
            })
          )
        );

        assert.strictEqual(large.reason, "too_large");
      })
    )
  );
});

describe("the upload route", () => {
  it.live("stores a whole upload and answers its reference", () =>
    withStack(() =>
      Effect.gen(function* () {
        const handler = yield* uploadHandler;
        const issued = yield* issueText();
        const answer = yield* postUpload(handler, issued.uploadPath, TEXT);

        assert.strictEqual(answer.status, 200);
        assert.deepInclude(answer.json, {
          id: issued.attachmentId,
          kind: "text",
          mimeType: "text/plain",
          sizeBytes: TEXT.length,
        });
      })
    )
  );

  it.live("refuses a Content-Length other than the signed size", () =>
    withStack((dir) =>
      Effect.gen(function* () {
        const handler = yield* uploadHandler;
        const issued = yield* issueText(TEXT.length + 5);
        const answer = yield* postUpload(handler, issued.uploadPath, TEXT);

        assert.strictEqual(answer.status, 400);
        assert.deepInclude(answer.json, {
          code: "attachment_rejected",
          reason: "size_mismatch",
        });
        assert.deepStrictEqual(yield* partFiles(dir), []);
      })
    )
  );

  it.live("refuses a streamed body shorter than the signed size", () =>
    withStack((dir) =>
      Effect.gen(function* () {
        const handler = yield* uploadHandler;
        const issued = yield* issueText(TEXT.length + 5);

        const answer = yield* postUpload(
          handler,
          issued.uploadPath,
          TEXT,
          "stream"
        );

        assert.strictEqual(answer.status, 400);
        assert.deepInclude(answer.json, { reason: "size_mismatch" });
        assert.deepStrictEqual(yield* partFiles(dir), []);

        const store = yield* AttachmentStore;
        const fs = yield* FileSystem.FileSystem;

        assert.isFalse(
          yield* fs.exists(store.path(issued.attachmentId, "original"))
        );
      })
    )
  );

  it.live("refuses a streamed body longer than the signed size", () =>
    withStack((dir) =>
      Effect.gen(function* () {
        const handler = yield* uploadHandler;
        const issued = yield* issueText(TEXT.length - 5);

        const answer = yield* postUpload(
          handler,
          issued.uploadPath,
          TEXT,
          "stream"
        );

        assert.strictEqual(answer.status, 400);
        assert.deepInclude(answer.json, { reason: "size_mismatch" });
        assert.include(
          (yield* decodeProblem(answer.json)).message,
          "longer than"
        );
        assert.deepStrictEqual(yield* partFiles(dir), []);
      })
    )
  );

  it.live("refuses a tampered URL as not found", () =>
    withStack(() =>
      Effect.gen(function* () {
        const handler = yield* uploadHandler;
        const issued = yield* issueText();

        const answer = yield* postUpload(
          handler,
          `${issued.uploadPath.slice(0, -2)}xx`,
          TEXT
        );

        assert.strictEqual(answer.status, 404);
      })
    )
  );

  it.live("refuses a replay, before and after the attachment is claimed", () =>
    withStack(() =>
      Effect.gen(function* () {
        const handler = yield* uploadHandler;
        const issued = yield* issueText();

        assert.strictEqual(
          (yield* postUpload(handler, issued.uploadPath, TEXT)).status,
          200
        );
        assert.strictEqual(
          (yield* postUpload(handler, issued.uploadPath, TEXT)).status,
          409
        );

        yield* AttachmentStore.use((store) =>
          store.claim(
            [issued.attachmentId],
            ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-000000000001"),
            RequestId.make("r1")
          )
        );

        const replay = yield* postUpload(handler, issued.uploadPath, TEXT);

        assert.strictEqual(replay.status, 409);
        assert.deepInclude(replay.json, { code: "conflict" });
      })
    )
  );
});
