// Ported from github.com/pingdotgg/t3code, apps/server/src/assets/AttachmentUpload.ts
// (`issueAttachmentUploadUrl`, `validateAttachmentUploadToken`) and apps/server/src/auth/utils.ts
// (`signPayload`, `timingSafeEqualBase64Url`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Changed: claims are Cairn's `UploadClaims` (no `type`; the server decides the kind from the
// bytes), the deployed brain's key is a 32-byte file in the config directory created once with
// `wx` and mode 0600 (every other brain keeps a random key in memory, `UploadKeySource`), time comes from `Clock`, a refused token says why, and an upload Cairn would refuse anyway (a
// HEIC photo, an image over 10 MiB) is refused before a URL is issued.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  MAX_IMAGE_BYTES,
  UPLOAD_URL_TTL_MILLIS,
  UploadClaims,
} from "@cairn/protocol/Attachments";
import type {
  CreateUploadUrlInput,
  CreateUploadUrlResult,
} from "@cairn/protocol/Attachments";
import { AttachmentId } from "@cairn/protocol/Ids";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Predicate,
  Schema,
} from "effect";

import { ServerConfig } from "../Config.ts";

/** Where upload URLs point; the token follows the last slash. */
export const UPLOAD_ROUTE_PREFIX = "/api/attachments/upload";

/** The signing key's file name in the config directory. */
export const SIGNING_KEY_FILE = "upload-signing.key";

const KEY_BYTES = 32;

/**
 * Where the signing key comes from. In memory unless the entry point says `file`: dev brains,
 * judges and tests share the deployed brain's config directory and must never make or read
 * `upload-signing.key`, or a dev brain's upload URL would verify on the deployed one.
 */
export const UploadKeySource = Context.Reference<{
  readonly kind: "file" | "ephemeral";
}>("cairn/server/attachments/UploadTokens/UploadKeySource", {
  defaultValue: () => ({ kind: "ephemeral" }),
});

/** The deployed brain's choice: `upload-signing.key` under the config directory. */
export const UploadKeyFromFile = Layer.succeed(UploadKeySource, {
  kind: "file",
});

/** Image types a model cannot take, refused before a URL is issued. */
const REFUSED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** An upload token that cannot be used. Request a new upload URL. */
export class UploadTokenRefused extends Schema.TaggedError<UploadTokenRefused>()(
  "UploadTokenRefused",
  {
    message: Schema.String,
    reason: Schema.Literals([
      /** Not two base64url parts, or claims that do not decode. */
      "malformed",
      /** The signature does not match the claims: tampered, or signed with another key. */
      "bad_signature",
      /** Signed by Cairn, but past its ten-minute lifetime. */
      "expired",
    ]),
  }
) {}

/** The client asked to upload something Cairn would refuse; no URL was issued. */
export class UploadRefused extends Schema.TaggedError<UploadRefused>()(
  "UploadRefused",
  {
    message: Schema.String,
    reason: Schema.Literals(["too_large", "unsupported_type"]),
  }
) {}

/** The signing key could not be read or created, so the brain cannot sign or check uploads. */
export class SigningKeyError extends Schema.TaggedError<SigningKeyError>()(
  "SigningKeyError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

const ClaimsJson = Schema.fromJsonString(Schema.toCodecJson(UploadClaims));

const encodeClaims = Schema.encodeEffect(ClaimsJson);

const decodeClaims = Schema.decodeEffect(ClaimsJson);

/** The key in `<configDir>/upload-signing.key`, made there (`wx`, 0600) when it does not exist. */
const keyFromFile = Effect.fn("UploadTokens.keyFromFile")(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(config.configDir, SIGNING_KEY_FILE);

  const keyError = (cause: unknown) =>
    new SigningKeyError({
      message: `UploadTokens could not read or create the upload signing key ${file}. Check the config directory's permissions; remove a key that is not ${String(KEY_BYTES)} bytes so a new one is made.`,
      cause,
    });

  const exists = yield* fs.exists(file).pipe(Effect.mapError(keyError));

  if (!exists) {
    yield* fs
      .makeDirectory(config.configDir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(keyError));

    // `wx`: two brains starting at once must not each write a key; the loser reads the winner's.
    yield* fs
      .writeFile(file, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.catchIf(
          (error) => Predicate.isTagged(error.reason, "AlreadyExists"),
          () => Effect.void
        ),
        Effect.mapError(keyError)
      );
  }

  const key = yield* fs.readFile(file).pipe(Effect.mapError(keyError));

  if (key.length !== KEY_BYTES) {
    return yield* keyError(`the key is ${String(key.length)} bytes`);
  }

  return key;
});

const sign = (payload: string, key: Uint8Array) =>
  createHmac("sha256", key).update(payload).digest("base64url");

