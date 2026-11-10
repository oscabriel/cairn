// Cairn's own rule, with no upstream (coding standard S43): code that a plain-JS framework calls
// back into runs its Effects on the app's context, never on Effect's defaults.

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** The `Effect.run*` entry points that run on an empty context. Their `*With` forms take one. */
const BARE_RUNS: ReadonlySet<string> = new Set([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
]);

/** The forms that take a context: an empty one makes each the bare run under another name. */
const CONTEXT_RUNS: ReadonlySet<string> = new Set(
  [...BARE_RUNS].map((name) => `${name}With`)
);

/** Cairn's runner over a context (`brain/Durable.ts`), which an empty context makes bare too. */
const RUNNER_OF = "runnerOf";

const importedName = (specifier: ESTree.ImportSpecifier) =>
  specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;

/** The name of a non-computed member's property; none for a computed one. */
const propertyOf = (node: ESTree.MemberExpression) =>
  !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : undefined;

/**
 * Bans `Effect.runPromise` and its bare siblings, called or passed on (`.then(Effect.runFork)`):
 * they run on Effect's default services, so a line logged inside leaves the events log and a span
 * has no tracer. A context form given `Context.empty()` (`Effect.runPromiseWith(Context.empty())`,
 * `runnerOf(Context.empty())`) is the same run under another name and is banned too. Entry points,
 * fixtures and tests are left out by `oxlint.config.ts`.
 */
export const noBareEffectRunRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect.runPromise, runFork, runSync and their Exit and callback forms, and their context forms over an empty context, outside entry points; run through the layer's context instead.",
    },
    messages: {
      bareRun:
        "`Effect.{{method}}` runs on Effect's defaults, so its lines leave the events log and its spans the app's tracer. In code pi-durable calls back, run it through the extension layer's `DurableRunner` (`durableRunner`, brain/Durable.ts); elsewhere through the layer's context (`Effect.{{method}}With`) (coding standard S43).",
      emptyContext:
        "`{{method}}(Context.empty())` runs on Effect's defaults, as a bare run does, so its lines leave the events log and its spans the app's tracer. Pass the layer's context (`durableRunner`, or `Effect.context()`) (coding standard S43).",
    },
  },
  createOnce(context) {
    // Local names bound to Effect's `Effect` module, to the `effect` barrel as a namespace, to
    // `Context`, bare runs imported by name, and context forms imported by name.
    const effectNames = new Set<string>();
    const barrelNames = new Set<string>();
    const contextNames = new Set<string>();
    const runNames = new Map<string, string>();
    const withNames = new Map<string, string>();

    /** Whether `node` names Effect's `Effect` module: `Effect`, or `<barrel>.Effect`. */
    const isEffectModule = (node: ESTree.Expression) =>
      node.type === "Identifier"
        ? effectNames.has(node.name)
        : node.type === "MemberExpression" &&
          node.object.type === "Identifier" &&
          barrelNames.has(node.object.name) &&
          propertyOf(node) === "Effect";

    /** Whether `node` is `Context.empty()`, through a named import or the barrel's namespace. */
    const isEmptyContext = (node: ESTree.Node | undefined) => {
      if (node?.type !== "CallExpression" || node.arguments.length > 0) {
        return false;
      }

      const { callee } = node;

      if (
        callee.type !== "MemberExpression" ||
        propertyOf(callee) !== "empty"
      ) {
        return false;
      }

      const owner = callee.object;

      return owner.type === "Identifier"
        ? contextNames.has(owner.name)
        : owner.type === "MemberExpression" &&
            owner.object.type === "Identifier" &&
            barrelNames.has(owner.object.name) &&
            propertyOf(owner) === "Context";
    };

    /** The context form or runner a call's callee names; none for any other call. */
    const contextRunOf = (callee: ESTree.Node): string | null => {
      if (callee.type === "Identifier") {
        return callee.name === RUNNER_OF
          ? RUNNER_OF
          : (withNames.get(callee.name) ?? null);
      }

      if (callee.type !== "MemberExpression") {
        return null;
      }

      const method = propertyOf(callee);

      return method !== undefined &&
        CONTEXT_RUNS.has(method) &&
        isEffectModule(callee.object)
        ? `Effect.${method}`
        : null;
    };

    return {
      before() {
        effectNames.clear();
        barrelNames.clear();
        contextNames.clear();
        runNames.clear();
        withNames.clear();
      },
      ImportDeclaration(node) {
        const source = node.source.value;

        for (const specifier of node.specifiers) {
          if (source === "effect") {
            if (specifier.type === "ImportNamespaceSpecifier") {
              barrelNames.add(specifier.local.name);
            } else if (specifier.type === "ImportSpecifier") {
              const name = importedName(specifier);

              if (name === "Effect") {
                effectNames.add(specifier.local.name);
              } else if (name === "Context") {
                contextNames.add(specifier.local.name);
              }
            }

            continue;
          }

          if (source === "effect/Context") {
            if (specifier.type !== "ImportSpecifier") {
              contextNames.add(specifier.local.name);
            }

            continue;
          }

          if (source !== "effect/Effect") {
            continue;
          }

          if (specifier.type !== "ImportSpecifier") {
            effectNames.add(specifier.local.name);
          } else if (BARE_RUNS.has(importedName(specifier))) {
            runNames.set(specifier.local.name, importedName(specifier));
          } else if (CONTEXT_RUNS.has(importedName(specifier))) {
            withNames.set(specifier.local.name, importedName(specifier));
          }
        }
      },
      // `Effect.runPromise`, called or not: a reference handed on runs bare where it is called.
      MemberExpression(node) {
        const method = propertyOf(node);

        if (
          method !== undefined &&
          BARE_RUNS.has(method) &&
          isEffectModule(node.object)
        ) {
          context.report({ node, messageId: "bareRun", data: { method } });
        }
      },
      // A bare run imported by name, wherever it is used.
      Identifier(node) {
        const method = runNames.get(node.name);

        if (
          method !== undefined &&
          node.parent.type !== "ImportSpecifier" &&
          !(
            node.parent.type === "MemberExpression" &&
            node.parent.property === node
          )
        ) {
          context.report({ node, messageId: "bareRun", data: { method } });
        }
      },
      CallExpression(node) {
        const method = contextRunOf(node.callee);

        if (method !== null && isEmptyContext(node.arguments[0])) {
          context.report({ node, messageId: "emptyContext", data: { method } });
        }
      },
    };
  },
});
