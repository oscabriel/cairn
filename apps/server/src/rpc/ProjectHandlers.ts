// `projects.browse`, `projects.ensureScratch`, `projects.searchEntries` and `git.branches`: thin
// calls into the projects services that translate their failures into the protocol's errors,
// carrying the RPC request id.

import { NotFound, Unavailable } from "@cairn/protocol/Errors";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { BrowseInput } from "@cairn/protocol/Projects";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";
import type { RpcMessage } from "effect/rpc";

import { FileSearch } from "../projects/FileSearch.ts";
import { FolderRules } from "../projects/FolderRules.ts";
import { Projects } from "../projects/Projects.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import { Worktrees } from "../projects/Worktrees.ts";

const requestIdOf = (requestId: RpcMessage.RequestId) =>
  Option.some(String(requestId));

const unavailable =
  (requestId: Option.Option<string>) =>
  (failure: { readonly message: string }) =>
    new Unavailable({ message: failure.message, requestId });

/** The handlers, for the handler group and for tests that call them directly. */
export const projectHandlers = Effect.gen(function* () {
  const folders = yield* FolderRules;
  const scratch = yield* ScratchProject;
  const projects = yield* Projects;
  const search = yield* FileSearch;
  const worktrees = yield* Worktrees;

  // The live project's root, or `NotFound`.
  const projectRoot = Effect.fnUntraced(function* (
    projectId: ProjectId,
    requestId: Option.Option<string>
  ) {
    const row = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(unavailable(requestId)));

    if (Option.isNone(row) || Option.isSome(row.value.deletedAt)) {
      return yield* new NotFound({
        message: `Project ${projectId} does not exist. Pick another project.`,
        resource: "project",
        id: projectId,
        requestId,
      });
    }

    return row.value.shell.workspaceRoot;
  });

  return {
    browse: (input: BrowseInput, requestId: Option.Option<string>) =>
      folders.browse(input.path).pipe(
        Effect.catchTags({
          FolderRefused: (refused) =>
            Effect.fail(
              new NotFound({
                message: refused.message,
                resource: "folder",
                id: refused.path,
                requestId,
              })
            ),
        })
      ),
    ensureScratch: (requestId: Option.Option<string>) =>
      scratch.ensure.pipe(Effect.mapError(unavailable(requestId))),
    searchEntries: Effect.fnUntraced(function* (
      input: {
        readonly projectId: ProjectId;
        readonly query: string;
        readonly limit: number;
      },
      requestId: Option.Option<string>
    ) {
      const root = yield* projectRoot(input.projectId, requestId);

      return yield* search
        .search(root, input.query, input.limit)
        .pipe(Effect.mapError(unavailable(requestId)));
    }),
    branches: Effect.fnUntraced(function* (
      input: { readonly projectId: ProjectId },
      requestId: Option.Option<string>
    ) {
      const root = yield* projectRoot(input.projectId, requestId);

      return yield* worktrees
        .branches(root)
        .pipe(Effect.mapError(unavailable(requestId)));
    }),
  };
});

/** The project and git handlers, to merge over the stubs in `rpc/Handlers.ts`. */
export const ProjectHandlers = {
  layer: Layer.mergeAll(
    CairnRpcs.toLayerHandler(
      "projects.browse",
      Effect.map(
        projectHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.browse(input, requestIdOf(requestId))
      )
    ),
    CairnRpcs.toLayerHandler(
      "projects.ensureScratch",
      Effect.map(
        projectHandlers,
        (handlers) =>
          (_input, { requestId }) =>
            handlers.ensureScratch(requestIdOf(requestId))
      )
    ),
    CairnRpcs.toLayerHandler(
      "projects.searchEntries",
      Effect.map(
        projectHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.searchEntries(input, requestIdOf(requestId))
      )
    ),
    CairnRpcs.toLayerHandler(
      "git.branches",
      Effect.map(
        projectHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.branches(input, requestIdOf(requestId))
      )
    )
  ),
};
