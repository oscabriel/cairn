// The workflows extension as the installed set takes it: `workflow_plan` for the model, and every
// node tool the prelude calls, callable by tools alone (the model is never offered one), all
// replay-safe, with the gate hook and the watcher task.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ExtensionOrder } from "../brain/Extensions.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { NODE_TOOLS } from "./Prelude.ts";
import { LAUNCH_TOOL } from "./WorkflowLaunch.ts";
import { Workflows } from "./Workflows.ts";
import { WATCH_TASK, WORKFLOWS_EXTENSION } from "./WorkflowTools.ts";

const NoRoles = Layer.succeed(
  RoleAliases,
  RoleAliases.of({
    resolve: () => Effect.die("no role resolves in this test"),
    check: () => Effect.succeed([]),
    rows: () => Effect.succeed([]),
  })
);

describe("the workflows extension", () => {
  it.effect(
    "carries workflow_plan, the prelude's node tools, the gate and the watcher",
    () =>
      Effect.gen(function* () {
        const { extension } = yield* Workflows;

        assert.strictEqual(extension.order, ExtensionOrder.workflows);
        assert.strictEqual(extension.extension.name, WORKFLOWS_EXTENSION);

        const tools = extension.extension.tools ?? [];

        assert.deepStrictEqual(
          tools.map((tool) => tool.name).toSorted(),
          [...NODE_TOOLS, LAUNCH_TOOL].toSorted()
        );

        for (const tool of tools) {
          assert.deepStrictEqual(
            tool.callers,
            tool.name === LAUNCH_TOOL ? ["model"] : ["tools"],
            tool.name
          );
          assert.strictEqual(tool.replay, "safe", tool.name);
        }

        assert.strictEqual(extension.extension.hooks?.length, 1);
        assert.deepStrictEqual(
          extension.extension.tasks?.map((task) => task.definition.name),
          [WATCH_TASK]
        );
      }).pipe(Effect.provide(Workflows.layer.pipe(Layer.provide(NoRoles))))
  );
});
