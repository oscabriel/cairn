// Judges `automation/no-bare-effect-run` on every way a bare run can be written (`Effect.runPromise`
// through the barrel, a renamed `Effect`, the `effect/Effect` namespace, a named import) and on the
// runs it must leave alone: the `*With` forms, which take a context, and other modules' `run*`.

import { assert, describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noBareEffectRunRule } from "./no-bare-effect-run.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const effect = 'import { Effect } from "effect";\n';

const cases: RuleTester.TestCases = {
  valid: [
    `${effect}const run = Effect.runPromiseWith(context);\nconst p = run(e, { signal });`,
    `${effect}const f = Effect.runForkWith(context)(e);`,
    `${effect}const x = Effect.runSyncExitWith(context)(e);`,
    // Not Effect's module.
    'import { Effect } from "./Local.ts";\nconst p = Effect.runPromise(e);',
    "const p = runtime.runPromise(e);",
    "const p = ManagedRuntime.runPromise(e);",
    'import { runPromiseWith } from "effect/Effect";\nconst p = runPromiseWith(context)(e);',
  ],
  invalid: [
    {
      code: `${effect}const p = Effect.runPromise(e, { signal });`,
      errors: [{ messageId: "bareRun", data: { method: "runPromise" } }],
    },
    {
      code: `${effect}const p = Effect.runPromiseExit(e);`,
      errors: [{ messageId: "bareRun", data: { method: "runPromiseExit" } }],
    },
    {
      code: `${effect}Effect.runFork(Effect.log("x"));`,
      errors: [{ messageId: "bareRun", data: { method: "runFork" } }],
    },
    {
      code: `${effect}const x = Effect.runSync(e);`,
      errors: [{ messageId: "bareRun", data: { method: "runSync" } }],
    },
    {
      code: `${effect}const x = Effect.runSyncExit(e);`,
      errors: [{ messageId: "bareRun", data: { method: "runSyncExit" } }],
    },
    {
      code: `${effect}const stop = Effect.runCallback(e);`,
      errors: [{ messageId: "bareRun", data: { method: "runCallback" } }],
    },
    {
      code: 'import { Effect as E } from "effect";\nconst p = E.runPromise(e);',
      errors: [{ messageId: "bareRun", data: { method: "runPromise" } }],
    },
    {
      code: 'import * as Effect from "effect/Effect";\nconst p = Effect.runPromise(e);',
      errors: [{ messageId: "bareRun", data: { method: "runPromise" } }],
    },
    {
      code: 'import { runPromise as go } from "effect/Effect";\nconst p = go(e);',
      errors: [{ messageId: "bareRun", data: { method: "runPromise" } }],
    },
  ],
};

describe("automation/no-bare-effect-run", () => {
  it("flags each bare run and leaves the runs that take a context alone", () => {
    assert.doesNotThrow(() => {
      tester.run("no-bare-effect-run", noBareEffectRunRule, cases);
    });
  });
});
