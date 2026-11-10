// Cairn's own rule, with no upstream (glossary: Test slack): a test's own Vitest limit scales with
// the machine's load, so a busy machine never fails a test because it waited too little.

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Vitest's functions that take a limit: tests, suites and hooks, and their modifiers. */
const VITEST: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "bench",
  "describe",
  "it",
  "suite",
  "test",
]);

/** The name a callee chain starts from: `it` for `it.live`, `it.each(rows)` and `it.skip.each`. */
const rootName = (node: ESTree.Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "MemberExpression") {
    return rootName(node.object);
  }

  return node.type === "CallExpression" ? rootName(node.callee) : undefined;
};

/** Whether `node` is a number written out: `30_000`, or `-1`. */
const isNumberLiteral = (node: ESTree.Node | undefined): boolean =>
  (node?.type === "Literal" && Number.isFinite(node.value)) ||
  (node?.type === "UnaryExpression" && isNumberLiteral(node.argument));

/** The `timeout` of an options object (`{ timeout: 30_000 }`) when it is a number written out. */
const rawTimeoutOf = (
  node: ESTree.Node | undefined
): ESTree.Node | undefined => {
  if (node?.type !== "ObjectExpression") {
    return undefined;
  }

  return node.properties.find(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" &&
        property.key.name === "timeout") ||
        (property.key.type === "Literal" &&
          property.key.value === "timeout")) &&
      isNumberLiteral(property.value)
  );
};

/**
 * Bans a number written out as a Vitest limit in a test file: the last argument of `it`, `test`,
 * `describe`, a hook or one of their modifiers (`it.live(name, body, 30_000)`), or the `timeout` of
 * an options object passed to one. Such a limit holds on a quiet machine and fails on a busy one;
 * `testLimit(30_000)` (`apps/server/src/EventuallyTestKit.ts`) scales it by the test slack.
 * `oxlint.config.ts` applies it to the tests of the server, the judges' library and the tools.
 */
export const noRawTestLimitRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a number written out as a Vitest test, suite or hook limit; scale it by the test slack with testLimit().",
    },
    messages: {
      rawLimit:
        "A limit written out as a number holds on a quiet machine and fails on a busy one. Scale it by the test slack: `testLimit({{limit}})` from `apps/server/src/EventuallyTestKit.ts` (glossary: Test slack).",
    },
  },
  createOnce(context) {
    const report = (node: ESTree.Node) => {
      context.report({
        node,
        messageId: "rawLimit",
        data: { limit: context.sourceCode.getText(node) },
      });
    };

    return {
      CallExpression(node) {
        const name = rootName(node.callee);

        if (name === undefined || !VITEST.has(name)) {
          return;
        }

        const last = node.arguments.at(-1);

        if (node.arguments.length >= 2 && isNumberLiteral(last)) {
          report(last ?? node);
        }

        for (const argument of node.arguments) {
          const timeout = rawTimeoutOf(argument);

          if (timeout?.type === "Property") {
            report(timeout.value);
          }
        }
      },
    };
  },
});
