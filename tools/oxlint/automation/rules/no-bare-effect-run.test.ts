// Judges `automation/no-bare-effect-run` on every way a bare run can be written (`Effect.runPromise`
// through the barrel, a renamed `Effect`, the `effect/Effect` namespace, the barrel as a namespace,
// a named import, a reference passed on, a context form or `runnerOf` over `Context.empty()`) and on
// the runs it must leave alone: the `*With` forms over a real context, and other modules' `run*`.

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
    // A context that is not empty, and another module's `empty`.
    "const run = runnerOf(context);",
    `${effect}import { Option } from "effect";\nconst run = Effect.runPromiseWith(Option.empty());`,
    'import { Context } from "./Local.ts";\nconst run = runnerOf(Context.empty());',
    // A property named like a bare run, on something that is not Effect's module.
    "const run = { runPromise: 1 };\nconst x = run.runPromise;",
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
    // A bare run passed on rather than called, by reference or by name.
    {
      code: `${effect}const go = Effect.runPromise;\nawait go(e);`,
      errors: [{ messageId: "bareRun", data: { method: "runPromise" } }],
    },
    {
      code: `${effect}promise.then(Effect.runFork);`,
      errors: [{ messageId: "bareRun", data: { method: "runFork" } }],
    },
    {
      code: 'import { runFork } from "effect/Effect";\npromise.then(runFork);',
      errors: [{ messageId: "bareRun", data: { method: "runFork" } }],
    },
    // Through the barrel as a namespace.
    {
      code: 'import * as Fx from "effect";\nconst p = Fx.Effect.runPromise(e);',
      errors: [{ messageId: "bareRun", data: { method: "runPromise" } }],
    },
    // A context form, or Cairn's runner, over an empty context.
    {
      code: 'import { Context, Effect } from "effect";\nconst p = Effect.runPromiseWith(Context.empty())(e);',
      errors: [
        {
          messageId: "emptyContext",
          data: { method: "Effect.runPromiseWith" },
        },
      ],
    },
    {
      code: 'import { Context } from "effect";\nconst run = runnerOf(Context.empty());',
      errors: [{ messageId: "emptyContext", data: { method: "runnerOf" } }],
    },
    {
      code: 'import * as Fx from "effect";\nconst run = Fx.Effect.runForkWith(Fx.Context.empty());',
      errors: [
        { messageId: "emptyContext", data: { method: "Effect.runForkWith" } },
      ],
    },
    {
      code: 'import * as Ctx from "effect/Context";\nimport { runSyncWith } from "effect/Effect";\nconst x = runSyncWith(Ctx.empty())(e);',
      errors: [{ messageId: "emptyContext", data: { method: "runSyncWith" } }],
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
