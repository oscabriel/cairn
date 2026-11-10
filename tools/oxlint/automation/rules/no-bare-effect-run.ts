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

const importedName = (specifier: ESTree.ImportSpecifier) =>
  specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;

/**
 * Bans `Effect.runPromise` and its bare siblings: they run on Effect's default services, so a line
 * logged inside leaves the events log and a span has no tracer. Entry points, fixtures and tests
 * are left out by `oxlint.config.ts`.
 */
export const noBareEffectRunRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect.runPromise, runFork, runSync and their Exit and callback forms outside entry points; run through the layer's context instead.",
    },
    messages: {
      bareRun:
        "`Effect.{{method}}` runs on Effect's defaults, so its lines leave the events log and its spans the app's tracer. In code pi-durable calls back, run it through the extension layer's `DurableRunner` (`durableRunner`, brain/Durable.ts); elsewhere through the layer's context (`Effect.{{method}}With`) (coding standard S43).",
    },
  },
  createOnce(context) {
    // Local names bound to Effect's `Effect` module, and bare runs imported by name.
    const effectNames = new Set<string>();
    const runNames = new Map<string, string>();

    return {
      before() {
        effectNames.clear();
        runNames.clear();
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (
            node.source.value === "effect" &&
            specifier.type === "ImportSpecifier" &&
            importedName(specifier) === "Effect"
          ) {
            effectNames.add(specifier.local.name);
          }

          if (node.source.value !== "effect/Effect") {
            continue;
          }

          if (specifier.type !== "ImportSpecifier") {
            effectNames.add(specifier.local.name);
          } else if (BARE_RUNS.has(importedName(specifier))) {
            runNames.set(specifier.local.name, importedName(specifier));
          }
        }
      },
      CallExpression(node) {
        const { callee } = node;

        if (callee.type === "Identifier") {
          const method = runNames.get(callee.name);

          if (method !== undefined) {
            context.report({ node, messageId: "bareRun", data: { method } });
          }

          return;
        }

        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          effectNames.has(callee.object.name) &&
          callee.property.type === "Identifier" &&
          BARE_RUNS.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: "bareRun",
            data: { method: callee.property.name },
          });
        }
      },
    };
  },
});
