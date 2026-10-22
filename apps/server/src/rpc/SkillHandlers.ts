// `skills.list` and `skills.reload`: the composer's `$` and `/` completion for a project, from
// `SkillCatalog` at the project's root. `list` refreshes the cached view (a skill added or edited
// since shows at once); `reload` resolves the owner's pi setup again first (settings.json filters,
// packages). Both also report the project's context files, so one left out is logged.
import { NotFound, Unavailable } from "@cairn/protocol/Errors";
import type { ProjectId } from "@cairn/protocol/Ids";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type { SkillList, SkillSummary } from "@cairn/protocol/Skills";
import { Effect, Layer, Option } from "effect";

import { Projects } from "../projects/Projects.ts";
import { ProjectContext } from "../skills/ProjectContext.ts";
import type { SkillView } from "../skills/SkillCatalog.ts";
import { SkillCatalog } from "../skills/SkillCatalog.ts";

/** The longest description the protocol carries. */
const MAX_DESCRIPTION = 4096;

/** A view as the protocol lists it: every skill, hidden ones marked not model-invocable. */
export const skillList = (view: SkillView): SkillList => ({
  skills: view.skills.map((skill): SkillSummary => ({
    name: skill.name,
    description: skill.description.slice(0, MAX_DESCRIPTION),
    source: skill.source,
    modelInvocable: Option.isNone(skill.hidden),
  })),
});

/** The handlers, for the handler group and for tests that call them directly. */
export const skillHandlers = Effect.gen(function* () {
  const catalog = yield* SkillCatalog;
  const projects = yield* Projects;
  const context = yield* ProjectContext;

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
    list: Effect.fn("SkillHandlers.list")(function* (
      projectId: ProjectId,
      requestId: Option.Option<string>
    ) {
      const root = Option.some(yield* rootOf(projectId, requestId));
      yield* context.report(root);

      return skillList(yield* catalog.refreshForTurn(root));
    }),
    reload: Effect.fn("SkillHandlers.reload")(function* (
      projectId: ProjectId,
      requestId: Option.Option<string>
    ) {
      const root = Option.some(yield* rootOf(projectId, requestId));
      yield* context.report(root);

      return skillList(yield* catalog.reload(root));
    }),
  };
});

/** The skill handlers, to merge over the stubs in `rpc/Handlers.ts`. */
export const SkillHandlers = {
  layer: Layer.mergeAll(
    CairnRpcs.toLayerHandler(
      "skills.list",
      Effect.map(
        skillHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.list(input.projectId, Option.some(String(requestId)))
      )
    ),
    CairnRpcs.toLayerHandler(
      "skills.reload",
      Effect.map(
        skillHandlers,
        (handlers) =>
          (input, { requestId }) =>
            handlers.reload(input.projectId, Option.some(String(requestId)))
      )
    )
  ),
};
