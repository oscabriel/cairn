// Written for Cairn from the intent of `no-silent-error-swallow` in github.com/typeonce-dev/ai-automation,
// rules/oxlint/src/rules/no-silent-error-swallow.ts at 0bca096fe6fe9878cd15303a623dd2cd85915ddd, as adapted
// by github.com/humanlayer/fold, tools/oxlint/automation/rules/no-silent-error-swallow.ts at 4bd8c58. That
// repository has no license, so this file takes the idea only: no text. Cairn covers every `Effect.catch*`
// combinator and resolves the `Effect` name from its import.

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Bans `Effect.catch*` handlers that only return `Effect.void`, which drop the failure unseen. */
export const noSilentErrorSwallowRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect.catch* handlers that only return Effect.void; recover, translate, log or let the failure propagate.",
    },
    messages: {
      silentSwallow:
        "This `Effect.{{method}}` handler only returns `Effect.void`, so the failure disappears unseen. Recover with a real value, translate the error, log it, or let it propagate; if dropping it is the design, use `Effect.ignore` and say why.",
    },
  },
  createOnce(context) {
    // Local names bound to Effect's `Effect` module in the current file.
    const effectNames = new Set<string>();

    /** The member an expression reads from `Effect` (`"void"` for `Effect.void`), else "". */
    const effectMember = (node: ESTree.Node | null) =>
      node?.type === "MemberExpression" &&
      !node.computed &&
      node.object.type === "Identifier" &&
      effectNames.has(node.object.name) &&
      node.property.type === "Identifier"
        ? node.property.name
        : "";

    const isEffectVoid = (node: ESTree.Node | null) =>
      effectMember(node) === "void";

    /** Whether a handler is a function whose only result is `Effect.void`. */
    const onlyReturnsVoid = (node: ESTree.Node) => {
      if (
        node.type !== "ArrowFunctionExpression" &&
        node.type !== "FunctionExpression"
      ) {
        return false;
      }

      // A bodiless signature has a null body; an arrow's may be a bare expression.
      if (node.body === null || node.body.type !== "BlockStatement") {
        return isEffectVoid(node.body);
      }

      const [only, ...rest] = node.body.body;

      return (
        rest.length === 0 &&
        only?.type === "ReturnStatement" &&
        isEffectVoid(only.argument)
      );
    };

    return {
      before() {
        effectNames.clear();
      },
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (
            node.source.value === "effect" &&
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "Effect"
          ) {
            effectNames.add(specifier.local.name);
          }

          if (
            node.source.value === "effect/Effect" &&
            specifier.type !== "ImportSpecifier"
          ) {
            effectNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const method = effectMember(node.callee);

        if (!method.startsWith("catch")) {
          return;
        }

        // A handler is an argument (`catch(f)`, `catchTag("A", f)`) or a value of `catchTags({ A: f })`.
        const handlers = node.arguments.flatMap(
          (argument): ReadonlyArray<ESTree.Node> =>
            argument.type === "ObjectExpression"
              ? argument.properties.flatMap((property) =>
                  property.type === "Property" ? [property.value] : []
                )
              : [argument]
        );

        for (const handler of handlers) {
          if (onlyReturnsVoid(handler)) {
            context.report({
              node: handler,
              messageId: "silentSwallow",
              data: { method },
            });
          }
        }
      },
    };
  },
});
