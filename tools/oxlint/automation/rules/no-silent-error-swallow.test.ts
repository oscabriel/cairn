// Judges `automation/no-silent-error-swallow` on every handler position (`catch(f)`,
// `catchTag("A", f)`, `catchTags({ A: f })`, data-first and piped) and on the handlers it must leave
// alone: ones that recover, translate or log.

import { assert, describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noSilentErrorSwallowRule } from "./no-silent-error-swallow.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const effect = 'import { Effect } from "effect";\n';

const cases: RuleTester.TestCases = {
  valid: [
    `${effect}const p = e.pipe(Effect.catch(() => Effect.succeed(0)));`,
    `${effect}const p = e.pipe(Effect.catchTag("A", (error) => Effect.logWarning(error)));`,
    `${effect}const p = e.pipe(Effect.catch((error) => Effect.fail(new B({ cause: error }))));`,
    `${effect}const p = e.pipe(Effect.catchTags({ A: () => Effect.succeed(1) }));`,
    `${effect}const p = e.pipe(Effect.catch(() => {\n  log();\n  return Effect.void;\n}));`,
    // Dropping a failure on purpose reads as such.
    `${effect}const p = e.pipe(Effect.ignore);`,
    // \`Effect.void\` outside a catch, and a catch on something that is not Effect's module.
    `${effect}const p = e.pipe(Effect.andThen(() => Effect.void));`,
    "const p = promise.catch(() => Effect.void);",
    'import { Effect } from "./Local.ts";\nconst p = e.pipe(Effect.catch(() => Effect.void));',
  ],
  invalid: [
    {
      code: `${effect}const p = e.pipe(Effect.catch(() => Effect.void));`,
      errors: [{ messageId: "silentSwallow", data: { method: "catch" } }],
    },
    {
      code: `${effect}const p = Effect.catch(e, () => Effect.void);`,
      errors: [{ messageId: "silentSwallow", data: { method: "catch" } }],
    },
    {
      code: `${effect}const p = e.pipe(Effect.catchTag("A", function () {\n  return Effect.void;\n}));`,
      errors: [{ messageId: "silentSwallow", data: { method: "catchTag" } }],
    },
    {
      code: `${effect}const p = e.pipe(Effect.catchTags({ A: () => Effect.void, B: () => Effect.succeed(1), C: () => Effect.void }));`,
      errors: [
        { messageId: "silentSwallow", data: { method: "catchTags" } },
        { messageId: "silentSwallow", data: { method: "catchTags" } },
      ],
    },
    {
      code: `${effect}const p = e.pipe(Effect.catchCause(() => Effect.void));`,
      errors: [{ messageId: "silentSwallow", data: { method: "catchCause" } }],
    },
    {
      code: `${effect}const p = e.pipe(Effect.catchIf((error) => error.retryable, () => Effect.void));`,
      errors: [{ messageId: "silentSwallow", data: { method: "catchIf" } }],
    },
    {
      code: 'import * as Fx from "effect/Effect";\nconst p = e.pipe(Fx.catch(() => Fx.void));',
      errors: [{ messageId: "silentSwallow", data: { method: "catch" } }],
    },
  ],
};

// RuleTester runs every case itself and throws at the first that fails, naming it.
describe("automation/no-silent-error-swallow", () => {
  it("flags catch handlers that only return Effect.void and passes real recovery", () => {
    assert.doesNotThrow(() => {
      tester.run(
        "automation/no-silent-error-swallow",
        noSilentErrorSwallowRule,
        cases
      );
    });
  });
});
