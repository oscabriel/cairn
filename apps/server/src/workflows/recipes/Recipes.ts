// Saved recipes (workflows note W7; glossary: recipe): the workflow scripts a thread can launch
// without writing one, listed by `workflow.list` and beside the model's own workflows. Two sources:
//
// - Built-in (`BuiltInRecipes.ts`): ship with Cairn, launched by name with a recipe reference.
// - A project's own, `<project root>/.cairn/workflows/<file>.js`: listed for the project's threads,
//   with its file's path relative to the root (`RecipeSummary.path`), since a file's name need not
//   match its `meta.name`. It launches by name too (6F): `workflow_plan` finds a reference's
//   recipe under the thread's folder (`source`) and keeps the source it proposed beside the ledger
//   (`WorkflowSourcesDoc`), since the gate cannot read files (a hook must not wait on anything but
//   documents); the gate runs the source the user approved from there.
//
// Each listed recipe is parsed (`parseWorkflowScript`, nothing runs) for its `meta`. A project file
// that does not parse, or that takes a built-in's name, is left out and logged, so one bad file never
// hides the rest.

import path from "node:path";

import { DisplayText } from "@cairn/protocol/Ids";
import type { RecipeList, RecipeSummary } from "@cairn/protocol/Workflows";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";

import { parseWorkflowScript } from "../WorkflowScript.ts";
import type { WorkflowMeta } from "../WorkflowScript.ts";
import { BUILT_IN_RECIPES } from "./BuiltInRecipes.ts";

/** Where a project keeps its recipes, under its root. */
export const PROJECT_RECIPES_DIR = ".cairn/workflows";

/** The file extension of a project recipe. */
export const PROJECT_RECIPE_EXTENSION = ".js";

/** The most project recipe files one listing reads. */
export const MAX_PROJECT_RECIPES = 100;

/** The largest project recipe file one listing reads. */
const MAX_RECIPE_BYTES = 256 * 1024;

const isDisplayText = Schema.is(DisplayText);

/** A recipe's summary, from its parsed `meta`. */
const summaryOf = (
  meta: WorkflowMeta,
  source: RecipeSummary["source"],
  file: Option.Option<string>
): RecipeSummary => ({
  name: meta.name,
  description: meta.description,
  whenToUse: Option.filter(meta.whenToUse, isDisplayText),
  source,
  path: file,
  phases: meta.phases.map((phase) => ({
    title: phase.title,
    detail: Option.fromNullOr(phase.detail),
  })),
});

/** The built-in recipes' summaries, parsed once. */
const builtInSummaries = Effect.forEach(
  [...BUILT_IN_RECIPES.values()],
  (source) =>
    Effect.map(parseWorkflowScript(source), (script) =>
      summaryOf(script.meta, "built-in", Option.none())
    )
);

/** Lists the recipes a thread can launch. */
export class Recipes extends Context.Service<
  Recipes,
  {
    /** The built-in recipes, then the project's at `root` when one is given, each in name order. */
    list(root: Option.Option<string>): Effect.Effect<RecipeList>;
    /**
     * The source of the project recipe `listed` under `root` as `name` (a built-in's name is never
     * a project's); none when the project lists none by that name or its file cannot be read.
     */
    source(root: string, name: string): Effect.Effect<Option.Option<string>>;
  }
>()("cairn/server/workflows/recipes/Recipes") {
  /** The service, over the platform's `FileSystem`. */
  static readonly make = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // A built-in recipe that does not parse is a defect of this build: the recipe tests fail first.
    const builtIn = yield* Effect.orDie(builtInSummaries);
    const builtInNames = new Set(builtIn.map((recipe) => recipe.name));

    /** One project file's summary, or none with a log line saying why it was left out. */
    const projectRecipe = Effect.fnUntraced(function* (
      file: string,
      relative: string
    ) {
      const info = yield* fs.stat(file);

      if (info.type !== "File" || Number(info.size) > MAX_RECIPE_BYTES) {
        yield* Effect.logWarning("project recipe left out").pipe(
          Effect.annotateLogs({
            event: "recipe_left_out",
            file,
            why: "not a file, or larger than 256 KiB",
          })
        );

        return Option.none<RecipeSummary>();
      }

      const parsed = yield* parseWorkflowScript(
        yield* fs.readFileString(file)
      ).pipe(Effect.option);

      const summary = Option.map(parsed, (script) =>
        summaryOf(script.meta, "project", Option.some(relative))
      );

      if (Option.isNone(summary)) {
        yield* Effect.logWarning("project recipe left out").pipe(
          Effect.annotateLogs({
            event: "recipe_left_out",
            file,
            why: "not a workflow script",
          })
        );
      } else if (builtInNames.has(summary.value.name)) {
        yield* Effect.logWarning("project recipe left out").pipe(
          Effect.annotateLogs({
            event: "recipe_left_out",
            file,
            why: `takes the built-in recipe name ${summary.value.name}`,
          })
        );

        return Option.none<RecipeSummary>();
      }

      return summary;
    });

    /** The recipes under a project root, in name order; none when it has no recipe folder. */
    const projectRecipes = Effect.fn("Recipes.projectRecipes")(function* (
      root: string
    ) {
      const dir = path.join(root, PROJECT_RECIPES_DIR);

      const names = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      const files = names
        .filter((name) => name.endsWith(PROJECT_RECIPE_EXTENSION))
        .toSorted()
        .slice(0, MAX_PROJECT_RECIPES);

      const found = yield* Effect.forEach(files, (name) =>
        projectRecipe(
          path.join(dir, name),
          path.posix.join(PROJECT_RECIPES_DIR, name)
        ).pipe(
          Effect.catchTag("PlatformError", (failure) =>
            Effect.as(
              Effect.logWarning("project recipe left out").pipe(
                Effect.annotateLogs({
                  event: "recipe_left_out",
                  file: name,
                  why: failure.message,
                })
              ),
              Option.none<RecipeSummary>()
            )
          )
        )
      );

      const seen = new Set<string>();

      // Two files with one `meta.name`: the first in file order is listed.
      return found
        .flatMap((summary) => Option.toArray(summary))
        .filter((summary) => {
          const fresh = !seen.has(summary.name);

          seen.add(summary.name);

          return fresh;
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));
    });

    const list = Effect.fn("Recipes.list")(function* (
      root: Option.Option<string>
    ) {
      const project = Option.isSome(root)
        ? yield* projectRecipes(root.value)
        : [];

      return {
        recipes: [
          ...builtIn.toSorted((a, b) => a.name.localeCompare(b.name)),
          ...project,
        ],
      } satisfies RecipeList;
    });

    const source = Effect.fn("Recipes.source")(function* (
      root: string,
      name: string
    ) {
      const listed = (yield* projectRecipes(root)).find(
        (recipe) => recipe.name === name
      );

      const file = Option.flatMap(
        Option.fromUndefinedOr(listed),
        (recipe) => recipe.path
      );

      if (Option.isNone(file)) {
        return Option.none<string>();
      }

      return yield* fs
        .readFileString(path.join(root, file.value))
        .pipe(Effect.option);
    });

    return Recipes.of({ list, source });
  });

  /** Over the platform's `FileSystem`. */
  static readonly layer = Layer.effect(Recipes, Recipes.make);
}
