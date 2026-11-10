// The test slack against a stand-in load: the load's value when no one names one, and the larger of
// a named value and the load's otherwise, so load that arrives after the gate read it still
// stretches the tests when Vitest reads it again.

import os from "node:os";

import { afterEach, assert, describe, it, vi } from "@effect/vitest";

import { SLACK_VARIABLE, slackFromLoad, testSlack } from "./test-slack.ts";

/** Pretends the one-minute load average is `perCore` times the cores. */
const loadPerCore = (perCore: number) => {
  vi.spyOn(os, "loadavg").mockReturnValue([
    perCore * os.availableParallelism(),
    0,
    0,
  ]);
};

describe("the test slack", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("is 1 on a quiet machine and a half plus the load per core on a busy one", () => {
    loadPerCore(0.2);
    assert.strictEqual(slackFromLoad(), 1);

    loadPerCore(3.2);
    assert.strictEqual(slackFromLoad(), 3.7);
  });

  it("is the load's when none is named, and is written back for the workers", () => {
    vi.stubEnv(SLACK_VARIABLE, undefined);
    loadPerCore(2);

    assert.strictEqual(testSlack(), 2.5);
    assert.strictEqual(process.env[SLACK_VARIABLE], "2.5");
  });

  it("keeps a named value above the load's", () => {
    vi.stubEnv(SLACK_VARIABLE, "5");
    loadPerCore(0.2);

    assert.strictEqual(testSlack(), 5);
  });

  it("rises to the load's when the load has passed the named value", () => {
    // The gate named 1 at a quiet start; the load rose before the tests began.
    vi.stubEnv(SLACK_VARIABLE, "1");
    loadPerCore(3.2);

    assert.strictEqual(testSlack(), 3.7);
    assert.strictEqual(process.env[SLACK_VARIABLE], "3.7");
  });
});
