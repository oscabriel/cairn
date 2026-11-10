// The budget a spawn's brief freezes (ADR 0047): with no budget asked it is the server's default,
// and each limit the call names replaces the default's, the rest kept.

import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { briefOf } from "./Briefs.ts";
import type { SpawnArguments } from "./Briefs.ts";

const SPAWN: SpawnArguments = {
  description: "Read the logs",
  brief: "Read the logs and say what failed.",
  why: Option.none(),
  isolation: Option.none(),
  resultSchema: Option.none(),
  wake: Option.none(),
  model: Option.none(),
  maxTokens: Option.none(),
  maxUsd: Option.none(),
};

const DEFAULT: Budget = {
  ...DEFAULT_BUDGET,
  maxListMicros: Micros.make(2_000_000),
  maxTokens: 400_000,
  warnAt: 0.7,
};

const budgetOf = (args: SpawnArguments, fallback: Budget) =>
  Result.getOrThrow(briefOf(args, "full-access", fallback)).budget;

describe("a spawn's brief budget", () => {
  it("is the server's default when the call asks none", () => {
    assert.deepStrictEqual(budgetOf(SPAWN, DEFAULT), DEFAULT);
  });

  it("freezes each limit the call asks, and the default's for the rest", () => {
    assert.deepStrictEqual(
      budgetOf({ ...SPAWN, maxUsd: Option.some(0.5) }, DEFAULT),
      { ...DEFAULT, maxListMicros: Micros.make(500_000) }
    );
    assert.deepStrictEqual(
      budgetOf(
        { ...SPAWN, maxTokens: Option.some(90_000), maxUsd: Option.some(1.25) },
        DEFAULT_BUDGET
      ),
      {
        ...DEFAULT_BUDGET,
        maxTokens: 90_000,
        maxListMicros: Micros.make(1_250_000),
      }
    );
  });

  it("has no limit only when neither the call nor the default sets one", () => {
    assert.deepStrictEqual(budgetOf(SPAWN, DEFAULT_BUDGET), DEFAULT_BUDGET);
  });

  it("refuses a dollar budget no micro count can hold, in words, instead of throwing", () => {
    for (const usd of [10_000_000_000, 2_000_000, 1e-7]) {
      const brief = briefOf(
        { ...SPAWN, maxUsd: Option.some(usd) },
        "full-access",
        DEFAULT
      );

      assert.isTrue(
        Result.isFailure(brief) && brief.failure.includes("max_usd"),
        String(usd)
      );
    }

    for (const tokens of [2 ** 60]) {
      const brief = briefOf(
        { ...SPAWN, maxTokens: Option.some(tokens) },
        "full-access",
        DEFAULT
      );

      assert.isTrue(
        Result.isFailure(brief) && brief.failure.includes("max_tokens"),
        String(tokens)
      );
    }
  });

  it("carries only the limits a card shows: no turns, minutes or plan guard from the default", () => {
    assert.deepStrictEqual(
      budgetOf(SPAWN, {
        ...DEFAULT,
        maxTurns: 40,
        maxMinutes: 30,
        planGuard: {
          provider: "claude-bridge",
          windowId: "five_hour",
          maxUsedFraction: 0.5,
        },
      }),
      DEFAULT
    );
  });
});
