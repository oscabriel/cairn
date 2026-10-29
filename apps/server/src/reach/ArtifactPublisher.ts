// Publishes an artifact through porch without ever overwriting a page Cairn did not publish
// (ADR 0038, docs/phase-2/notes/reach.md R3 and R4). porch copies a page to
// `<artifacts>/<project>/<name>` and, measured on porch 0.0.0, replaces whatever file already sits
// there when its own registry has no record of it: the user's hand-written plans live in that same
// tree. The installed porch has no refusal for that, so Cairn holds the rule itself, from its own
// `artifacts` table:
//
// - a key `(project, name)` another thread holds is refused (`taken`);
// - a key no row holds, whose target already exists on disk, is refused (`unmanaged`): it is the
//   user's file or some other tool's, and porch would overwrite it;
// - otherwise the row is claimed first, porch publishes, and the row is filled in. A crash between
//   the two leaves the claim, so the rerun republishes in place (`changed: false` when the bytes
//   match). A fresh claim is given back only on a real refusal: porch answered with a code (it
//   refuses before it copies) or Cairn refused the input. A timeout, a crash, an unreadable
//   receipt or a porch that could not start may have published, so the claim stays for the rerun.
//
// A claim whose row still has no hash (the brain died before porch ran, or porch failed in a way
// that keeps it) holds its key for its thread until that thread publishes again; listings filter
// `hash IS NULL`. Porch may never have run for it, so a target on disk is not proof of Cairn's
// copy: the rerun goes ahead only when the target holds exactly the source's bytes (porch did copy
// it), and is refused `unmanaged` otherwise. A revoked row still belongs to its thread, so another
// thread is refused `taken`. Two fresh publishes of one key from the same thread both go ahead.
//
// The publish is idempotent per thread and source, so a tool built on it can be `replay: "safe"`.

import { createHash } from "node:crypto";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { ArtifactRow, MAX_ARTIFACT_BYTES } from "@cairn/protocol/Reach";
import type { ArtifactKind } from "@cairn/protocol/Reach";
import { NodeServices } from "@effect/platform-node";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";

import { ArtifactFaults } from "./ArtifactFaults.ts";
import { checkPublish, PorchClient } from "./PorchClient.ts";
import type { PorchError } from "./PorchClient.ts";

/** What to publish: a file or a folder with an `index.html`, under a project slug. */
export interface PublishInput {
  readonly threadId: ThreadId;
  /** An absolute path; the page's name is its basename. */
  readonly source: string;
  readonly project: string;
}

/** A published artifact as `reach.list` shows it, and whether this publish changed its bytes. */
export interface Published {
  readonly row: ArtifactRow;
  readonly changed: boolean;
}

/**
 * Why Cairn refused to publish before porch ran, or could not record it. `taken`: another thread
 * holds the name. `unmanaged`: a file Cairn never published sits at the target. `too-large`: over
 * `MAX_ARTIFACT_BYTES`. `source`: the source could not be read. `store`: `cairn.sqlite` failed.
 */
export class ArtifactPublishError extends Schema.TaggedError<ArtifactPublishError>()(
  "ArtifactPublishError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "taken",
      "unmanaged",
      "too-large",
      "source",
      "store",
    ]),
    project: Schema.String,
    /** The page's name, the source's basename. */
    artifactName: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const StoredRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  project_slug: Schema.String,
  name: Schema.String,
  kind: Schema.NullOr(Schema.Literals(["file", "folder"])),
  url: Schema.NullOr(Schema.String),
  hash: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Int),
  claimed_at: Schema.Int,
  published_at: Schema.NullOr(Schema.Int),
  updated_at: Schema.Int,
  revoked_at: Schema.NullOr(Schema.Int),
});

type StoredRow = typeof StoredRow.Type;

const decodeStoredRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

const decodeRow = Schema.decodeUnknownEffect(Schema.toType(ArtifactRow));

/** An artifact's id, derived from its key so a claim and its rerun name the same row. */
export const artifactIdOf = (project: string, name: string) =>
  `art_${createHash("sha256").update(`${project}/${name}`).digest("hex").slice(0, 32)}`;

/** The artifact row of a stored row that porch has published; fails if the row breaks the shape. */
const rowOf = (stored: StoredRow) =>
  decodeRow({
    id: stored.id,
    threadId: stored.thread_id,
    projectSlug: stored.project_slug,
    name: stored.name,
    kind: stored.kind,
    url: stored.url,
    hash: stored.hash,
    bytes: stored.bytes,
    publishedAt: DateTime.makeUnsafe(stored.published_at ?? stored.claimed_at),
    updatedAt: DateTime.makeUnsafe(stored.updated_at),
    revokedAt: Option.map(Option.fromNullOr(stored.revoked_at), (at) =>
      DateTime.makeUnsafe(at)
    ),
  });

