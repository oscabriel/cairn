// Written for Cairn from the intent of `no-ambient-nondeterminism` in github.com/typeonce-dev/ai-automation,
// rules/oxlint/src/rules/no-ambient-nondeterminism.ts at 0bca096fe6fe9878cd15303a623dd2cd85915ddd, as adapted
// by github.com/humanlayer/fold, tools/oxlint/automation/rules/no-ambient-nondeterminism.ts at 4bd8c58. That
// repository has no license, so this file takes the idea only: no text. Cairn adds the random helpers
// imported from `node:crypto`, which are as ambient as the `crypto` global, and lets `crypto.subtle`
// through: signing and key agreement have no Effect service to move to.

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** The `node:crypto` exports that draw random values. */
const RANDOM_EXPORTS: ReadonlySet<string> = new Set([
  "getRandomValues",
  "randomBytes",
  "randomFill",
  "randomFillSync",
  "randomInt",
  "randomUUID",
  "webcrypto",
]);

const CRYPTO_MODULES: ReadonlySet<string> = new Set(["crypto", "node:crypto"]);

/** The name a member expression reads when it is written out (`a.b`, `a["b"]`), else "". */
const memberName = (node: ESTree.MemberExpression) => {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }

  if (node.property.type === "Literal") {
    return String(node.property.value);
  }

  return "";
};

const importedName = (specifier: ESTree.ImportSpecifier) =>
  specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;

/** The member expression `node` is the object of, if any. */
const memberOf = (node: ESTree.Node) =>
  node.parent?.type === "MemberExpression" && node.parent.object === node
    ? node.parent
    : null;

/** Whether `node` (the `crypto` global) is only read for its `subtle` member. */
const readsOnlySubtle = (node: ESTree.Node) => {
  const member = memberOf(node);

  if (member !== null) {
    return memberName(member) === "subtle";
  }

  // `const { subtle } = crypto`
  const { parent } = node;

  return (
    parent?.type === "VariableDeclarator" &&
    parent.init === node &&
    parent.id.type === "ObjectPattern" &&
    parent.id.properties.every(
      (property) =>
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        property.key.name === "subtle"
    )
  );
};

/** Bans reading the wall clock, `Math.random` and the platform's random sources outside Effect. */
export const noAmbientNondeterminismRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ambient time and randomness; read them through Effect's Clock, DateTime and Random so tests control them.",
    },
    messages: {
      ambientDate:
        "Read the time through Effect's `Clock` or `DateTime`, not the global `Date`, so `TestClock` controls it (coding standard S8).",
      ambientMathRandom:
        "Draw random numbers from Effect's `Random`, not `Math.random`, so a test can seed them with `Random.withSeed`.",
      ambientCrypto:
        "Draw random values from Effect's `Random` (or a `Crypto` service for secrets), not the ambient `crypto`, so a test can control them.",
      cryptoImport:
        "`{{name}}` from `node:crypto` is ambient randomness. Draw it from Effect's `Random` (or a `Crypto` service for secrets) so a test can control it.",
    },
  },
  createOnce(context) {
    /** Reports `node` if it uses the global called `name` nondeterministically. */
    const inspect = (node: ESTree.Node, name: string) => {
      const member = memberOf(node);
      const { parent } = node;

      if (name === "crypto") {
        if (!readsOnlySubtle(node)) {
          context.report({ node, messageId: "ambientCrypto" });
        }
      } else if (name === "globalThis" && member !== null) {
        inspect(member, memberName(member));
      } else if (name === "Math" && member !== null) {
        if (memberName(member) === "random") {
          context.report({ node: member, messageId: "ambientMathRandom" });
        }
      } else if (name === "Date") {
        // `Date()` returns the current time whatever its arguments; `new Date(value)` is
        // deterministic, so only the bare `new Date()` reads the clock.
        const reads =
          (member !== null && memberName(member) === "now") ||
          (parent?.type === "CallExpression" && parent.callee === node) ||
          (parent?.type === "NewExpression" &&
            parent.callee === node &&
            parent.arguments.length === 0);

        if (reads) {
          context.report({ node: parent ?? node, messageId: "ambientDate" });
        }
      }
    };

    return {
      // Scope analysis decides what is ambient: a reference no declaration in the file resolves is
      // a global, so `const crypto = yield* Crypto.Crypto` passes and a bare `crypto` does not.
      Program() {
        const { globalScope } = context.sourceCode.scopeManager;

        if (globalScope === null) {
          return;
        }

        const ambient = [
          ...globalScope.through,
          ...globalScope.variables.flatMap((variable) =>
            variable.defs.length === 0 ? variable.references : []
          ),
        ];

        for (const reference of ambient) {
          inspect(reference.identifier, reference.identifier.name);
        }
      },
      ImportDeclaration(node) {
        if (!CRYPTO_MODULES.has(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const name = importedName(specifier);

            if (RANDOM_EXPORTS.has(name)) {
              context.report({
                node: specifier,
                messageId: "cryptoImport",
                data: { name },
              });
            }
          } else {
            // The whole module under a local name: report its random members where they are read.
            for (const variable of context.sourceCode.getDeclaredVariables(
              specifier
            )) {
              for (const reference of variable.references) {
                const member = memberOf(reference.identifier);
                const name = member === null ? "" : memberName(member);

                if (member !== null && RANDOM_EXPORTS.has(name)) {
                  context.report({
                    node: member,
                    messageId: "cryptoImport",
                    data: { name },
                  });
                }
              }
            }
          }
        }
      },
    };
  },
});
