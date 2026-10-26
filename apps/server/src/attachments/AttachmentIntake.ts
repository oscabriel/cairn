// What happens to an upload between its signed URL and its chip: the body is stored and hashed, its
// type is decided from the bytes, and it is prepared once, here, so a send only reads files (ADR
// 0019): an image is fitted for the model, a PDF or DOCX has its text read into `<id>.txt`, text is
// checked as UTF-8. Only then is the row written and the `AttachmentRef` returned. A refused upload
// leaves no files and no row.
//
// A document whose text cannot be read (damaged, past the deadline, a reader crash) is still kept,
// as a file the agent can open with a tool, because the user meant to share it; only a DOCX that
// unpacks past 50 MiB is refused outright.

import { createHash } from "node:crypto";

import type { AttachmentRef, UploadClaims } from "@cairn/protocol/Attachments";
import { MAX_IMAGE_BYTES } from "@cairn/protocol/Attachments";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { Stream } from "effect";

import { AttachmentStore } from "./AttachmentStore.ts";
import type {
  AttachmentStoreError,
  ReceivedUpload,
  StoredAttachment,
  UploadAlreadyReceived,
  UploadBodyMismatch,
} from "./AttachmentStore.ts";
import type { Extracted } from "./ExtractJob.ts";
import { ImagePrepare } from "./ImagePrepare.ts";
import type { ImagePrepareError } from "./ImagePrepare.ts";
import { decodeText, sniff } from "./Sniff.ts";
import { TextExtract } from "./TextExtract.ts";

/** The upload arrived whole but Cairn will not keep it. */
export class UploadRejected extends Schema.TaggedError<UploadRejected>()(
  "UploadRejected",
  {
    message: Schema.String,
    reason: Schema.Literals(["too_large", "unsupported_type", "unreadable"]),
  }
) {}

/** Preparation could not run (the image processor would not start). Nothing was kept; retry. */
export class IntakeUnavailable extends Schema.TaggedError<IntakeUnavailable>()(
  "IntakeUnavailable",
  {
    message: Schema.String,
  }
) {}

/** An image that could not be prepared, as the upload reports it. */
const imageFailure = (
  name: string,
  failure: ImagePrepareError
): IntakeUnavailable | UploadRejected =>
  failure.reason === "unavailable"
    ? new IntakeUnavailable({ message: failure.message })
    : new UploadRejected({
        message: `${name}: ${failure.message}`,
        reason: "unreadable",
      });

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Receives and prepares uploads. */
export class AttachmentIntake extends Context.Service<
  AttachmentIntake,
  {
    /**
     * Stores `body` for the attachment `claims` name, prepares it and records it. Fails with
     * `UploadAlreadyReceived` (the URL was used), `UploadBodyMismatch` (wrong length),
     * `UploadRejected` (a type or size Cairn refuses, or an image Photon cannot decode),
     * `IntakeUnavailable` or `AttachmentStoreError`; nothing is kept then.
     */
    ingest<E>(
      claims: UploadClaims,
      body: Stream.Stream<Uint8Array, E>
    ): Effect.Effect<
      AttachmentRef,
      | UploadAlreadyReceived
      | UploadBodyMismatch
      | UploadRejected
      | IntakeUnavailable
      | AttachmentStoreError
    >;
  }
>()("cairn/server/attachments/AttachmentIntake") {
  /** Needs `AttachmentStore`, `ImagePrepare` and `TextExtract`. */
  static readonly layerNoDeps = Layer.effect(
    AttachmentIntake,
    Effect.gen(function* () {
      const store = yield* AttachmentStore;
      const images = yield* ImagePrepare;
      const extractor = yield* TextExtract;

      /** Prepares the stored original; answers what the row records besides the reference. */
      const prepare = Effect.fnUntraced(function* (
        claims: UploadClaims,
        received: ReceivedUpload,
        bytes: Uint8Array
      ) {
        const id = claims.attachmentId;
        const sniffed = sniff(bytes, claims.mimeType);

        if (sniffed.kind === "refused") {
          return yield* new UploadRejected({
            message: `${claims.name}: ${sniffed.message}`,
            reason: "unsupported_type",
          });
        }

        const ref: AttachmentRef = {
          id,
          name: claims.name,
          mimeType: sniffed.mimeType,
          sizeBytes: received.sizeBytes,
          kind: sniffed.kind,
          sha256: received.sha256,
        };

        const plain: StoredAttachment = {
          ref,
          preparedMimeType: Option.none(),
          pages: Option.none(),
          textChars: Option.none(),
          textTruncated: false,
        };

        if (sniffed.kind === "image") {
          if (received.sizeBytes > MAX_IMAGE_BYTES) {
            return yield* new UploadRejected({
              message: `${claims.name} is over 10 MiB, the image limit. Fit it to 1,568 px on its long edge and attach it again.`,
              reason: "too_large",
            });
          }

          const prepared = yield* images
            .prepare(bytes, sniffed.mimeType)
            .pipe(
              Effect.mapError((failure) => imageFailure(claims.name, failure))
            );

          yield* store.writeVariant(id, "prepared", prepared.bytes);

          yield* Effect.logInfo("attachment prepared").pipe(
            Effect.annotateLogs({
              event: "attachment.prepared",
              attachmentId: id,
              mimeType: prepared.mimeType,
              bytes: prepared.bytes.length,
              sha256: sha256(prepared.bytes),
            })
          );

          return {
            ...plain,
            preparedMimeType: Option.some(prepared.mimeType),
          };
        }

        if (sniffed.kind === "text") {
          return {
            ...plain,
            textChars: Option.map(decodeText(bytes), (text) => text.length),
          };
        }

        if (sniffed.kind === "file") {
          return plain;
        }

        const started = yield* Clock.currentTimeMillis;

        const extracted = yield* extractor.extract(sniffed.kind, bytes).pipe(
          Effect.asSome,
          Effect.catchTag("ExtractError", (failure) =>
            Effect.gen(function* () {
              if (failure.reason === "too_large") {
                return yield* new UploadRejected({
                  message: `${claims.name}: ${failure.message}`,
                  reason: "too_large",
                });
              }

              yield* Effect.logWarning("attachment text not read").pipe(
                Effect.annotateLogs({
                  event: "attachment.extract_failed",
                  attachmentId: id,
                  reason: failure.reason,
                })
              );

              return Option.none<Extracted>();
            })
          )
        );

        if (Option.isNone(extracted)) {
          return plain;
        }

        const { pages, text, truncated } = extracted.value;

        yield* store.writeVariant(id, "text", new TextEncoder().encode(text));

        yield* Effect.logInfo("attachment text extracted").pipe(
          Effect.annotateLogs({
            event: "attachment.extracted",
            attachmentId: id,
            kind: sniffed.kind,
            chars: text.length,
            pages: Option.getOrNull(pages),
            truncated,
            ms: (yield* Clock.currentTimeMillis) - started,
          })
        );

        return {
          ...plain,
          pages,
          textChars: Option.some(text.length),
          textTruncated: truncated,
        };
      });

      const ingest = Effect.fn("AttachmentIntake.ingest")(function* <E>(
        claims: UploadClaims,
        body: Stream.Stream<Uint8Array, E>
      ) {
        const id = claims.attachmentId;
        const received = yield* store.receive(id, claims.sizeBytes, body);

        const stored = yield* Effect.gen(function* () {
          const result = yield* prepare(claims, received, received.bytes);

          yield* store.record(result);

          return result;
        }).pipe(Effect.onError(() => store.forget(id).pipe(Effect.ignore)));

        return stored.ref;
      });

      return AttachmentIntake.of({ ingest });
    })
  );
}
