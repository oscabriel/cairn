// The built-in recipes (workflows note W7, "The council recipe"): workflow scripts that ship with
// Cairn, named by their `meta.name` (glossary: recipe), and how a script names one to run it.
//
// A recipe is launched by name with a recipe reference, a script whose only statement is
// `export const meta = { name: "council" };`. The model proposes it to `workflow_plan` with its
// arguments and runs the same line with `codemode` after Go; `resolveRecipe` (WorkflowScript.ts)
// puts the recipe's source in its place before the dry run and the gate, so the plan, the approved
// hash and the run are the recipe's own script. A recipe changed by a Cairn upgrade has a new hash,
// so a launch approved before the upgrade is refused and proposed again.
//
// The sources are files beside this module, read once when it loads. They are `.workflow` files
// because a workflow script is the body of an async function (top-level `return` and `await`),
// which oxlint and oxfmt cannot parse as JavaScript.

import { readFileSync } from "node:fs";

import { Option } from "effect";

/** Reads a recipe file beside this module. */
const recipeFile = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), "utf-8");

/** Every built-in recipe's source, by name. */
export const BUILT_IN_RECIPES: ReadonlyMap<string, string> = new Map([
  ["council", recipeFile("council.workflow")],
]);

/** A recipe reference: one `meta` statement naming a recipe and nothing else. */
const REFERENCE =
  /^export\s+const\s+meta\s*=\s*\{\s*name\s*:\s*(?<quote>["'])(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)\k<quote>\s*,?\s*\}\s*;?$/u;

/** The recipe `source` names when it is a recipe reference; none for any other script. */
export const recipeReferenceOf = (source: string): Option.Option<string> =>
  Option.fromUndefinedOr(REFERENCE.exec(source.trim())?.groups?.name);

/** The reference that launches the recipe `name`. */
export const recipeReference = (name: string): string =>
  `export const meta = { name: "${name}" };`;
