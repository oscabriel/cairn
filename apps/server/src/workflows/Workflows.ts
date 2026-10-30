// The workflows extension as the installed set takes it (ExtensionSet.ts, integrator seam): the
// plan tool, the node tools, the watcher task and the gate (WorkflowTools.ts), resolving each node's
// role through `RoleAliases` right before the commit that creates its child (ADR 0035) and
// dry-running proposals through `WorkflowPlan` and finding a project recipe named by reference
// through `Recipes`. pi-durable calls both outside Effect, so they run
// through the layer's context (S43). The dry run needs nothing of the brain, so the layer builds its
// own `WorkflowPlan` (the memo map shares it with the app's). The soft line's push task hands its
// pushes to `WorkflowPushes` when the layer is given one (the integrator provides the reference
// `AppLayer` drains through `WorkflowBudgetPush`); without one it sends nothing.

import { Context, Effect, FileSystem, Layer, Option, Result } from "effect";

import type { CairnExtension } from "../brain/Extensions.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { Recipes } from "./recipes/Recipes.ts";
import { HOLD_RETRY_MILLIS, NO_BUDGET_PUSH } from "./WorkflowBudget.ts";
import type { BudgetPushSink } from "./WorkflowBudget.ts";
import { WorkflowPlan } from "./WorkflowPlan.ts";
import { NO_PROJECT_RECIPES } from "./WorkflowPlanTool.ts";
import type { PlanAccess } from "./WorkflowPlanTool.ts";
import { WorkflowPushes } from "./WorkflowPushes.ts";
import {
  NO_HOLD,
  NO_WORKFLOW_FAULTS,
  workflowExtension,
} from "./WorkflowTools.ts";
import type { ResolvedNodeModel, RoleResolver } from "./WorkflowTools.ts";

/**
 * `WorkflowPlan.validate` for `workflow_plan`, which runs outside Effect: the dry run, or the
 * refusal's words for the model; and the project recipes `recipes` finds, none without it. Runs
 * with `context`, the layer's (S43).
 */
export const planAccess = (
  plan: WorkflowPlan["Service"],
  recipes: Option.Option<Recipes["Service"]>,
  context: Context.Context<never>
): PlanAccess => {
  const run = Effect.runPromiseWith(context);

  return {
    dryRun: async (source, input) =>
      await run(
        plan
          .validate(source, input)
          .pipe(
            Effect.result,
            Effect.map(Result.mapError((error) => error.message))
          )
      ),
    projectRecipe: Option.match(recipes, {
      onNone: () => NO_PROJECT_RECIPES,
      onSome: (found) => async (root: string, name: string) =>
        await run(found.source(root, name)),
    }),
  };
};

/** The workflows extension, for the installed set. */
export class Workflows extends Context.Service<
  Workflows,
  { readonly extension: CairnExtension }
>()("cairn/server/workflows/Workflows") {
  /**
   * Over the root's `RoleAliases`, `WorkflowPushes` and the platform's `FileSystem` when given; no
   * faults, no holds.
   */
  static readonly layer = Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const roles = yield* RoleAliases;
      // Project recipes are read through the platform's file system when the brain has one (the
      // installed set does); without it a reference names only a built-in.
      const files = yield* Effect.serviceOption(FileSystem.FileSystem);

      const recipes = yield* Option.match(files, {
        onNone: () => Effect.succeed(Option.none<Recipes["Service"]>()),
        onSome: (fs) =>
          Recipes.make.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.asSome
          ),
      });

      const context = yield* Effect.context();
      const run = Effect.runPromiseWith(context);
      const outbox = yield* Effect.serviceOption(WorkflowPushes);

      const push = Option.match(outbox, {
        onNone: (): BudgetPushSink => NO_BUDGET_PUSH,
        onSome:
          (pushes): BudgetPushSink =>
          async (each) => {
            await run(pushes.send(each));
          },
      });

      const resolveRole: RoleResolver = async (spec, overrides) =>
        await run(
          roles.resolve(spec, overrides).pipe(
            Effect.map((resolved): ResolvedNodeModel => ({
              provider: resolved.model.provider,
              modelId: resolved.model.modelId,
              thinkingLevel: Option.fromNullOr(resolved.thinkingLevel),
            })),
            Effect.mapError((error) => error.message),
            Effect.result
          )
        );

      return Workflows.of({
        extension: workflowExtension({
          resolveRole,
          plan: planAccess(yield* WorkflowPlan, recipes, context),
          faults: NO_WORKFLOW_FAULTS,
          hold: NO_HOLD,
          holdRetryMillis: HOLD_RETRY_MILLIS,
          push,
        }),
      });
    })
  ).pipe(Layer.provide(WorkflowPlan.layer));
}
