// Judges `automation/no-ambient-nondeterminism` on code shapes the repo-level probe in
// judges/lint-rules.test.ts does not reach: shadowed globals, `globalThis` access, WebCrypto's
// `subtle` and every way `node:crypto` randomness can be imported.

import { assert, describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noAmbientNondeterminismRule } from "./no-ambient-nondeterminism.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const cases: RuleTester.TestCases = {
  valid: [
    // Effect's capabilities, bound locally, share the globals' names.
    'import { Crypto, Effect } from "effect";\nconst f = Effect.gen(function* () {\n  const crypto = yield* Crypto.Crypto;\n  return yield* crypto.randomUUIDv4();\n});',
    "const Date = { now: () => 0 };\nconst t = Date.now();",
    "const f = (Math: { random(): number }) => Math.random();",
    // A fixed instant and date arithmetic are deterministic.
    'const d = new Date("2026-01-01T00:00:00Z");',
    "const d = new Date(0);",
    "const n = Date.parse(s);",
    "const r = Math.max(1, 2);",
    // Names that only look like the globals.
    "const o = { crypto: 1, Date: 2 };",
    "const n = o.crypto;",
    "type T = { now: Date };",
    'import { createHash, timingSafeEqual } from "node:crypto";',
    'import * as nodeCrypto from "node:crypto";\nconst h = nodeCrypto.createHash("sha256");',
    // WebCrypto's signing and key agreement have no Effect service.
    "const { subtle } = globalThis.crypto;",
    'const key = crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);',
  ],
  invalid: [
    { code: "const t = Date.now();", errors: [{ messageId: "ambientDate" }] },
    { code: "const d = new Date();", errors: [{ messageId: "ambientDate" }] },
    { code: "const s = Date();", errors: [{ messageId: "ambientDate" }] },
    {
      code: "const t = globalThis.Date.now();",
      errors: [{ messageId: "ambientDate" }],
    },
    {
      code: "const r = Math.random();",
      errors: [{ messageId: "ambientMathRandom" }],
    },
    {
      code: 'const r = Math["random"]();',
      errors: [{ messageId: "ambientMathRandom" }],
    },
    {
      code: "const id = crypto.randomUUID();",
      errors: [{ messageId: "ambientCrypto" }],
    },
    {
      code: "const { subtle, getRandomValues } = crypto;",
      errors: [{ messageId: "ambientCrypto" }],
    },
    {
      code: "const id = globalThis.crypto.randomUUID();",
      errors: [{ messageId: "ambientCrypto" }],
    },
    {
      code: "const f = () => {\n  const crypto = 1;\n  return crypto;\n};\nconst g = () => crypto.getRandomValues(new Uint8Array(4));",
      errors: [{ messageId: "ambientCrypto", line: 5 }],
    },
    {
      code: 'import { createHash, randomUUID } from "node:crypto";',
      errors: [{ messageId: "cryptoImport", data: { name: "randomUUID" } }],
    },
    {
      code: 'import { randomBytes as bytes } from "crypto";',
      errors: [{ messageId: "cryptoImport", data: { name: "randomBytes" } }],
    },
    {
      code: 'import * as nodeCrypto from "node:crypto";\nconst b = nodeCrypto.randomBytes(4);',
      errors: [{ messageId: "cryptoImport", data: { name: "randomBytes" } }],
    },
    {
      code: 'import nodeCrypto from "node:crypto";\nconst u = nodeCrypto.randomUUID();',
      errors: [{ messageId: "cryptoImport", data: { name: "randomUUID" } }],
    },
  ],
};

// RuleTester runs every case itself and throws at the first that fails, naming it.
describe("automation/no-ambient-nondeterminism", () => {
  it("flags ambient time and randomness and passes Effect's capabilities", () => {
    assert.doesNotThrow(() => {
      tester.run(
        "automation/no-ambient-nondeterminism",
        noAmbientNondeterminismRule,
        cases
      );
    });
  });
});
