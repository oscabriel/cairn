// The workflows extension as the installed set takes it (ExtensionSet.ts, integrator seam): the
// node tools, the watcher task and the gate (WorkflowTools.ts), resolving each node's role through
// `RoleAliases` right before the commit that creates its child (ADR 0035). pi-durable calls the
// resolver outside Effect, so it runs through the layer's context (S43).

import { Context, Effect, Layer, Option } from "effect";

import type { CairnExtension } from "../brain/Extensions.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import {
  NO_HOLD,
  NO_WORKFLOW_FAULTS,
  workflowExtension,
} from "./WorkflowTools.ts";
import type { ResolvedNodeModel, RoleResolver } from "./WorkflowTools.ts";

/** The workflows extension, for the installed set. */
export class Workflows extends Context.Service<
  Workflows,
  { readonly extension: CairnExtension }
>()("cairn/server/workflows/Workflows") {
  /** Over the root's `RoleAliases`; no faults, no holds. */
  static readonly layer = Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const roles = yield* RoleAliases;
      const run = Effect.runPromiseWith(yield* Effect.context());

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
          faults: NO_WORKFLOW_FAULTS,
          hold: NO_HOLD,
        }),
      });
    })
  );
}
