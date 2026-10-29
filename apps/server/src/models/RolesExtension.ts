// The `roles` tool (ADR 0035): a read-only answer to "which model does each role run on now". With
// no arguments it lists every role in the table, built-ins first; with `specs` it checks those, as
// the brief card does. Each line names the model and level the role resolves to now, whether it is
// ready (and what a fallback passed over), its list price, and a warning when a judge or verifier
// shares the worker's family. Tools that take a model describe roles by name only, so their
// declarations stay in the cached prompt; this tool is where a model looks up what a name means.
//
// It reads the world at the call and writes nothing, so it is `replay: "safe"`: a rerun after a
// restart answers from the table as it is then. It runs `RoleAliases` through one runtime made
// from the layer's scope (S43).

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option } from "effect";

import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { RoleAliases, rolesText } from "./RoleAliases.ts";

/** The extension's name in pi-durable's registry. */
export const ROLES_EXTENSION = "cairn.roles";

/** The tool's name, which is also its slash command's. */
export const ROLES_TOOL = "roles";

/** How many specs one call may check. */
const MAX_SPECS = 16;

/** The `roles` tool as a Cairn extension, over the brain's `RoleAliases`. */
export class RolesTool extends Context.Service<
  RolesTool,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/models/RolesExtension/RolesTool") {
  /**
   * Over `RoleAliases`. Installs at `order`, the key the integrator gives it in `ExtensionOrder`;
   * the default is the judge key, for tests that install it alone.
   */
  static readonly layerAt = (order: number) =>
    Layer.effect(
      RolesTool,
      Effect.gen(function* () {
        const roles = yield* RoleAliases;
        const run = yield* FiberSet.makeRuntimePromise();

        const answer = Effect.fn("RolesTool.answer")(
          function* (specs: Option.Option<ReadonlyArray<string>>) {
            const rows = yield* roles.rows(specs);

            return {
              output: [{ type: "text" as const, text: rolesText(rows) }],
            };
          },
          Effect.catchTag("RoleAliasesUnavailable", (failure) =>
            Effect.succeed({
              output: [
                {
                  type: "text" as const,
                  text: `The role table could not be read: ${failure.message}`,
                },
              ],
              isError: true,
            })
          )
        );

        const tool = defineTool({
          name: ROLES_TOOL,
          description:
            "Lists the role aliases (@worker, @scout, @judge, @verifier and any the user added) with the model each resolves to now, whether it is ready, and its list price. Pass specs to check particular roles or provider/modelId models before naming them where a tool takes a model.",
          parameters: Type.Object({
            specs: Type.Optional(
              Type.Array(Type.String({ maxLength: 256 }), {
                maxItems: MAX_SPECS,
              })
            ),
          }),
          replay: "safe",
          execute: async (args, _api, context) =>
            await run(
              answer(
                Option.filter(
                  Option.fromUndefinedOr(args.specs),
                  (specs) => specs.length > 0
                )
              ),
              { signal: context.abortSignal }
            ),
        });

        return RolesTool.of({
          extension: {
            order,
            extension: defineExtension({
              name: ROLES_EXTENSION,
              tools: [tool],
            }),
          },
        });
      })
    );

  /** At the judge key, for tests and judges that install the tool alone. */
  static readonly layerNoDeps = RolesTool.layerAt(ExtensionOrder.judge);
}
