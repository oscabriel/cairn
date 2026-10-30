// `GET /api/projects/:projectId/favicon`: the favicon the rail draws in a project's bubble, found in
// the project's root as t3code finds it (`ProjectFavicon.ts`). A project with none, the scratch
// project, or an unknown id answers 404, and the rail draws the project's letter instead. Lookups
// are cached by root (a hit for ten minutes, a miss for one, as t3code); a cached hit whose file is
// gone is looked up again. The guard in front of `/api` admits only the owner. The bytes are a
// project's own file, so they are served with `nosniff` and a sandbox CSP (an SVG cannot run as a
// page), and cached only by the browser that asked, for ten minutes.

import { ProjectId } from "@cairn/protocol/Ids";
import {
  Cache,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Schema,
} from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { problem } from "../http/Problem.ts";
import { findFavicon } from "./ProjectFavicon.ts";
import type { Favicon } from "./ProjectFavicon.ts";
import { Projects } from "./Projects.ts";

/** A favicon's bytes and what they are. */
interface Served {
  readonly bytes: Uint8Array;
  readonly favicon: Favicon;
}

/** The route's path, as the router matches it. */
export const PROJECT_FAVICON_PATH = "/api/projects/:projectId/favicon";

/** The address of a project's favicon, for the client's rail. */
export const projectFaviconUrl = (projectId: ProjectId): string =>
  `/api/projects/${encodeURIComponent(projectId)}/favicon`;

const Params = Schema.Struct({ projectId: ProjectId });

/** How many roots' lookups the cache keeps. */
const CACHE_CAPACITY = 256;

const HIT_TTL = Duration.minutes(10);

const MISS_TTL = Duration.minutes(1);

/** The headers a favicon is served with. */
export const faviconHeaders = (mediaType: string) => ({
  contentType: mediaType,
  headers: {
    "cache-control": "private, max-age=600",
    "content-disposition": "inline",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "x-content-type-options": "nosniff",
  },
});

/** Serves project favicons; register it in `http/Routes.ts`. It takes `Projects` when built. */
export const ProjectFaviconRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const projects = yield* Projects;
    const fileSystem = yield* FileSystem.FileSystem;

    // The lookups read the files through the `FileSystem` the router was built with.
    const cache = yield* Cache.makeWith(findFavicon, {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit: Exit.Exit<Option.Option<Favicon>>) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? HIT_TTL : MISS_TTL,
    });

    /** A favicon's bytes; none when its file cannot be read now. */
    const read = (favicon: Favicon) =>
      fileSystem
        .readFile(favicon.path)
        .pipe(
          Effect.option,
          Effect.map(Option.map((bytes): Served => ({ bytes, favicon })))
        );

    /** The root's favicon; a cached hit whose file went is looked up once more. */
    const bytesOf = Effect.fnUntraced(function* (workspaceRoot: string) {
      const cached = yield* Cache.get(cache, workspaceRoot);

      if (Option.isNone(cached)) {
        return Option.none<Served>();
      }

      const first = yield* read(cached.value);

      if (Option.isSome(first)) {
        return first;
      }

      yield* Cache.invalidate(cache, workspaceRoot);

      const fresh = yield* Cache.get(cache, workspaceRoot);

      return Option.isSome(fresh)
        ? yield* read(fresh.value)
        : Option.none<Served>();
    });

    const response = Effect.gen(function* () {
      const params = yield* HttpRouter.schemaPathParams(Params).pipe(
        Effect.option
      );

      if (Option.isNone(params)) {
        return problem(
          400,
          "invalid_input",
          "The favicon address is malformed: it needs a project id."
        );
      }

      const { projectId } = params.value;

      const project = Option.filter(
        yield* projects.get(projectId),
        (row) => Option.isNone(row.deletedAt) && row.shell.kind === "folder"
      );

      if (Option.isNone(project)) {
        return problem(
          404,
          "not_found",
          `Project ${projectId} has no favicon: it is unknown, removed, or the scratch project.`
        );
      }

      const found = yield* bytesOf(project.value.shell.workspaceRoot);

      return Option.match(found, {
        onNone: () =>
          problem(
            404,
            "not_found",
            `Project ${projectId} has no favicon in its root; the rail shows its letter.`
          ),
        onSome: ({ bytes, favicon }) =>
          HttpServerResponse.uint8Array(
            bytes,
            faviconHeaders(favicon.mediaType)
          ),
      });
    }).pipe(
      Effect.catchTag("ShellStoreError", (failure) =>
        Effect.succeed(problem(503, "unavailable", failure.message))
      )
    );

    yield* router.add("GET", PROJECT_FAVICON_PATH, response);
  })
);
