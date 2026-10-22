import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";
import foldkitRecommended from "@foldkit/oxlint-plugin/recommended.json" with { type: "json" };
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

// Foldkit's recommended rules, scoped to the web client. `denyWarnings` is on, so every severity
// must be error or off; a plugin bump that introduces "warn" stops here until it is mapped.
const foldkitScope = (pattern: string) => `apps/web/src/${pattern}`;

const foldkitSeverity = ([rule, severity]: readonly [string, string]) => {
  if (severity === "error" || severity === "off") {
    return [rule, severity] as const;
  }

  throw new Error(
    `@foldkit/oxlint-plugin/recommended.json sets ${rule} to ${severity}. Map that severity in oxlint.config.ts before bumping the plugin.`
  );
};

const foldkitRules = (rules: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(rules).map(foldkitSeverity));

const foldkitOverrides = [
  {
    files: [foldkitScope("**/*.ts")],
    rules: foldkitRules(foldkitRecommended.rules),
  },
  ...foldkitRecommended.overrides.map(
    ({ excludeFiles = [], files, rules }) => ({
      excludeFiles: excludeFiles.map(foldkitScope),
      files: files.map(foldkitScope),
      rules: foldkitRules(rules),
    })
  ),
];

// Library boundaries (coding standard S42 as amended, plan D54). Each library may be imported only
// in its zone; everywhere else the import fails lint. Overrides do not merge a rule's options, so
// each zone below lists the full set of libraries it still refuses, and a file that sits in two
// zones is covered by a later, more specific zone. `judges/lint-boundaries.test.ts` proves each
// restriction fires.
type Library =
  | "agentSdk"
  | "anthropicOAuth"
  | "codingAgent"
  | "durable"
  | "piAi";

