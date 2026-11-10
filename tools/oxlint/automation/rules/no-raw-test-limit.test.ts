// Judges `automation/no-raw-test-limit` on every place a Vitest limit can be written as a number (a
// test's, a suite's, a hook's, through a modifier or `each`, in an options object) and on the limits
// it must leave alone: scaled ones, and numbers that are not a limit.

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
    "beforeAll(() => {}, LIMIT);",
    'it("reads", () => {});',
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
  ],
};

describe("automation/no-raw-test-limit", () => {
  it("flags a limit written as a number and leaves scaled ones alone", () => {
    assert.doesNotThrow(() => {
      tester.run("no-raw-test-limit", noRawTestLimitRule, cases);
    });
  });
});
