// Cairn's own rule, with no upstream (glossary: Test slack): a test's own Vitest limit scales with
// the machine's load, so a busy machine never fails a test because it waited too little.

import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";

/** Vitest's suites and tests: their limit is the third argument, `it(name, body, limit)`. */
const TESTS: ReadonlySet<string> = new Set([
  "bench",
  "describe",
  "it",
  "suite",
  "test",
]);

/** Vitest's hooks: their limit is the second argument, `beforeAll(body, limit)`. */
const HOOKS: ReadonlySet<string> = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
]);

/** Where a Vitest function takes its limit: the third argument of a test, the second of a hook. */
const positionOf = (name: string): number | undefined => {
  if (TESTS.has(name)) {
    return 2;
  }

  return HOOKS.has(name) ? 1 : undefined;
};

/** The function that scales a limit by the test slack (`apps/server/src/EventuallyTestKit.ts`). */
const SCALER = "testLimit";

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

/** `node` without the type assertions around it: `x as number` and `x!` are `x`. */
const unwrap = (node: ESTree.Node): ESTree.Node =>
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSTypeAssertion"
    ? unwrap(node.expression)
    : node;

const isFunction = (node: ESTree.Node): boolean =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration";

/** What a name stands for when this file says: a `const` declared with a value, or a function. */
const constantOf = (
  sourceCode: SourceCode,
  identifier: ESTree.Node,
  name: string
): ESTree.Node | undefined => {
  let scope: Scope | null = sourceCode.getScope(identifier);

  while (scope !== null) {
    const variable = scope.set.get(name);

    if (variable !== undefined) {
      const [definition] = variable.defs;

      if (variable.defs.length === 1 && definition?.type === "FunctionName") {
        return definition.node;
      }

      return variable.defs.length === 1 &&
        definition?.type === "Variable" &&
        definition.parent?.type === "VariableDeclaration" &&
        definition.parent.kind === "const" &&
        definition.node.type === "VariableDeclarator" &&
        definition.node.init !== null
        ? definition.node.init
        : undefined;
    }

    scope = scope.upper;
  }

  return undefined;
};

/** How a limit reads: scaled by the slack, a function (so no limit at all), or raw. */
type Reading = "scaled" | "function" | "raw";

/**
 * Reads a limit for what it is, not how it is spelled: `testLimit(30_000)` is scaled, and so is a
 * `const` of this file whose value is; `30_000`, `30 * 1000`, a `const` holding either, an import,
 * a parameter or any other expression is raw, since nothing in the file shows it scales.
 */
const readLimit = (
  sourceCode: SourceCode,
  node: ESTree.Node,
  seen: ReadonlySet<ESTree.Node> = new Set()
): Reading => {
  const limit = unwrap(node);

  if (isFunction(limit)) {
    return "function";
  }

  if (
    limit.type === "CallExpression" &&
    unwrap(limit.callee).type === "Identifier" &&
    rootName(limit.callee) === SCALER
  ) {
    return "scaled";
  }

  if (limit.type === "Identifier" && !seen.has(limit)) {
    const value = constantOf(sourceCode, limit, limit.name);

    return value === undefined
      ? "raw"
      : readLimit(sourceCode, value, new Set([...seen, limit]));
  }

  return "raw";
};

/** The `timeout` of an options object (`{ timeout: 30_000 }`, or `{ timeout }`). */
const timeoutOf = (node: ESTree.Node | undefined): ESTree.Node | undefined => {
  if (node?.type !== "ObjectExpression") {
    return undefined;
  }

  const property = node.properties.find(
    (candidate) =>
      candidate.type === "Property" &&
      !candidate.computed &&
      ((candidate.key.type === "Identifier" &&
        candidate.key.name === "timeout") ||
        (candidate.key.type === "Literal" && candidate.key.value === "timeout"))
  );

  return property?.type === "Property" ? property.value : undefined;
};

/**
 * Bans a Vitest limit that does not scale by the test slack, in a test file: the limit argument of
 * `it`, `test`, `describe` or one of their modifiers (`it.live(name, body, limit)`), of a hook
 * (`beforeAll(body, limit)`), or the `timeout` of an options object passed to one. A limit is
 * judged by what it is: `testLimit(30_000)` (`apps/server/src/EventuallyTestKit.ts`), or a `const`
 * of the same file holding one, passes; a number, arithmetic, a `const` holding them, an import or
 * anything else the file cannot show scales is reported. Such a limit holds on a quiet machine and
 * fails on a busy one. `oxlint.config.ts` applies it to the tests of the server, the judges'
 * library and the tools.
 */
export const noRawTestLimitRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a Vitest test, suite or hook limit that does not scale by the test slack; write it as testLimit().",
    },
    messages: {
      rawLimit:
        "The limit `{{limit}}` does not scale by the test slack, so it holds on a quiet machine and fails on a busy one. Write it as `testLimit(<milliseconds>)` from `apps/server/src/EventuallyTestKit.ts`, or as a `const` of this file holding one (glossary: Test slack).",
    },
  },
  createOnce(context) {
    const judge = (limit: ESTree.Node | undefined) => {
      if (
        limit === undefined ||
        readLimit(context.sourceCode, limit) !== "raw"
      ) {
        return;
      }

      context.report({
        node: limit,
        messageId: "rawLimit",
        data: { limit: context.sourceCode.getText(limit) },
      });
    };

    return {
      CallExpression(node) {
        const name = rootName(node.callee);

        if (name === undefined) {
          return;
        }

        const position = positionOf(name);

        if (position === undefined) {
          return;
        }

        const limit = node.arguments[position];

        // `it(name, options, body)`: the third argument is the body, the limit sits in the options.
        if (
          limit !== undefined &&
          limit.type !== "ObjectExpression" &&
          limit.type !== "SpreadElement" &&
          node.arguments[position - 1]?.type !== "ObjectExpression"
        ) {
          judge(limit);
        }

        for (const argument of node.arguments) {
          judge(timeoutOf(argument));
        }
      },
    };
  },
});