/**
 * Whether a failed publish certainly changed nothing: porch answered a refusal code (it refuses
 * before it copies, `proxy-refused` included) or Cairn refused the input before porch ran.
 */
const releasesClaim = (error: PorchError) =>
  Option.isSome(error.porchCode) || error.reason === "bad-input";

/** A source's kind and size: one file, or every file under a folder. */
const measure = (fs: FileSystem.FileSystem, source: string) =>
  Effect.gen(function* () {
    const info = yield* fs.stat(source);

    if (info.type !== "Directory") {
      const kind: ArtifactKind = "file";

      return { kind, bytes: Number(info.size) };
    }

    let bytes = 0;

    for (const entry of yield* fs.readDirectory(source, { recursive: true })) {
      const child = yield* fs.stat(path.join(source, entry));

      if (child.type === "File") {
        bytes += Number(child.size);
      }
    }

    const kind: ArtifactKind = "folder";

    return { kind, bytes };
  });

/** The bytes of every file under `root` (or of `root` itself), keyed by relative path. */
const contentsOf = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const info = yield* fs.stat(root);
    const files = new Map<string, string>();

    const digest = (file: string) =>
      Effect.map(fs.readFile(file), (bytes) =>
        createHash("sha256").update(bytes).digest("hex")
      );

    if (info.type !== "Directory") {
      files.set("", yield* digest(root));

      return files;
    }

    for (const entry of yield* fs.readDirectory(root, { recursive: true })) {
      const child = path.join(root, entry);

      if ((yield* fs.stat(child)).type === "File") {
        files.set(entry, yield* digest(child));
      }
    }

    return files;
  });

/**
 * Whether `target` is exactly a copy of `source`: the same files with the same bytes, nothing
 * more. Anything unreadable is not a copy.
 */
const isCopyOf = (fs: FileSystem.FileSystem, source: string, target: string) =>
  Effect.gen(function* () {
    const want = yield* contentsOf(fs, source);
    const have = yield* contentsOf(fs, target);

    return (
      want.size === have.size &&
      [...want].every(([file, hash]) => have.get(file) === hash)
    );
  }).pipe(Effect.orElseSucceed(() => false));

/** Publishes artifacts through porch, refusing to overwrite anything Cairn did not publish. */
export class ArtifactPublisher extends Context.Service<
  ArtifactPublisher,
  {
    /**
     * Publishes `source` as `<project>/<basename>` for `threadId` and records it in `artifacts`.
     * Fails `ArtifactPublishError` (`taken`, `unmanaged`, `too-large`, `source`, `store`) before
     * porch runs, or with porch's own `PorchError` (`exists` when porch recorded the page from
     * another source, `missing` for a folder with no `index.html`, `proxy-refused`, ...).
     */
    publish(
      input: PublishInput
    ): Effect.Effect<Published, ArtifactPublishError | PorchError>;
  }
