// Artifacts (ADR 0038, docs/phase-2/notes/reach.md R4): a page an agent publishes from its thread
// to `https://plans.<domain>/<project>/<name>`, copied by porch into the user's artifacts folder
// (`~/Developer/agent-artifacts/<project>/`) and served there only to the owner, by the Caddyfile's
// owner-only guard. This service is what the `artifact_*` tools and the `reach.list` and
// `artifact.revoke` RPCs call.
//
// Publishing checks the request before any path is built from it: the project must be one slug
// segment (`checkPublish`'s rule, so a climbing project never names a staging path), and the source
// must resolve (symlinks followed) inside the thread's cwd, since publishing copies a file to a
// URL. No folder on the way to it may be a dot folder or a `.env*`, `.git` or `node_modules`; a
// folder source holds none of those anywhere and no symlink (the walk stops at the first), and the
// whole is at most `MAX_ARTIFACT_BYTES`. The source is then staged once at
// `<data>/artifacts/<thread>/<project>/<name>` (owner-only folders), so porch always sees one
// stable source per thread and name: a republish from the same thread updates the page in place,
// whatever path the agent wrote it at, and `name` may differ from the source's basename. The staged
// copy is checked again (a link at its root included), so a source that changed between the check
// and the copy is still refused. The publish itself goes through `ArtifactPublisher`, which
// refuses a name another thread holds and anything Cairn did not publish, and records the row.
//
// Every step is idempotent for one thread and request, so the tools are `replay: "safe"`: a crash
// mid-copy restages; a crash after porch republishes the same bytes (`changed: false`); a crash
// before a revoked page's copy is restored restores it on the rerun. `judges/artifacts-kill.ts`
// kills a brain at each of these through `ArtifactFaults` and reruns the call.
//
// Revoking removes porch's copy from the artifacts folder and the staged copy, then marks the row
// `revoked_at`; the row keeps the name for its thread. The files are removed before the mark, so a
// crash between them is mended by revoking again. A row already revoked is answered as it is,
// with no file touched: its page is gone, and a file at its target now is somebody else's. porch
// has no unpublish, so its registry still records the page: republishing the same bytes answers
// `changed: false` without copying (measured on porch 0.0.0 by `judges/reach.ts`), and the
// publish puts the staged copy back itself when the target is missing.
//
// The staged copies of a deleted thread stay under `<data>/artifacts/<thread>/` until thread
// deletion gains a hook to remove them.

import path from "node:path";

import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ArtifactRow, MAX_ARTIFACT_BYTES } from "@cairn/protocol/Reach";
import type { ArtifactId } from "@cairn/protocol/Reach";
import { NodeServices } from "@effect/platform-node";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Projects } from "../projects/Projects.ts";
import { ArtifactFaults } from "./ArtifactFaults.ts";
import { ArtifactPublisher } from "./ArtifactPublisher.ts";
import type { ArtifactPublishError, Published } from "./ArtifactPublisher.ts";
import type { PorchError } from "./PorchClient.ts";
import { checkPublish, PorchClient } from "./PorchClient.ts";

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Why Cairn would not publish a source, before anything was copied. `outside`: it does not resolve
 * inside the thread's cwd. `secret`: a `.env*`, `.git` or `node_modules` entry, or a dot folder on
 * the way to it. `symlink`: a link inside a folder, or a source swapped for one. `missing`: nothing
 * there. `too-large`: over `MAX_ARTIFACT_BYTES`. `name`: not a usable page name. `project`: no
 * project to publish under, or one that is not a slug. `no-cwd`: the thread has no folder.
 */
export class ArtifactRefused extends Schema.TaggedError<ArtifactRefused>()(
  "ArtifactRefused",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "outside",
      "secret",
      "symlink",
      "missing",
      "too-large",
      "name",
      "project",
      "no-cwd",
    ]),
    /** The path at fault, as the agent can find it. */
    path: Schema.String,
  }
) {}

/** No published artifact has that id, or it belongs to another thread. */
export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()(
  "ArtifactNotFound",
  {
    message: Schema.String,
    artifactId: Schema.String,
  }
) {}

