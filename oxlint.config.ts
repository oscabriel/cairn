import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Overrides inside an extended preset win over this file's `overrides`, so
// patch the vitest preset's own test-file override instead.
const vitestForEffect = {
  ...vitest,
  overrides: (vitest.overrides ?? []).map((override) => ({
    ...override,
    rules: {
      ...override.rules,
      // `expect` inside `it.effect(() => Effect.gen(...))` is not seen as
      // inside a test block.
      "vitest/no-standalone-expect": "off",
    },
  })),
};

const agentDirs = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
];

export default defineConfig({
  // oxlint does not carry `env` through `extends`.
  env: core.env,
  extends: [core, vitestForEffect, effectRecommended],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ...agentDirs,
    // Spikes are throwaway; their NOTES.md is the deliverable.
    "spikes/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
    typeAware: true,
  },
  overrides: [
    {
      files: ["**/*.test.ts"],
      rules: {
        // @effect/tsgo flags @effect/vitest as an unstable API.
        "effecttsgo/unstable-api-usage": "off",
      },
    },
  ],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    // Effect's own convention: `import { Effect } from "effect"` (ADR 0004).
    "effecttsgo/prefer-barrel-import": "error",
    // The rest are Effect v4 idioms that ultracite core rejects (research 07 §3.3).
    "effecttsgo/schema-class-missing-brand": "off",
    "func-names": "off",
    "max-classes-per-file": "off",
    "no-redeclare": "off",
    "oxc/no-accumulating-spread": "error",
    "require-yield": "off",
    // Effect's own style wins over ultracite's here (ADR 0004): Schema field order is meaningful,
    // service shapes use method signatures, Effect writes `Array<A>`/`ReadonlyArray<A>`, and
    // data-first combinators (`Effect.flatMap(self, f)`) are not array `thisArg` calls.
    "sort-keys": "off",
    "typescript/array-type": [
      "error",
      { default: "generic", readonly: "generic" },
    ],
    "typescript/consistent-indexed-object-style": "off",
    "typescript/method-signature-style": "off",
    // Effect modules are PascalCase files (`Database.ts`); configs and scripts are kebab-case.
    "unicorn/filename-case": [
      "error",
      { cases: { kebabCase: true, pascalCase: true } },
    ],
    "unicorn/no-array-method-this-argument": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/prefer-reflect-apply": "off",
    "unicorn/throw-new-error": "off",
  },
});