const restrictions = {
  // pi-durable is the framework Cairn's tools and sections are written in: brain/**, *Extension.ts
  // and judge fixtures only.
  durable: {
    paths: [
      {
        name: "@earendil-works/pi-durable",
        message:
          "pi-durable is imported only under apps/server/src/brain/, in *Extension.ts files and in judges/fixtures/ (coding standard S42).",
      },
    ],
    patterns: [
      {
        group: ["@earendil-works/pi-durable/**"],
        message:
          "pi-durable is imported only under apps/server/src/brain/, in *Extension.ts files and in judges/fixtures/ (coding standard S42).",
      },
    ],
  },
  // pi-ai at runtime: brain/**, models/**, *Extension.ts and the bridge. `import type` is fine anywhere.
  piAi: {
    paths: [
      {
        name: "@earendil-works/pi-ai",
        allowTypeImports: true,
        message:
          "pi-ai is imported at runtime only under brain/, models/, *Extension.ts and packages/bridge/; use `import type` elsewhere (coding standard S42).",
      },
    ],
    patterns: [
      {
        group: ["@earendil-works/pi-ai/**"],
        allowTypeImports: true,
        message:
          "pi-ai is imported at runtime only under brain/, models/, *Extension.ts and packages/bridge/; use `import type` elsewhere (coding standard S42).",
      },
    ],
  },
  // pi-coding-agent: the model runtime and pi's skills, read through three places only.
  codingAgent: {
    paths: [
      {
        name: "@earendil-works/pi-coding-agent",
        message:
          "pi-coding-agent is imported only in models/PiModelSource.ts, models/PiConfig.ts and skills/ (coding standard S42).",
      },
    ],
    patterns: [],
  },
  // The Agent SDK and the MCP SDK it speaks through: ClaudeSdk.ts only.
  agentSdk: {
    paths: [
      {
        name: "@anthropic-ai/claude-agent-sdk",
        message:
          "The Agent SDK is imported only in packages/bridge/src/ClaudeSdk.ts (coding standard S42).",
      },
    ],
    patterns: [
      {
        group: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/**"],
        message:
          "The MCP SDK is imported only in packages/bridge/src/ClaudeSdk.ts (coding standard S42).",
      },
    ],
  },
  // pi-ai's Anthropic OAuth login is reachable only through these two names (ADR 0002): refused
  // everywhere but the guard that replaces the `anthropic` provider. The model catalogs in
  // `providers/all` (`getBuiltinModels`, ...) stay importable where pi-ai is.
  anthropicOAuth: {
    paths: [
      {
        name: "@earendil-works/pi-ai/providers/anthropic",
        message:
          "pi-ai's anthropic provider carries the Anthropic OAuth login; only models/AnthropicGuard.ts imports it (ADR 0002).",
      },
      {
        name: "@earendil-works/pi-ai/providers/all",
        importNames: ["builtinProviders", "builtinModels"],
        message:
          "builtinProviders() and builtinModels() include the Anthropic OAuth login; only models/AnthropicGuard.ts imports them (ADR 0002).",
      },
    ],
    patterns: [],
  },
} satisfies Record<
  Library,
  {
    paths: Array<{
      name: string;
      message: string;
      allowTypeImports?: boolean;
      importNames?: Array<string>;
    }>;
    patterns: Array<{
      group: Array<string>;
      message: string;
      allowTypeImports?: boolean;
    }>;
  }
>;

const libraries: ReadonlyArray<Library> = [
  "durable",
  "piAi",
  "codingAgent",
  "agentSdk",
  "anthropicOAuth",
];

const refuseAllBut = (allowed: ReadonlyArray<Library>) => {
  const refused = libraries.filter((library) => !allowed.includes(library));

  return {
    "no-restricted-imports": [
      "error",
      {
        paths: refused.flatMap((library) => restrictions[library].paths),
        patterns: refused.flatMap((library) => restrictions[library].patterns),
      },
    ],
  } as const;
};

const server = (pattern: string) => `apps/server/src/${pattern}`;

// Later entries win, so the most specific zones come last.
const zones: ReadonlyArray<{
  files: Array<string>;
  allowed: ReadonlyArray<Library>;
}> = [
  { files: ["**/*.ts", "**/*.mts", "**/*.js", "**/*.mjs"], allowed: [] },
  { files: ["packages/bridge/**"], allowed: ["piAi"] },
  // The bridge's tests run the provider against a bare pi-durable Harness.
  { files: ["packages/bridge/src/**/*.test.ts"], allowed: ["piAi", "durable"] },
  {
    files: ["packages/bridge/src/ClaudeSdk.ts"],
    allowed: ["piAi", "agentSdk"],
  },
  { files: [server("models/**")], allowed: ["piAi"] },
  {
    files: [server("models/PiModelSource.ts"), server("models/PiConfig.ts")],
    allowed: ["piAi", "codingAgent"],
  },
  {
    files: [server("models/AnthropicGuard.ts")],
    allowed: ["piAi", "anthropicOAuth"],
  },
  { files: [server("skills/**")], allowed: ["codingAgent"] },
  { files: [server("brain/**")], allowed: ["durable", "piAi"] },
  { files: [server("**/*Extension.ts")], allowed: ["durable", "piAi"] },
  // Upload-time image fitting runs pi-durable's Photon processor (plan section 1, "Attachments").
  { files: [server("attachments/ImagePrepare.ts")], allowed: ["durable"] },
  {
    files: [server("skills/**/*Extension.ts")],
    allowed: ["durable", "piAi", "codingAgent"],
  },
  { files: ["judges/fixtures/**"], allowed: ["durable", "piAi"] },
  // The bridge judge drives a bare pi-durable Harness with the real bridge (3F).
  { files: ["judges/claude-live.ts"], allowed: ["durable", "piAi"] },
  // The dependency smoke test checks the installed names of every library.
  {
    files: [server("smoke.test.ts")],
    allowed: ["durable", "piAi", "codingAgent"],
  },
];

const boundaryOverrides = zones.map(({ files, allowed }) => ({
  files,
  rules: refuseAllBut(allowed),
}));

// Brand leftovers from t3code (plan D24) are judged by `judges/brand.test.ts`, which skips port
// headers; a lint rule cannot tell a header from code.

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
    { name: "foldkit", specifier: "@foldkit/oxlint-plugin" },
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
    ...foldkitOverrides,
    ...boundaryOverrides,
    {
      // Foldkit's page folders re-export Model, Message, update and view from an index.ts by
      // convention (its oxlint plugin and docs assume it); barrels stay banned everywhere else.
      files: ["apps/web/src/page/**/index.ts"],
      rules: { "oxc/no-barrel-file": "off" },
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
