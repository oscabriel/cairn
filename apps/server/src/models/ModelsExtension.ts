// Ported in intent from github.com/pingdotgg/t3code, apps/server/src/mcp/OrchestratorMcpService.ts
// (`orchestrator_capabilities` and `listCapabilityModels`) and packages/contracts/src/orchestratorMcp.ts
// at 3c59595a6449d8b04524ed7cb2b5dc04f17bae31. Kept: the caller learns its own model and options,
// then per provider the models a child may be started on, short by default (the caller's own model
// always listed) with a search for the rest, and the instruction to change the model only when the
// user asks. Changed: one plain-text answer from a pi-durable tool, models are pi's catalog with
// Cairn's readiness (credential, health, plan windows), and options are thinking levels and list
// prices (ADR 0043).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// The `models` tool: a read-only answer to "what can a child run on". It names the caller's own
// model and level, which a child that names no model runs on, then per provider the models offered
// with a usable credential, their thinking levels and list prices; a provider that is failing or
// limited says so. Tools that take a model describe the spec's form only, so their declarations
// stay in the cached prompt; this tool is where a model looks up what it may name.
//
// It reads the world at the call and writes nothing, so it is `replay: "safe"`: a rerun after a
// restart answers from the catalog as it is then. It runs `ModelSpecs` through one runtime made
// from the layer's scope (S43).

import type { ThinkingLevel } from "@cairn/protocol/Models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option } from "effect";
import { Type } from "typebox";

import type { CairnExtension } from "../brain/Extensions.ts";
import { ModelSpecs, modelsText } from "./ModelSpecs.ts";
import type { ModelsCaller } from "./ModelSpecs.ts";

/** The extension's name in pi-durable's registry. */
export const MODELS_EXTENSION = "cairn.models";

/** The tool's name. */
export const MODELS_TOOL = "models";

/** The longest search a call may pass. */
const MAX_SEARCH = 200;

/** The `models` tool as a Cairn extension, over the brain's `ModelSpecs`. */
export class ModelsTool extends Context.Service<
  ModelsTool,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/models/ModelsExtension/ModelsTool") {
  /** Over `ModelSpecs`. Installs at `order`; production passes `ExtensionOrder.models`. */
  static readonly layerAt = (order: number) =>
    Layer.effect(
      ModelsTool,
      Effect.gen(function* () {
        const specs = yield* ModelSpecs;
        const run = yield* FiberSet.makeRuntimePromise();

        const answer = Effect.fn("ModelsTool.answer")(
          function* (caller: ModelsCaller, search: Option.Option<string>) {
            const listing = yield* specs.list(caller, search);

            return {
              output: [{ type: "text" as const, text: modelsText(listing) }],
            };
          },
          Effect.catchTag("ModelSpecsUnavailable", (failure) =>
            Effect.succeed({
              output: [
                {
                  type: "text" as const,
                  text: `The model catalog could not be read: ${failure.message}`,
                },
              ],
              isError: true,
            })
          )
        );

        const tool = defineTool({
          name: MODELS_TOOL,
          description:
            "Lists the model you run on and, per provider, the models a child (a subagent, a workflow node, a goal's model judge) can run on now, with their thinking levels and list prices. Short by default; pass search (words of a provider, model id or name) for the rest. A child that names no model runs on yours; name another only when the user asks for it.",
          parameters: Type.Object({
            search: Type.Optional(
              Type.String({
                maxLength: MAX_SEARCH,
                description:
                  "Words to match provider ids, model ids and names; replaces the short list.",
              })
            ),
          }),
          replay: "safe",
          execute: async (args, api, context) => {
            const agent = await api.agent(context);

            const caller: ModelsCaller = {
              model: Option.map(
                Option.fromUndefinedOr(agent.model),
                (model) => ({
                  provider: model.provider,
                  modelId: model.modelId,
                })
              ),
              thinkingLevel: Option.fromUndefinedOr<ThinkingLevel>(
                agent.thinkingLevel
              ),
            };

            const search = Option.filter(
              Option.map(Option.fromUndefinedOr(args.search), (text) =>
                text.trim()
              ),
              (text) => text !== ""
            );

            return await run(answer(caller, search), {
              signal: context.abortSignal,
            });
          },
        });

        return ModelsTool.of({
          extension: {
            order,
            extension: defineExtension({
              name: MODELS_EXTENSION,
              tools: [tool],
            }),
          },
        });
      })
    );
}
