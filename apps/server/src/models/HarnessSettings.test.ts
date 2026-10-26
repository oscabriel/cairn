// Judges the mapping from pi's run settings to pi-durable's: every field the TUI uses arrives,
// pi's per-model overrides are kept, every bridge model gets D7's compaction override (winning over
// pi's own for that key), and a failed run keeps its queue.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { harnessSettingsFrom } from "./HarnessSettings.ts";
import type { PiRunSettings } from "./PiConfig.ts";

const RUN: PiRunSettings = {
  compaction: {
    enabled: true,
    reserveTokens: 20_000,
    keepRecentTokens: 18_000,
    modelOverrides: new Map([
      [
        "opencode-go/kimi-k2",
        { reserveTokens: Option.none(), keepRecentTokens: Option.some(9000) },
      ],
      [
        "claude-bridge/claude-opus-5-5",
        {
          reserveTokens: Option.some(50_000),
          keepRecentTokens: Option.some(12_000),
        },
      ],
    ]),
  },
  retry: {
    enabled: true,
    maxRetries: 7,
    baseDelayMs: 1500,
    maxAgentDelayMs: 30_000,
  },
  providerRetry: {
    timeoutMs: Option.some(90_000),
    maxRetries: Option.none(),
    maxRetryDelayMs: 60_000,
  },
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  transport: "websocket",
};

describe("the run settings from pi's settings.json", () => {
  it("carries pi's run settings and keeps a failed run's queue", () => {
    const settings = harnessSettingsFrom(RUN, []);

    assert.strictEqual(settings.afterFailedRun, "keep");
    assert.deepStrictEqual(settings.stream, {
      transport: "websocket",
      maxRetryDelayMs: 60_000,
      timeoutMs: 90_000,
    });
    assert.deepStrictEqual(settings.retry, {
      enabled: true,
      maxRetries: 7,
      baseDelayMs: 1500,
      maxAgentDelayMs: 30_000,
    });
    assert.strictEqual(settings.steeringMode, "all");
    assert.strictEqual(settings.followUpMode, "one-at-a-time");
    assert.strictEqual(settings.compaction?.reserveTokens, 20_000);
    assert.deepStrictEqual(
      settings.compaction?.modelOverrides?.["opencode-go/kimi-k2"],
      { keepRecentTokens: 9000 }
    );
  });

  it("gives every bridge model D7's override, over pi's own for that model", () => {
    const settings = harnessSettingsFrom(RUN, [
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]);

    const overrides = settings.compaction?.modelOverrides ?? {};

    assert.deepStrictEqual(overrides["claude-bridge/claude-haiku-5-5"], {
      backgroundTokens: 0,
      reserveTokens: 16_384,
    });
    assert.deepStrictEqual(overrides["claude-bridge/claude-opus-5-5"], {
      reserveTokens: 16_384,
      keepRecentTokens: 12_000,
      backgroundTokens: 0,
    });
    assert.isTrue(settings.compaction?.enabled, "blocking compaction stays on");
  });
});