/** `cairn.sqlite` or the staging folder failed; nothing the caller sent was wrong. */
export class ArtifactsError extends Schema.TaggedError<ArtifactsError>()(
  "ArtifactsError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["store", "files"]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────

/** One publish as a tool asks for it. */
export interface PublishRequest {
  readonly threadId: ThreadId;
  /** The thread's project, which names the default artifacts project. */
  readonly projectId: Option.Option<ProjectId>;
  /** The thread's working folder (`pi.agent` cwd); the source must resolve inside it. */
  readonly cwd: string;
  /** The file or folder, absolute or relative to `cwd`. */
  readonly path: string;
  /** The page's name; the source's basename by default. */
  readonly name: Option.Option<string>;
  /** The artifacts project slug; the thread's project's by default. */
  readonly project: Option.Option<string>;
}

/** Whether a publish was the page's first, an update of its bytes, or the same bytes again. */
export type PublishOutcome = "published" | "updated" | "unchanged";

/** What a publish did. */
export const outcomeOf = (published: Published): PublishOutcome => {
  if (!published.changed) {
    return "unchanged";
  }

  return DateTime.Equivalence(
    published.row.publishedAt,
    published.row.updatedAt
  )
    ? "published"
    : "updated";
};

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** A page name: one path segment, a URL-safe file name. */
const PAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Entries never published, by name, wherever they sit in a folder. */
const isSecretSegment = (segment: string) =>
  segment.startsWith(".env") ||
  segment === ".git" ||
  segment === "node_modules";

/** The project slug of a scratch project's threads. */
export const SCRATCH_SLUG = "scratch";

/**
 * The artifacts project of a Cairn project: `scratch` for the scratch project, otherwise its
 * root folder's name, lowercased, with every run of other characters folded to `-`, so
 * `~/Developer/projects/cairn` publishes under `agent-artifacts/cairn/`.
 */
export const projectSlugOf = (project: {
  readonly kind: "folder" | "scratch";
  readonly workspaceRoot: string;
}) => {
  if (project.kind === "scratch") {
    return SCRATCH_SLUG;
  }

  const slug = path
    .basename(project.workspaceRoot)
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replaceAll("..", ".")
    .slice(0, 64);

  return slug === "" ? SCRATCH_SLUG : slug;
};

/** Whether `child` is `parent` or inside it; both absolute and resolved. */
const isInside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────

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

/** The artifact row of a published stored row. */
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

/** A staging or artifacts-folder failure of `operation`, which may simply be repeated. */
const filesFailure = (operation: string, what: string) => (cause: Error) =>
  new ArtifactsError({
    message: `${operation} could not ${what}: ${cause.message}. Nothing was published; the call is safe to repeat.`,
    operation,
    reason: "files",
    cause,
  });

/** A `cairn.sqlite` failure of `operation`. */
const storeFailure = (operation: string) => (cause: Error) =>
  new ArtifactsError({
    message: `${operation} could not read or write the artifacts table: ${cause.message}. Retry; check the brain's log if it repeats.`,
    operation,
    reason: "store",
    cause,
  });

/** The artifact row a revoke answers; a row that breaks the shape is a store failure. */
const revokedRowOf = (stored: StoredRow) =>
  rowOf(stored).pipe(
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(storeFailure("artifact.revoke")(cause))
    )
  );

const refuse = (
  reason: ArtifactRefused["reason"],
  at: string,
  message: string
) => new ArtifactRefused({ message, reason, path: at });

// ── The service ──────────────────────────────────────────────────────────────────────────────────

/** Publishes, lists and revokes a thread's artifacts. */
export class Artifacts extends Context.Service<
  Artifacts,
  {
    /**
     * Checks, stages and publishes one file or folder for a thread. Fails `ArtifactRefused` before
     * anything is copied, `ArtifactPublishError` when the name is another thread's or a file Cairn
     * did not publish sits there, `PorchError` when porch refuses or is not set up.
     */
    publish(
      request: PublishRequest
    ): Effect.Effect<
      Published,
      ArtifactRefused | ArtifactPublishError | PorchError | ArtifactsError
    >;
    /** Published artifacts, newest first: one thread's, or every thread's. Revoked ones included. */
    list(
      threadId: Option.Option<ThreadId>
    ): Effect.Effect<ReadonlyArray<ArtifactRow>, ArtifactsError>;
    /**
     * Stops serving one artifact; the row keeps its name for its thread. Revoking again is a
     * no-op. With `owner`, an artifact of another thread is `ArtifactNotFound`.
     */
    revoke(
      artifactId: ArtifactId,
      owner: Option.Option<ThreadId>
    ): Effect.Effect<
      ArtifactRow,
      ArtifactNotFound | ArtifactsError | PorchError
    >;
  }
