// Saved recipes: the built-in council parses and is named by its key, a recipe reference is read
// only in its one-statement form, and a project's `.cairn/workflows/*.js` files are listed after
// the built-ins, in name order, leaving out a file that does not parse, one that takes a built-in's
// name, a second file with a listed name and files of another extension. `workflow.list` lists them
// for a project and refuses an unknown one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { NodeServices } from "@effect/platform-node";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { workflowHandlers } from "../../rpc/WorkflowHandlers.ts";
import { EventSink } from "../../shell/EventSink.ts";
import { projectIdFor } from "../../shell/ShellCommands.ts";
import {
  ShellTestLayer,
  testCommandId,
  unknownProjectId,
} from "../../shell/ShellTestKit.ts";
import { parseWorkflowScript } from "../WorkflowScript.ts";
import {
  BUILT_IN_RECIPES,
  recipeReference,
  recipeReferenceOf,
} from "./BuiltInRecipes.ts";
import { PROJECT_RECIPES_DIR, Recipes } from "./Recipes.ts";

let root = "";

const recipeLayer = Recipes.layer.pipe(Layer.provide(NodeServices.layer));

const script = (name: string, description = "A project recipe") =>
  `export const meta = {\n  name: "${name}",\n  description: "${description}",\n  phases: [{ title: "Only" }],\n};\nphase("Only");\nreturn await agent("go");\n`;

const writeRecipe = (file: string, text: string) => {
  writeFileSync(path.join(root, PROJECT_RECIPES_DIR, file), text);
};

describe("built-in recipes", () => {
  it.effect("each parses, and its meta name is its key", () =>
    Effect.gen(function* () {
      assert.isAbove(BUILT_IN_RECIPES.size, 0);

      for (const [name, source] of BUILT_IN_RECIPES) {
        const parsed = yield* parseWorkflowScript(source);

        assert.strictEqual(parsed.meta.name, name);
        assert.deepStrictEqual(
          recipeReferenceOf(recipeReference(name)),
          Option.some(name)
        );
      }
    })
  );

  it("reads a reference only as one meta statement naming a recipe", () => {
    assert.deepStrictEqual(
      recipeReferenceOf(`  export const meta = { name: 'council', };\n`),
      Option.some("council")
    );
    assert.deepStrictEqual(
      recipeReferenceOf(`export const meta = { name: "council" }; agent("x");`),
      Option.none()
    );
    assert.deepStrictEqual(
      recipeReferenceOf(
        `export const meta = { name: "council", description: "mine" };`
      ),
      Option.none()
    );
    assert.deepStrictEqual(
      recipeReferenceOf(`export const meta = { name: "Council" };`),
      Option.none()
    );
  });
});

describe("listing recipes", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cairn-recipes-"));
    mkdirSync(path.join(root, PROJECT_RECIPES_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.effect("lists the built-ins alone without a project", () =>
    Effect.gen(function* () {
      const recipes = yield* Recipes;
      const list = yield* recipes.list(Option.none());

      assert.deepStrictEqual(
        list.recipes.map((recipe) => [recipe.name, recipe.source]),
        [["council", "built-in"]]
      );

      const [council] = list.recipes;

      assert.deepStrictEqual(
        council?.phases.map((phase) => phase.title),
        ["Reports", "Matrix", "Cross-examination"]
      );
      assert.isTrue(Option.isSome(council?.whenToUse ?? Option.none()));
    }).pipe(Effect.provide(recipeLayer))
  );

  it.effect(
    "adds a project's recipes in name order and leaves out the ones that cannot be listed",
    () =>
      Effect.gen(function* () {
        writeRecipe("zeta.js", script("zeta"));
        writeRecipe("alpha.js", script("alpha"));
        writeRecipe("broken.js", "const meta = 1;\n");
        writeRecipe("mine.js", script("council", "Shadows the built-in"));
        writeRecipe("again.js", script("zeta", "A second zeta"));
        writeRecipe("notes.md", script("notes"));

        const recipes = yield* Recipes;
        const list = yield* recipes.list(Option.some(root));

        assert.deepStrictEqual(
          list.recipes.map((recipe) => [
            recipe.name,
            recipe.source,
            recipe.description,
            Option.getOrNull(recipe.path),
          ]),
          [
            ["council", "built-in", list.recipes[0]?.description ?? "", null],
            [
              "alpha",
              "project",
              "A project recipe",
              ".cairn/workflows/alpha.js",
            ],
            // The file's name need not match `meta.name`: the path is how the model finds it.
            ["zeta", "project", "A second zeta", ".cairn/workflows/again.js"],
          ]
        );
      }).pipe(Effect.provide(recipeLayer))
  );

  it.effect(
    "lists only the built-ins for a project with no recipe folder",
    () =>
      Effect.gen(function* () {
        rmSync(path.join(root, ".cairn"), { recursive: true, force: true });

        const recipes = yield* Recipes;
        const list = yield* recipes.list(Option.some(root));

        assert.deepStrictEqual(
          list.recipes.map((recipe) => recipe.name),
          ["council"]
        );
      }).pipe(Effect.provide(recipeLayer))
  );
});

describe("workflow.list", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cairn-recipes-"));
    mkdirSync(path.join(root, PROJECT_RECIPES_DIR), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const handlersLayer = Layer.mergeAll(recipeLayer, ShellTestLayer);

  const addProject = Effect.gen(function* () {
    const sink = yield* EventSink;
    const commandId = testCommandId(1);

    yield* sink.commitCommand(
      ProjectCreate.make({
        commandId,
        workspaceRoot: root,
        title: Option.none(),
      })
    );

    return projectIdFor(commandId);
  });

  it.effect("lists a project's recipes after the built-ins", () =>
    Effect.gen(function* () {
      writeRecipe("review.js", script("review"));

      const projectId = yield* addProject;
      const handlers = yield* workflowHandlers;

      const list = yield* handlers.list(Option.some(projectId), Option.none());

      assert.deepStrictEqual(
        list.recipes.map((recipe) => [recipe.name, recipe.source]),
        [
          ["council", "built-in"],
          ["review", "project"],
        ]
      );
    }).pipe(Effect.provide(handlersLayer))
  );

  it.effect("refuses an unknown project", () =>
    Effect.gen(function* () {
      const handlers = yield* workflowHandlers;

      const error = yield* handlers
        .list(Option.some(unknownProjectId), Option.some("r1"))
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "NotFound");
    }).pipe(Effect.provide(handlersLayer))
  );
});