>()("cairn/server/reach/ArtifactPublisher") {
  /** Over the ambient `PorchClient`, `SqlClient` and `FileSystem`. */
  static readonly layerNoDeps = Layer.effect(
    ArtifactPublisher,
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const faults = yield* ArtifactFaults;

      const publish = Effect.fn("ArtifactPublisher.publish")(function* (
        input: PublishInput
      ) {
        const name = path.basename(input.source);
        const { project } = input;

        const refuse = (
          reason: ArtifactPublishError["reason"],
          message: string,
          cause: Option.Option<Error>
        ) =>
          new ArtifactPublishError({
            message,
            reason,
            project,
            artifactName: name,
            retryable: reason === "store",
            cause: Option.getOrUndefined(cause),
          });

        const storeFailure = (cause: Error) =>
          refuse(
            "store",
            `ArtifactPublisher could not read or write the artifacts row for ${project}/${name}: ${cause.message}. The publish is safe to retry.`,
            Option.some(cause)
          );

        // A climbing or malformed slug is refused before it names a path or a row.
        const badInput = checkPublish(input.source, project);

        if (Option.isSome(badInput)) {
          return yield* badInput.value;
        }

        const measured = yield* measure(fs, input.source).pipe(
          Effect.mapError((cause) =>
            refuse(
              "source",
              `ArtifactPublisher could not read ${input.source}: ${cause.message}. Check the path and publish again.`,
              Option.some(cause)
            )
          )
        );

        if (measured.bytes > MAX_ARTIFACT_BYTES) {
          return yield* refuse(
            "too-large",
            `${input.source} is ${String(measured.bytes)} bytes, over the ${String(MAX_ARTIFACT_BYTES)}-byte artifact limit. Publish something smaller.`,
            Option.none()
          );
        }

        const machine = yield* porch.machine;
        const target = path.join(machine.artifacts, project, name);
        const id = artifactIdOf(project, name);

        const readRow =
          sql`SELECT * FROM artifacts WHERE project_slug = ${project} AND name = ${name}`.pipe(
            Effect.flatMap(decodeStoredRows),
            Effect.map((rows) => Option.fromNullishOr(rows[0]))
          );

        const held = yield* readRow.pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(storeFailure(cause)),
            SchemaError: (cause) => Effect.fail(storeFailure(cause)),
          })
        );

        if (Option.isSome(held) && held.value.thread_id !== input.threadId) {
          return yield* refuse(
            "taken",
            `Another thread already published ${project}/${name}. Publish under another name.`,
            Option.none()
          );
        }

        const unmanaged = refuse(
          "unmanaged",
          `${project}/${name} already exists in the artifacts folder and Cairn did not publish it, so publishing would overwrite it. Publish under another name.`,
          Option.none()
        );

        const exists = yield* fs
          .exists(target)
          .pipe(Effect.orElseSucceed(() => true));

        if (exists) {
          // A revoked row's file is gone; one there now is somebody else's. A claim porch never
          // filled in proves nothing about the file on disk unless it is the source's own bytes.
          const published = Option.isSome(held) && held.value.hash !== null;

          const ours = Option.isSome(held) && held.value.revoked_at === null;

          if (
            !ours ||
            (!published && !(yield* isCopyOf(fs, input.source, target)))
          ) {
            return yield* unmanaged;
          }
        }

        const now = yield* Clock.currentTimeMillis;
        let fresh = Option.isNone(held);

        if (fresh) {
          // The UNIQUE key turns a race with another claim into `taken`, unless the winner is
          // this same thread; any other store failure is only a store failure.
          const raced = yield* sql`
            INSERT INTO artifacts (id, thread_id, project_slug, name, claimed_at, updated_at)
            VALUES (${id}, ${input.threadId}, ${project}, ${name}, ${now}, ${now})
          `.pipe(
            Effect.as(false),
            Effect.catchTag("SqlError", (cause) =>
              Predicate.isTagged(cause.reason, "UniqueViolation")
                ? Effect.succeed(true)
                : Effect.fail(storeFailure(cause))
            )
          );

          if (raced) {
            const winner = yield* readRow.pipe(
              Effect.catchTags({
                SqlError: (cause) => Effect.fail(storeFailure(cause)),
                SchemaError: (cause) => Effect.fail(storeFailure(cause)),
              })
            );

            if (
              Option.isNone(winner) ||
              winner.value.thread_id !== input.threadId
            ) {
              return yield* refuse(
                "taken",
                `${project}/${name} was claimed at the same moment by another publish. Publish under another name.`,
                Option.none()
              );
            }

            fresh = false;
          }
        }

        yield* faults.after("claim");

        const receipt = yield* porch.publish(input.source, project).pipe(
          Effect.tapError((error) =>
            // A refusal changed nothing, so a fresh claim gives the key back. Anything else (a
            // timeout, a crash, a receipt Cairn could not read after porch exited 0) may have
            // published, so the claim stays for the rerun.
            fresh && releasesClaim(error)
              ? sql`DELETE FROM artifacts WHERE id = ${id} AND hash IS NULL`.pipe(
                  Effect.catchTag("SqlError", (cause) =>
                    Effect.logWarning("artifact claim not released").pipe(
                      Effect.annotateLogs({
                        event: "artifact_claim_release_failed",
                        artifact: id,
                        cause: cause.message,
                      })
                    )
                  )
                )
              : Effect.void
          )
        );

        yield* faults.after("porch");

        const publishedAt = yield* Clock.currentTimeMillis;

        yield* sql`
          UPDATE artifacts SET
            kind = ${measured.kind},
            url = ${receipt.url},
            hash = ${receipt.hash},
            bytes = ${measured.bytes},
            published_at = COALESCE(published_at, ${publishedAt}),
            updated_at = ${publishedAt},
            revoked_at = NULL
          WHERE id = ${id}
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(storeFailure(cause))
          )
        );

        const stored = yield* readRow.pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(storeFailure(cause)),
            SchemaError: (cause) => Effect.fail(storeFailure(cause)),
          })
        );

        if (Option.isNone(stored)) {
          return yield* refuse(
            "store",
            `The artifacts row for ${project}/${name} vanished while it was published. The page is live at ${receipt.url}; publish again to record it.`,
            Option.none()
          );
        }

        const row = yield* rowOf(stored.value).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail(storeFailure(cause))
          )
        );

        return { row, changed: receipt.changed };
      });

      return ArtifactPublisher.of({ publish });
    })
  );

  /** With Node's file system; needs `PorchClient` and `SqlClient`. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );
}
