// Judges `automation/no-raw-test-limit` on every place a Vitest limit can be written (a test's, a
// suite's, a hook's, through a modifier or `each`, in an options object), on every spelling of a
// limit that does not scale (a number, arithmetic, a `const` holding them, an import), and on what
// it must leave alone: scaled limits, a `const` holding one, and numbers that are not a limit.

import { assert, describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noRawTestLimitRule } from "./no-raw-test-limit.ts";

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const raw = (limit: string) => ({
  messageId: "rawLimit",
  data: { limit },
});

const cases: RuleTester.TestCases = {
  valid: [
    'it("waits", () => {}, testLimit(30_000));',
    'it.live("waits", () => Effect.void, testLimit(30_000));',
    'describe("suite", () => {}, { timeout: testLimit(5000) });',
    // A `const` of this file holding a scaled limit, and a limit given as a shorthand `timeout`.
    "const LIMIT = testLimit(30_000);\nbeforeAll(() => {}, LIMIT);",
    'const LIMIT = testLimit(30_000) as number;\nit("waits", () => {}, LIMIT);',
    'const timeout = testLimit(30_000);\nit("waits", { timeout }, () => {});',
    'it("reads", () => {});',
    // The third argument is the body when the second is the options; a named body is no limit.
    'it("waits", { timeout: testLimit(5000) }, body);',
    'const body = () => {};\nit("reads", body);',
    "function body() {}\nbeforeEach(body);",
    // A number that is not a limit: an argument of another call, a row of `each`.
    "assert.strictEqual(value, 30_000);",
    'it.each([1, 2])("row %i", (row) => {});',
    "expect(1).toBe(1);",
  ],
  invalid: [
    {
      code: 'it("waits", () => {}, 30_000);',
      errors: [raw("30_000")],
    },
    {
      code: 'it.live("waits", () => Effect.void, 30_000);',
      errors: [raw("30_000")],
    },
    {
      code: 'it.effect.skip("waits", () => Effect.void, 5000);',
      errors: [raw("5000")],
    },
    {
      code: 'test("waits", async () => {}, 10_000);',
      errors: [raw("10_000")],
    },
    {
      code: 'describe("suite", () => {}, 60_000);',
      errors: [raw("60_000")],
    },
    {
      code: "beforeAll(async () => {}, 20_000);",
      errors: [raw("20_000")],
    },
    {
      code: 'it.each([1, 2])("row %i", (row) => {}, 2000);',
      errors: [raw("2000")],
    },
    {
      code: 'it("waits", { timeout: 30_000 }, () => {});',
      errors: [raw("30_000")],
    },
    {
      code: 'describe("suite", () => {}, { timeout: 15_000, retry: 2 });',
      errors: [raw("15_000")],
    },
    // A limit is judged by what it is, not how it is spelled: a `const` holding a number,
    // arithmetic, a scaled number multiplied by hand, an import the file cannot see into.
    {
      code: 'const SLOW = 60_000;\nit("waits", () => {}, SLOW);',
      errors: [raw("SLOW")],
    },
    {
      code: 'it("waits", () => {}, 30 * 1000);',
      errors: [raw("30 * 1000")],
    },
    {
      code: "const SLOW = 60 * 1000;\nconst LIMIT = SLOW;\nbeforeAll(() => {}, LIMIT);",
      errors: [raw("LIMIT")],
    },
    {
      code: 'it("waits", () => {}, 120_000 * TEST_SLACK);',
      errors: [raw("120_000 * TEST_SLACK")],
    },
    {
      code: 'import { LIMIT } from "./kit.ts";\nit("waits", () => {}, LIMIT);',
      errors: [raw("LIMIT")],
    },
    {
      code: 'let limit = testLimit(5000);\nit("waits", () => {}, limit);',
      errors: [raw("limit")],
    },
    {
      code: 'const timeout = 30_000;\ndescribe("suite", { timeout }, () => {});',
      errors: [raw("timeout")],
    },
    {
      code: 'it("waits", () => {}, { timeout: Duration.toMillis(Duration.seconds(5)) });',
      errors: [raw("Duration.toMillis(Duration.seconds(5))")],
    },
  ],
};

describe("automation/no-raw-test-limit", () => {
  it("flags a limit that does not scale, however it is spelled, and leaves scaled ones alone", () => {
    assert.doesNotThrow(() => {
      tester.run("no-raw-test-limit", noRawTestLimitRule, cases);
    });
  });
});
