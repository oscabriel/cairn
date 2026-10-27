// Uploaded attachments on the NVMe and in `cairn.sqlite`. Files live under `<dataDir>/attachments/`:
// `<id>` (the original), `<id>.prepared` (an image fitted for the model) and `<id>.txt` (a
// document's text). An upload streams to `.tmp/<id>.<random>.part` while it is hashed and counted,
// and is renamed into place only when its length matches the signed claim; derived files are
// written to `.tmp` and renamed too, so a reader never sees half a file. The row in `attachments`
// is written last, so a row always names files that exist. A send claims its attachments
// (`INSERT OR IGNORE`, so a retried send is idempotent); unclaimed uploads, leftover `.part` files
// and files with no row are swept after a day, at boot (a `BootRepairs` entry) and once a day.
//
// The pending sweep follows github.com/pingdotgg/t3code, apps/server/src/attachmentStore.ts
// (`sweepStalePendingAttachments`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (MIT, T3 Tools Inc.);
// the table design, claims and atomic writes are Cairn's, the writes after cairn-v1,
// apps/server/src/Files.ts at 1a5cd4a (`writeAtomic`).

import { createHash } from "node:crypto";
import path from "node:path";

import { AttachmentKind, AttachmentRef } from "@cairn/protocol/Attachments";
import type { AttachmentId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Random,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import type { BootRepair } from "../BootRepairs.ts";
import { ServerConfig } from "../Config.ts";

/** How long an unclaimed upload, a `.part` file or a file with no row is kept. */
export const UNCLAIMED_TTL = Duration.hours(24);

/** How often the running brain sweeps. */
const SWEEP_EVERY = Duration.hours(24);

/** A suffix that keeps concurrent scratch files for one attachment apart. */
const scratchSuffix = Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER).pipe(
  Effect.map((value) => value.toString(36))
);

/** The files an attachment may have. */
export const AttachmentVariant = Schema.Literals([
  /** The bytes as uploaded. */
  "original",
  /** An image fitted for the model. */
  "prepared",
  /** A document's text. */
  "text",
]);

/** One of an attachment's files. */
export type AttachmentVariant = typeof AttachmentVariant.Type;

/** An attachment as stored: its reference and what preparation learned. */
export interface StoredAttachment {
  readonly ref: AttachmentRef;
  /** The prepared image's format; none for anything but images. */
  readonly preparedMimeType: Option.Option<string>;
  /** A PDF's page count. */
  readonly pages: Option.Option<number>;
  /** Characters of extracted or plain text; none for images and other files. */
  readonly textChars: Option.Option<number>;
  /** True when the extracted text left pages or characters out. */
  readonly textTruncated: boolean;
}