/** Compares two base64url signatures in constant time for equal lengths. */
const sameSignature = (left: string, right: string) => {
  const a = Buffer.from(left, "base64url");
  const b = Buffer.from(right, "base64url");

  return a.length === b.length && timingSafeEqual(a, b);
};

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const refusedToken = (reason: UploadTokenRefused["reason"], why: string) =>
  new UploadTokenRefused({
    message: `UploadTokens refused the upload: ${why}. Request a new upload URL and send the file again.`,
    reason,
  });

/** Signs and checks one-shot upload URLs. */
export class UploadTokens extends Context.Service<
  UploadTokens,
  {
    /**
     * Mints an attachment id and a signed upload path valid for ten minutes. Fails with
     * `UploadRefused` for a HEIC photo or an image over 10 MiB, which the upload would refuse.
     */
    issue(
      input: CreateUploadUrlInput
    ): Effect.Effect<CreateUploadUrlResult, UploadRefused>;
    /**
     * The claims a token from `issue` carries. Fails with `UploadTokenRefused` when the token is
     * malformed, its signature does not match, or it has expired.
     */
    verify(token: string): Effect.Effect<UploadClaims, UploadTokenRefused>;
  }
>()("cairn/server/attachments/UploadTokens") {
  /**
   * Signs with a random key in memory, or, when `UploadKeySource` says `file` (only `main.ts`),
   * with the key in `<configDir>/upload-signing.key`, creating it (32 random bytes, `wx`, mode
   * 0600) on first use. Fails with `SigningKeyError` when that file cannot be read or created, or
   * is not 32 bytes.
   */
  static readonly layerNoDeps = Layer.effect(
    UploadTokens,
    Effect.gen(function* () {
      const source = yield* UploadKeySource;

      const key =
        source.kind === "file"
          ? yield* keyFromFile()
          : Uint8Array.from(randomBytes(KEY_BYTES));

      const issue = Effect.fn("UploadTokens.issue")(function* (
        input: CreateUploadUrlInput
      ) {
        const mimeType = input.mimeType.toLowerCase();

        if (REFUSED_IMAGE_TYPES.has(mimeType)) {
          return yield* new UploadRefused({
            message: `UploadTokens refused ${input.name}: HEIC photos cannot be attached. Attach the photo as JPEG or PNG.`,
            reason: "unsupported_type",
          });
        }

        if (
          mimeType.startsWith("image/") &&
          input.sizeBytes > MAX_IMAGE_BYTES
        ) {
          return yield* new UploadRefused({
            message: `UploadTokens refused ${input.name}: images over 10 MiB cannot be attached. Fit the image to 1,568 px on its long edge and attach it again.`,
            reason: "too_large",
          });
        }

        const attachmentId = AttachmentId.make(
          randomBytes(16).toString("base64url")
        );

        const expiresAt = DateTime.add(yield* DateTime.now, {
          milliseconds: UPLOAD_URL_TTL_MILLIS,
        });

        const claims = yield* encodeClaims({
          version: 1,
          kind: "attachment-upload",
          attachmentId,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          expiresAt,
        }).pipe(Effect.orDie);

        const payload = Buffer.from(claims).toString("base64url");

        yield* Effect.logInfo("attachment upload URL issued").pipe(
          Effect.annotateLogs({
            event: "attachment.url_issued",
            attachmentId,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            pasteToRequestMs: input.pasteToRequestMs ?? "none",
          })
        );

        return {
          attachmentId,
          uploadPath: `${UPLOAD_ROUTE_PREFIX}/${payload}.${sign(payload, key)}`,
          expiresAt,
        };
      });

      const verify = Effect.fn("UploadTokens.verify")(function* (
        token: string
      ) {
        const parts = token.split(".");
        const [payload = "", signature = ""] = parts;

        if (
          parts.length !== 2 ||
          !BASE64URL.test(payload) ||
          !BASE64URL.test(signature)
        ) {
          return yield* refusedToken(
            "malformed",
            "the URL is not an upload URL Cairn issued"
          );
        }

        if (!sameSignature(signature, sign(payload, key))) {
          return yield* refusedToken(
            "bad_signature",
            "the URL's signature does not match its claims"
          );
        }

        const claims = yield* decodeClaims(
          Buffer.from(payload, "base64url").toString("utf-8")
        ).pipe(
          Effect.mapError(() =>
            refusedToken("malformed", "the URL's claims do not decode")
          )
        );

        if (
          DateTime.isLessThanOrEqualTo(claims.expiresAt, yield* DateTime.now)
        ) {
          return yield* refusedToken(
            "expired",
            "its URL expired (upload URLs last ten minutes)"
          );
        }

        return claims;
      });

      return UploadTokens.of({ issue, verify });
    })
  );
}