>()("cairn/server/reach/Artifacts") {
  /**
   * Over the ambient `ArtifactPublisher`, `PorchClient`, `Projects`, `SqlClient`, `FileSystem`
   * and `ServerConfig` (whose `dataDir` holds the staging folder).
   */
  static readonly layerNoDeps = Layer.effect(
    Artifacts,
    Effect.gen(function* () {
      const publisher = yield* ArtifactPublisher;
      const porch = yield* PorchClient;
      const projects = yield* Projects;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const stagingRoot = path.join(config.dataDir, "artifacts");
      const faults = yield* ArtifactFaults;

      /**
       * Walks `root` (a file or a folder, its own path resolved) and answers its size, refusing
       * secrets and symlinks and stopping past the cap. The walk checks each entry before it
       * descends, so the first secret folder stops it unread. `shown` names `root` in messages.
       */
      const inspect = Effect.fnUntraced(function* (
        root: string,
        shown: string
      ) {
        const info = yield* fs.stat(root);

        if (info.type !== "Directory") {
          return { bytes: Number(info.size) };
        }

        let bytes = 0;
        const pending = [""];

        for (
          let folder = pending.pop();
          folder !== undefined;
          folder = pending.pop()
        ) {
          for (const entry of (yield* fs.readDirectory(
            path.join(root, folder)
          )).toSorted()) {
            const relative = path.join(folder, entry);
            const at = path.join(root, relative);

            if (isSecretSegment(entry)) {
              return yield* refuse(
                "secret",
                path.join(shown, relative),
                `${path.join(shown, relative)} looks like a secret or a dependency folder (.env*, .git or node_modules), and publishing would put it at a URL. Publish a folder without it.`
              );
            }

            // A link resolves somewhere other than its own path.
            if ((yield* fs.realPath(at)) !== at) {
              return yield* refuse(
                "symlink",
                path.join(shown, relative),
                `${path.join(shown, relative)} is a symbolic link. A published folder holds only real files; copy what it points to instead.`
              );
            }

            const child = yield* fs.stat(at);

            if (child.type === "Directory") {
              pending.push(relative);
            } else if (child.type === "File") {
              bytes += Number(child.size);

              if (bytes > MAX_ARTIFACT_BYTES) {
                return { bytes };
              }
            }
          }
        }

        return { bytes };
      });

      const projectNamed = Effect.fnUntraced(function* (
        request: PublishRequest
      ) {
        if (Option.isSome(request.project)) {
          return request.project.value;
        }

        const row = Option.isSome(request.projectId)
          ? yield* projects.get(request.projectId.value).pipe(
              Effect.mapError(
                (cause) =>
                  new ArtifactsError({
                    message: `artifact_publish could not read the thread's project: ${cause.message}. Retry, or pass project.`,
                    operation: "artifact_publish",
                    reason: "store",
                    cause,
                  })
              )
            )
          : Option.none();

        if (Option.isNone(row)) {
          return yield* refuse(
            "project",
            request.path,
            "This thread has no project to publish under. Pass project, a slug such as my-site."
          );
        }

        return projectSlugOf(row.value.shell);
      });

      /** The project to publish under, refused unless it is one slug segment. */
      const projectFor = Effect.fnUntraced(function* (
        request: PublishRequest,
        source: string
      ) {
        const project = yield* projectNamed(request);

        if (Option.isSome(checkPublish(source, project))) {
          return yield* refuse(
            "project",
            project,
            `${project} is not a project slug: use lowercase letters, digits, ".", "_" and "-", starting with a letter or digit, up to 64 characters, and no "..".`
          );
        }

        return project;
      });

      const publish = Effect.fn("Artifacts.publish")(function* (
        request: PublishRequest
      ) {
        if (!path.isAbsolute(request.cwd)) {
          return yield* refuse(
            "no-cwd",
            request.path,
            "This thread has no working folder, so there is nothing to publish from."
          );
        }

        const cwd = yield* fs
          .realPath(request.cwd)
          .pipe(
            Effect.mapError(() =>
              refuse(
                "no-cwd",
                request.cwd,
                `The thread's folder ${request.cwd} does not exist, so there is nothing to publish from.`
              )
            )
          );

        const asked = path.resolve(request.cwd, request.path);

        const source = yield* fs
          .realPath(asked)
          .pipe(
            Effect.mapError(() =>
              refuse(
                "missing",
                request.path,
                `${request.path} does not exist. Write the page first, then publish it.`
              )
            )
          );

        if (!isInside(cwd, source)) {
          return yield* refuse(
            "outside",
            request.path,
            `${request.path} resolves to ${source}, outside this thread's folder ${cwd}. Only files inside the thread's folder can be published; copy the page there first.`
          );
        }

        const name = Option.getOrElse(request.name, () =>
          path.basename(source)
        );

        if (!PAGE_NAME.test(name) || isSecretSegment(name)) {
          return yield* refuse(
            "name",
            name,
            `${name} is not a page name: use letters, digits, ".", "_" and "-", starting with a letter or digit, up to 128 characters, and not .env*, .git or node_modules.`
          );
        }

        // The source itself, and every folder between the thread's folder and it: `.git/config`,
        // `node_modules/x/README.md` and anything under a dot folder (`.ssh/...`) stay off URLs.
        const segments = path.relative(cwd, source).split(path.sep);

        if (
          isSecretSegment(path.basename(source)) ||
          segments.some(isSecretSegment) ||
          segments.slice(0, -1).some((segment) => segment.startsWith("."))
        ) {
          return yield* refuse(
            "secret",
            request.path,
            `${request.path} is or sits in a secret, dependency or hidden folder (.env*, .git, node_modules or a dot folder), and publishing would put it at a URL. Copy the page somewhere plain in the thread's folder first.`
          );
        }

        const project = yield* projectFor(request, source);

        const tooLarge = (bytes: number) =>
          refuse(
            "too-large",
            request.path,
            `${request.path} is ${String(bytes)} bytes or more, over the ${String(MAX_ARTIFACT_BYTES)}-byte artifact limit. Publish something smaller.`
          );

        const measured = yield* inspect(source, request.path).pipe(
          Effect.catchTag(
            "PlatformError",
            filesFailure("artifact_publish", `read ${request.path}`)
          )
        );

        if (measured.bytes > MAX_ARTIFACT_BYTES) {
          return yield* tooLarge(measured.bytes);
        }

        // One stable source per thread, project and name: porch keys its records by source.
        const threadFolder = path.join(stagingRoot, request.threadId);
        const folder = path.join(threadFolder, project);
        const staged = path.join(folder, name);

        // The project and name are single checked segments; this holds the line if a check moves.
        if (path.dirname(path.dirname(staged)) !== threadFolder) {
          return yield* refuse(
            "project",
            project,
            `${project}/${name} does not name a folder inside this thread's staging folder.`
          );
        }

        yield* Effect.gen(function* () {
          // The staging folder and each thread's are the owner's alone, whoever made them first.
          for (const owned of [stagingRoot, threadFolder]) {
            yield* fs.makeDirectory(owned, { recursive: true, mode: 0o700 });
            yield* fs.chmod(owned, 0o700);
          }

          yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
          yield* fs.remove(staged, { recursive: true, force: true });
          yield* fs.copy(source, staged);
        }).pipe(
          Effect.catchTag(
            "PlatformError",
            filesFailure("artifact_publish", `stage ${request.path}`)
          )
        );

        // The copy is what porch publishes, so it is the copy that must hold no secret or link: a
        // source swapped for a link after the check is copied as the link itself.
        const copied = yield* Effect.gen(function* () {
          const real = yield* fs.realPath(staged);

          if (real !== path.join(yield* fs.realPath(folder), name)) {
            return yield* refuse(
              "symlink",
              request.path,
              `${request.path} became a symbolic link while it was copied. Publish a real file or folder.`
            );
          }

          return yield* inspect(real, request.path);
        }).pipe(
          Effect.catchTag(
            "PlatformError",
            filesFailure("artifact_publish", `read the staged ${name}`)
          )
        );

        if (copied.bytes > MAX_ARTIFACT_BYTES) {
          return yield* tooLarge(copied.bytes);
        }

        yield* faults.after("stage");

        const published = yield* publisher.publish({
          threadId: request.threadId,
          source: staged,
          project,
        });

        yield* faults.after("publish");

        if (published.changed) {
          return published;
        }

        // porch 0.0.0 answers `changed: false` from its registry alone, without looking at the
        // target, so after a revoke removed the copy the same bytes would never be served again.
        // Its record already names this source and these bytes, so putting the copy back is what
        // porch itself would have written.
        const machine = yield* porch.machine;
        const target = path.join(machine.artifacts, project, name);

        const restored = yield* Effect.gen(function* () {
          if (yield* fs.exists(target)) {
            return false;
          }

          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.copy(staged, target);

          return true;
        }).pipe(
          Effect.catchTag(
            "PlatformError",
            filesFailure("artifact_publish", `restore ${target}`)
          )
        );

        return restored ? { ...published, changed: true } : published;
      });

      const readAll = (threadId: Option.Option<ThreadId>) =>
        Option.match(threadId, {
          onNone: () => sql`
            SELECT * FROM artifacts WHERE hash IS NOT NULL
            ORDER BY updated_at DESC, id
          `,
          onSome: (thread) => sql`
            SELECT * FROM artifacts WHERE hash IS NOT NULL AND thread_id = ${thread}
            ORDER BY updated_at DESC, id
          `,
        });

      const list = Effect.fn("Artifacts.list")(
        function* (threadId: Option.Option<ThreadId>) {
          const stored = yield* decodeStoredRows(yield* readAll(threadId));

          return yield* Effect.forEach(stored, rowOf);
        },
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(storeFailure("reach.list")(cause)),
          SchemaError: (cause) =>
            Effect.fail(storeFailure("reach.list")(cause)),
        })
      );

      const readOne = (artifactId: ArtifactId) =>
        sql`SELECT * FROM artifacts WHERE id = ${artifactId} AND hash IS NOT NULL`.pipe(
          Effect.flatMap(decodeStoredRows),
          Effect.map((rows) => Option.fromNullishOr(rows[0])),
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(storeFailure("artifact.revoke")(cause)),
            SchemaError: (cause) =>
              Effect.fail(storeFailure("artifact.revoke")(cause)),
          })
        );

      const revoke = Effect.fn("Artifacts.revoke")(function* (
        artifactId: ArtifactId,
        owner: Option.Option<ThreadId>
      ) {
        const held = yield* readOne(artifactId);

        const notFound = new ArtifactNotFound({
          message: `No published artifact ${artifactId}${Option.isSome(owner) ? " in this thread" : ""}. List the artifacts to see their names.`,
          artifactId,
        });

        if (
          Option.isNone(held) ||
          (Option.isSome(owner) && held.value.thread_id !== owner.value)
        ) {
          return yield* notFound;
        }

        // Already revoked: the page is gone, and a file at its target now is somebody else's.
        if (held.value.revoked_at !== null) {
          return yield* revokedRowOf(held.value);
        }

        const machine = yield* porch.machine;

        const target = path.join(
          machine.artifacts,
          held.value.project_slug,
          held.value.name
        );

        const staged = path.join(
          stagingRoot,
          held.value.thread_id,
          held.value.project_slug,
          held.value.name
        );

        // The row is live, so the file at its key is porch's copy of Cairn's page. A rerun after a
        // crash before the mark below removes nothing new: the row still says Cairn's copy.
        for (const file of [target, staged]) {
          yield* fs
            .remove(file, { recursive: true, force: true })
            .pipe(
              Effect.catchTag(
                "PlatformError",
                filesFailure("artifact.revoke", `remove ${file}`)
              )
            );
        }

        yield* faults.after("remove");

        const now = yield* Clock.currentTimeMillis;

        yield* sql`
          UPDATE artifacts SET revoked_at = ${now}, updated_at = ${now}
          WHERE id = ${artifactId} AND revoked_at IS NULL
        `.pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(storeFailure("artifact.revoke")(cause))
          )
        );

        const stored = yield* readOne(artifactId);

        if (Option.isNone(stored)) {
          return yield* notFound;
        }

        return yield* revokedRowOf(stored.value);
      });

      return Artifacts.of({ publish, list, revoke });
    })
  );

  /** With the projects reader and Node's file system; needs the rest. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Projects.layerNoDeps),
    Layer.provide(NodeServices.layer)
  );

  /**
   * For tests and judge brains that build the extension set: a fake porch serving
   * `plans.example.test` from a temp folder, a fresh migrated in-memory `cairn.sqlite`, and a temp
   * data folder, all removed with the layer's scope. Nothing outside the temp folder is touched.
   */
  static readonly layerTest = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "cairn-artifacts-test-",
      });

      const artifacts = path.join(root, "artifacts");
      yield* fs.makeDirectory(artifacts);

      return Artifacts.layer.pipe(
        Layer.provide(ArtifactPublisher.layer),
        Layer.provide(
          PorchClient.layerFake({ domain: "example.test", artifacts })
        ),
        Layer.provide(Database.layerTest(migrations)),
        Layer.provide(
          ServerConfig.layerWith({ dataDir: path.join(root, "data") })
        )
      );
    })
  ).pipe(Layer.provide(NodeServices.layer), Layer.orDie);
}