/** What an upload's bytes came to. */
export interface ReceivedUpload {
  /** The whole body, as stored; preparation reads it from here rather than from disk. */
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Reading or writing an attachment's files or rows failed. Nothing half-written is visible. */
export class AttachmentStoreError extends Schema.TaggedError<AttachmentStoreError>()(
  "AttachmentStoreError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** The upload body did not match its signed length. Nothing was kept. */
export class UploadBodyMismatch extends Schema.TaggedError<UploadBodyMismatch>()(
  "UploadBodyMismatch",
  {
    message: Schema.String,
    reason: Schema.Literals(["short", "long", "interrupted"]),
  }
) {}

/** The upload URL was already used (or is in use) for this attachment. */
export class UploadAlreadyReceived extends Schema.TaggedError<UploadAlreadyReceived>()(
  "UploadAlreadyReceived",
  {
    message: Schema.String,
    attachmentId: Schema.String,
  }
) {}

const StoredRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mime_type: Schema.String,
  size_bytes: Schema.Int,
  sha256: Schema.String,
  kind: AttachmentKind,
  prepared_mime_type: Schema.OptionFromNullOr(Schema.String),
  pages: Schema.OptionFromNullOr(Schema.Int),
  text_chars: Schema.OptionFromNullOr(Schema.Int),
  text_truncated: Schema.Int,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

const decodeRef = Schema.decodeUnknownEffect(AttachmentRef);

const IdRows = Schema.Array(Schema.Struct({ id: Schema.String }));

const decodeIds = Schema.decodeUnknownEffect(IdRows);

const toStored = Effect.fnUntraced(function* (row: typeof StoredRow.Type) {
  const ref = yield* decodeRef({
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.kind,
    sha256: row.sha256,
  });

  return {
    ref,
    preparedMimeType: row.prepared_mime_type,
    pages: row.pages,
    textChars: row.text_chars,
    textTruncated: row.text_truncated !== 0,
  } satisfies StoredAttachment;
});

const failure =
  (operation: string) =>
  <A, E extends { readonly message: string }, R>(
    effect: Effect.Effect<A, E, R>
  ) =>
    effect.pipe(
      // The cause can name files on disk, so it goes to the log, and the message stays fixed (T19).
      Effect.tapError((cause) =>
        Effect.logWarning("attachments store failed").pipe(
          Effect.annotateLogs({
            event: "attachment_store_failed",
            operation,
            cause: cause.message,
          })
        )
      ),
      Effect.mapError(
        (cause) =>
          new AttachmentStoreError({
            message: `${operation} failed on the attachments store. Retry; nothing half-written was kept.`,
            operation,
            cause,
          })
      )
    );

const SUFFIX: Record<AttachmentVariant, string> = {
  original: "",
  prepared: ".prepared",
  text: ".txt",
};

/** True when a file was last written before `cutoff`; a file with no time is kept. */
const olderThan = (info: FileSystem.File.Info, cutoff: DateTime.Utc) =>
  Option.match(info.mtime, {
    onNone: () => false,
    onSome: (mtime) =>
      DateTime.isLessThan(DateTime.fromDateUnsafe(mtime), cutoff),
  });

/** The attachments on disk and in `cairn.sqlite`. */
export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    /** The absolute path of one of an attachment's files (which may not exist). */
    path(id: AttachmentId, variant: AttachmentVariant): string;
    /**
     * Streams an upload's body to a private `.part` file while hashing it, then renames it to the
     * attachment's original. Fails with `UploadAlreadyReceived` when the attachment already has a
     * row or another upload of it is running, and with `UploadBodyMismatch` when the body is
     * shorter or longer than `sizeBytes` or breaks off; nothing is kept then.
     */
    receive<E>(
      id: AttachmentId,
      sizeBytes: number,
      body: Stream.Stream<Uint8Array, E>
    ): Effect.Effect<
      ReceivedUpload,
      UploadAlreadyReceived | UploadBodyMismatch | AttachmentStoreError
    >;
    /** Writes a derived file (`prepared` or `text`) atomically. */
    writeVariant(
      id: AttachmentId,
      variant: "prepared" | "text",
      data: Uint8Array
    ): Effect.Effect<void, AttachmentStoreError>;
    /** Records a fully prepared upload. Its files must already be in place. */
    record(stored: StoredAttachment): Effect.Effect<void, AttachmentStoreError>;
    /** Removes an upload that was refused after `receive`: its files, never a row. */
    forget(id: AttachmentId): Effect.Effect<void, AttachmentStoreError>;
    /** The attachment recorded under `id`, if any. */
    get(
      id: AttachmentId
    ): Effect.Effect<Option.Option<StoredAttachment>, AttachmentStoreError>;
    /** One of its files' bytes; none when the attachment or that file does not exist. */
    read(
      id: AttachmentId,
      variant: AttachmentVariant
    ): Effect.Effect<Option.Option<Uint8Array>, AttachmentStoreError>;
    /** Ties `ids` to the turn that sent them, once; a retried send changes nothing. */
    claim(
      ids: ReadonlyArray<AttachmentId>,
      threadId: ThreadId,
      requestId: RequestId
    ): Effect.Effect<void, AttachmentStoreError>;
    /** Removes an unclaimed attachment and its files; a claimed or unknown one is left alone. */
    discard(id: AttachmentId): Effect.Effect<void, AttachmentStoreError>;
    /**
     * Removes unclaimed uploads, `.part` files and files with no row older than a day. At boot
     * (`atBoot`) the whole `.tmp` directory goes, since nothing can be writing there yet. Answers
     * how many attachments and stray files were removed.
     */
    sweep(options: {
      readonly atBoot: boolean;
    }): Effect.Effect<
      { readonly attachments: number; readonly files: number },
      AttachmentStoreError
    >;
  }
>()("cairn/server/attachments/AttachmentStore") {
  /**
   * Under `<dataDir>/attachments`, through the ambient `SqlClient`; sweeps once a day while the
   * layer lives. Needs `ServerConfig`, `FileSystem` and `SqlClient`.
   */
  static readonly layerNoDeps = Layer.effect(
    AttachmentStore,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const directory = path.join(config.dataDir, "attachments");
      const tmp = path.join(directory, ".tmp");
      const inFlight = new Set<string>();

      yield* fs
        .makeDirectory(tmp, { recursive: true, mode: 0o700 })
        .pipe(failure("AttachmentStore.open"));

      const filePath = (id: AttachmentId, variant: AttachmentVariant) =>
        path.join(directory, `${id}${SUFFIX[variant]}`);

      const removeQuietly = (file: string) =>
        fs.remove(file, { force: true }).pipe(Effect.ignore);

      const hasRow = (id: AttachmentId) =>
        sql`SELECT id FROM attachments WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeIds),
          Effect.map((rows) => rows.length > 0)
        );

      const writeBody = Effect.fnUntraced(function* <E>(
        id: AttachmentId,
        sizeBytes: number,
        body: Stream.Stream<Uint8Array, E>
      ) {
        const part = path.join(tmp, `${id}.${yield* scratchSuffix}.part`);
        const hash = createHash("sha256");
        const chunks: Array<Uint8Array> = [];
        let received = 0;

        const counted = body.pipe(
          Stream.mapError(
            () =>
              new UploadBodyMismatch({
                message: `AttachmentStore stopped receiving attachment ${id}: the upload broke off. Upload it again with a new URL.`,
                reason: "interrupted",
              })
          ),
          Stream.mapEffect((chunk) => {
            received += chunk.length;

            if (received > sizeBytes) {
              return Effect.fail(
                new UploadBodyMismatch({
                  message: `AttachmentStore refused attachment ${id}: the body is longer than the ${String(sizeBytes)} bytes its URL was signed for. Request a URL with the file's real size.`,
                  reason: "long",
                })
              );
            }

            hash.update(chunk);
            chunks.push(chunk);

            return Effect.succeed(chunk);
          })
        );

        return yield* Effect.gen(function* () {
          yield* Stream.run(counted, fs.sink(part, { mode: 0o600 })).pipe(
            Effect.catchTag("PlatformError", (cause) =>
              Effect.fail(
                new AttachmentStoreError({
                  message: `AttachmentStore could not write attachment ${id}: ${cause.message}. Upload it again.`,
                  operation: "AttachmentStore.receive",
                  cause,
                })
              )
            )
          );

          if (received !== sizeBytes) {
            return yield* new UploadBodyMismatch({
              message: `AttachmentStore refused attachment ${id}: the body is ${String(received)} bytes, not the ${String(sizeBytes)} its URL was signed for. Upload it again.`,
              reason: "short",
            });
          }

          yield* fs
            .rename(part, filePath(id, "original"))
            .pipe(failure("AttachmentStore.receive"));

          return {
            // `Buffer.concat` is already a Uint8Array: wrapping it would copy the upload again (T53).
            bytes: Buffer.concat(chunks, received),
            sha256: hash.digest("hex"),
            sizeBytes: received,
          };
        }).pipe(Effect.ensuring(removeQuietly(part)));
      });

      const receive = Effect.fn("AttachmentStore.receive")(function* <E>(
        id: AttachmentId,
        sizeBytes: number,
        body: Stream.Stream<Uint8Array, E>
      ) {
        const recorded = yield* hasRow(id).pipe(
          failure("AttachmentStore.receive")
        );

        if (recorded || inFlight.has(id)) {
          return yield* new UploadAlreadyReceived({
            message: `AttachmentStore already received attachment ${id}; an upload URL works once. Request a new URL to upload the file again.`,
            attachmentId: id,
          });
        }

        inFlight.add(id);

        const received = yield* writeBody(id, sizeBytes, body).pipe(
          Effect.ensuring(Effect.sync(() => inFlight.delete(id)))
        );

        yield* Effect.logInfo("attachment stored").pipe(
          Effect.annotateLogs({
            event: "attachment.stored",
            attachmentId: id,
            sizeBytes: received.sizeBytes,
            sha256: received.sha256,
          })
        );

        return received;
      });

      const writeVariant = Effect.fn("AttachmentStore.writeVariant")(function* (
        id: AttachmentId,
        variant: "prepared" | "text",
        data: Uint8Array
      ) {
        const scratch = path.join(
          tmp,
          `${id}.${yield* scratchSuffix}${SUFFIX[variant]}`
        );

        yield* Effect.gen(function* () {
          yield* fs.writeFile(scratch, data, { mode: 0o600 });
          yield* fs.rename(scratch, filePath(id, variant));
        }).pipe(
          Effect.ensuring(removeQuietly(scratch)),
          failure("AttachmentStore.writeVariant")
        );
      });

      const record = Effect.fn("AttachmentStore.record")(function* (
        stored: StoredAttachment
      ) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const { ref } = stored;

        yield* sql`
          INSERT INTO attachments
            (id, name, mime_type, size_bytes, sha256, kind, prepared_mime_type, pages, text_chars,
             text_truncated, created_at)
          VALUES (
            ${ref.id}, ${ref.name}, ${ref.mimeType}, ${ref.sizeBytes}, ${ref.sha256}, ${ref.kind},
            ${Option.getOrNull(stored.preparedMimeType)}, ${Option.getOrNull(stored.pages)},
            ${Option.getOrNull(stored.textChars)}, ${stored.textTruncated ? 1 : 0}, ${now}
          )
        `;
      }, failure("AttachmentStore.record"));

      const removeFiles = (id: string) =>
        Effect.forEach(
          ["", ".prepared", ".txt"],
          (suffix) => removeQuietly(path.join(directory, `${id}${suffix}`)),
          { discard: true }
        );

      const forget = Effect.fn("AttachmentStore.forget")(function* (
        id: AttachmentId
      ) {
        yield* removeFiles(id);
      });

      const get = Effect.fn("AttachmentStore.get")(function* (
        id: AttachmentId
      ) {
        const rows = yield* sql`
          SELECT id, name, mime_type, size_bytes, sha256, kind, prepared_mime_type, pages,
                 text_chars, text_truncated
          FROM attachments WHERE id = ${id}
        `.pipe(Effect.flatMap(decodeRows));

        const [row] = rows;

        return row === undefined
          ? Option.none<StoredAttachment>()
          : Option.some(yield* toStored(row));
      }, failure("AttachmentStore.get"));

      const read = Effect.fn("AttachmentStore.read")(function* (
        id: AttachmentId,
        variant: AttachmentVariant
      ) {
        if (!(yield* hasRow(id))) {
          return Option.none<Uint8Array>();
        }

        const file = filePath(id, variant);

        if (!(yield* fs.exists(file))) {
          return Option.none<Uint8Array>();
        }

        return Option.some(yield* fs.readFile(file));
      }, failure("AttachmentStore.read"));

      const claim = Effect.fn("AttachmentStore.claim")(function* (
        ids: ReadonlyArray<AttachmentId>,
        threadId: ThreadId,
        requestId: RequestId
      ) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        yield* sql.withTransaction(
          Effect.forEach(
            ids,
            (id) => sql`
              INSERT OR IGNORE INTO attachment_claims (attachment_id, thread_id, request_id, claimed_at)
              VALUES (${id}, ${threadId}, ${requestId}, ${now})
            `,
            { discard: true }
          )
        );
      }, failure("AttachmentStore.claim"));

      const deleteUnclaimed = (id: string) =>
        sql`
          DELETE FROM attachments
          WHERE id = ${id}
            AND NOT EXISTS (SELECT 1 FROM attachment_claims WHERE attachment_id = ${id})
          RETURNING id
        `.pipe(
          Effect.flatMap(decodeIds),
          Effect.map((rows) => rows.length > 0)
        );

      const discard = Effect.fn("AttachmentStore.discard")(function* (
        id: AttachmentId
      ) {
        if (yield* deleteUnclaimed(id)) {
          yield* removeFiles(id);
        }
      }, failure("AttachmentStore.discard"));

      const sweep = Effect.fn("AttachmentStore.sweep")(function* (options: {
        readonly atBoot: boolean;
      }) {
        const now = yield* DateTime.now;
        const cutoff = DateTime.subtractDuration(now, UNCLAIMED_TTL);
        let files = 0;

        if (options.atBoot) {
          files += (yield* fs.readDirectory(tmp)).length;
          yield* fs.remove(tmp, { recursive: true, force: true });
          yield* fs.makeDirectory(tmp, { recursive: true, mode: 0o700 });
        } else {
          for (const entry of yield* fs.readDirectory(tmp)) {
            const file = path.join(tmp, entry);
            const info = yield* fs.stat(file);

            if (olderThan(info, cutoff)) {
              yield* removeQuietly(file);
              files += 1;
            }
          }
        }

        const stale = yield* sql`
          SELECT id FROM attachments
          WHERE created_at < ${DateTime.toEpochMillis(cutoff)}
            AND id NOT IN (SELECT attachment_id FROM attachment_claims)
        `.pipe(Effect.flatMap(decodeIds));

        let attachments = 0;

        for (const { id } of stale) {
          if (yield* deleteUnclaimed(id)) {
            yield* removeFiles(id);
            attachments += 1;
          }
        }

        // Files with no row: an upload refused or cut off between its rename and its row.
        const known = new Set(
          (yield* sql`SELECT id FROM attachments`.pipe(
            Effect.flatMap(decodeIds)
          )).map((row) => row.id)
        );

        for (const entry of yield* fs.readDirectory(directory)) {
          const id = entry.split(".")[0] ?? "";

          if (entry.startsWith(".") || known.has(id) || inFlight.has(id)) {
            continue;
          }

          const file = path.join(directory, entry);
          const info = yield* fs.stat(file);

          if (olderThan(info, cutoff)) {
            yield* removeQuietly(file);
            files += 1;
          }
        }

        yield* Effect.logInfo("attachments swept").pipe(
          Effect.annotateLogs({
            event: "attachment.swept",
            atBoot: options.atBoot,
            attachments,
            files,
          })
        );

        return { attachments, files };
      }, failure("AttachmentStore.sweep"));

      yield* sweep({ atBoot: false }).pipe(
        Effect.catchTag("AttachmentStoreError", (failed) =>
          Effect.logWarning("attachment sweep failed").pipe(
            Effect.annotateLogs({
              event: "attachment.sweep_failed",
              cause: failed.message,
            })
          )
        ),
        Effect.delay(SWEEP_EVERY),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
        Effect.forkScoped
      );

      return AttachmentStore.of({
        path: filePath,
        receive,
        writeVariant,
        record,
        forget,
        get,
        read,
        claim,
        discard,
        sweep,
      });
    })
  );
}

/**
 * The boot repair that clears `.tmp` and sweeps stale uploads (`BootRepairs.ts`). A failed sweep is
 * logged; boot goes on, and the daily sweep tries again.
 */
export const sweepAttachmentUploads: BootRepair<AttachmentStore> = {
  name: "sweep attachment uploads",
  repair: AttachmentStore.use((store) => store.sweep({ atBoot: true })).pipe(
    Effect.asVoid,
    Effect.catchTag("AttachmentStoreError", (failed) =>
      Effect.logWarning("attachment sweep failed at boot").pipe(
        Effect.annotateLogs({
          event: "attachment.sweep_failed",
          cause: failed.message,
        })
      )
    )
  ),
};
