// `workflow.list`: the saved recipes a thread can launch (`Recipes`), the built-in ones and, given a
// project, the project's own from its root. `workflow.stop` and `workflow.stopNode` (ADR 0012 as
// amended, workflows note W6): thin handlers over `WorkflowStops`, which aborts the script call or
// the node's task and answers once the stop is marked. A stop of an ended workflow or node succeeds
// and changes nothing.

import { NotFound, Unavailable } from "@cairn/protocol/Errors";
import type { ProjectId } from "@cairn/protocol/Ids";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import { Projects } from "../projects/Projects.ts";
import { Recipes } from "../workflows/recipes/Recipes.ts";
import { WorkflowStops } from "../workflows/WorkflowStop.ts";

/** The handlers, for the handler group and for tests that call them directly. */
export const workflowHandlers = Effect.gen(function* () {
  const recipes = yield* Recipes;
  const projects = yield* Projects;

  const rootOf = Effect.fnUntraced(function* (
    projectId: ProjectId,
    requestId: Option.Option<string>
  ) {
    const row = yield* projects
      .get(projectId)
      .pipe(
        Effect.mapError(
          (failure) => new Unavailable({ message: failure.message, requestId })
        )
      );

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
    list: Effect.fn("WorkflowHandlers.list")(function* (
      projectId: Option.Option<ProjectId>,
      requestId: Option.Option<string>
    ) {
      const root = Option.isSome(projectId)
        ? Option.some(yield* rootOf(projectId.value, requestId))
        : Option.none<string>();

      return yield* recipes.list(root);
    }),
  };
});

/**
 * The workflow handlers, to merge over the stubs in `rpc/Handlers.ts`. Needs `Recipes`, `Projects`
 * and `WorkflowStops`.
 */
export const WorkflowHandlers = {
  layer: Layer.mergeAll(
    CairnRpcs.toLayerHandler(
      "workflow.list",
      Effect.map(
        workflowHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.list(input.projectId, Option.some(String(requestId)))
      )
    ),
    CairnRpcs.toLayerHandler(
      "workflow.stop",
      WorkflowStops.useSync((stops) => (input) => stops.stop(input))
    ),
    CairnRpcs.toLayerHandler(
      "workflow.stopNode",
      WorkflowStops.useSync((stops) => (input) => stops.stopNode(input))
    )
  ),
};
