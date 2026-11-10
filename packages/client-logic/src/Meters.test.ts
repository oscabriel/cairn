// The usage page's words: unknown is never zero (an unpriced model, an unread window, Codex with
// no login, a missing limit), and dollars carry their basis.

import type { ModelSpend, Spend } from "@cairn/protocol/Spend";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { PlanWindow, UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  budgetLinesOf,
  budgetWordOf,
  CODEX_PROVIDER,
  dollarsText,
  modelLinesOf,
  planStateOf,
  spendFigure,
  spendFigureOf,
  tokensShort,
  windowPercentOf,
} from "./Meters.ts";

const tokens = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: Option.none(),
});

const modelSpend = (
  input: number,
  listMicros: Option.Option<number>,
  basis: ModelSpend["basis"]
): ModelSpend => ({
  tokens: tokens(input, 0),
  listMicros: Option.map(listMicros, (micros) => Micros.make(micros)),
  basis,
});

const window = (fields: Partial<PlanWindow>): PlanWindow => ({
  id: "five_hour",
  label: "Session",
  used: Option.none(),
  resetsAt: Option.none(),
  exhausted: false,
  ...fields,
});

describe("spend figures", () => {
  it("never prints a dollar figure for tokens that have no price", () => {
    const figure = spendFigure({
      totalTokens: 120_000,
      listMicros: 0,
      unpricedTokens: 120_000,
    });

    assert.isTrue(Option.isNone(figure.dollars));
    assert.notInclude(figure.text, "$");
    assert.include(figure.text, "120k tokens");
  });

  it("says both halves when part of a spend is unpriced", () => {
    const figure = spendFigure({
      totalTokens: 200_000,
      listMicros: 420_000,
      unpricedTokens: 120_000,
    });

    assert.strictEqual(
      figure.text,
      "$0.42 at list price, plus 120k tokens with no price"
    );
  });

  it("tells nothing spent from an unknown, and a priced sliver from zero", () => {
    assert.strictEqual(
      spendFigure({ totalTokens: 0, listMicros: 0, unpricedTokens: 0 }).text,
      "Nothing spent yet"
    );
    assert.strictEqual(dollarsText(4200), "under $0.01");
    assert.strictEqual(tokensShort(1_250_000), "1.3M");
    assert.strictEqual(tokensShort(12_500), "12.5k");
  });

  it("labels each model's basis and reads an unpriced model as no price", () => {
    const spend: Spend = {
      tokens: tokens(3000, 0),
      listMicros: Micros.make(1_500_000),
      unpricedTokens: 1000,
      unpricedModels: ["opencode-go/beam-free"],
      byModel: {
        "claude-bridge/claude-opus-5-5": modelSpend(
          1500,
          Option.some(1_000_000),
          "list_on_plan"
        ),
        "opencode-go/beam-free": modelSpend(1000, Option.some(0), "unpriced"),
        "opencode-go/qwen3.8-flash": modelSpend(
          500,
          Option.some(500_000),
          "metered"
        ),
      },
      compute: Option.none(),
    };

    const lines = modelLinesOf(spend);

    assert.deepStrictEqual(
      lines.map((line) => [line.model, line.price, line.priced]),
      [
        [
          "claude-bridge/claude-opus-5-5",
          "$1.00 at API list price (plan, not billed)",
          true,
        ],
        ["opencode-go/beam-free", "No price", false],
        ["opencode-go/qwen3.8-flash", "$0.50 billed at list price", true],
      ]
    );
    assert.include(spendFigureOf(spend).text, "1k tokens with no price");
  });
});

describe("plan windows", () => {
  const snapshot: UsageSnapshot = {
    providers: [
      {
        provider: "claude-bridge",
        reading: "read",
        windows: [window({ used: Option.some(0.42) })],
        checkedAt: Option.none(),
      },
      {
        provider: "opencode-go",
        reading: "unsupported",
        windows: [],
        checkedAt: Option.none(),
      },
    ],
  };

  it("reads an unknown share as unknown and a spent window as full", () => {
    assert.isTrue(Option.isNone(windowPercentOf(window({}))));
    assert.deepStrictEqual(
      windowPercentOf(window({ used: Option.some(0.42) })),
      Option.some(42)
    );
    assert.deepStrictEqual(
      windowPercentOf(window({ exhausted: true })),
      Option.some(100)
    );
  });

  it("says Codex is missing when the brain holds no Codex row", () => {
    const codex = planStateOf(Option.some(snapshot), CODEX_PROVIDER);

    assert.strictEqual(codex.kind, "absent");
    assert.include(
      codex.kind === "absent" ? codex.why : "",
      "no Codex subscription"
    );
    assert.strictEqual(
      planStateOf(Option.some(snapshot), "opencode-go").kind,
      "unsupported"
    );
    assert.strictEqual(
      planStateOf(Option.none(), "claude-bridge").kind,
      "waiting"
    );
  });
});

describe("budgets", () => {
  it("reads an absent limit as no limit, never zero", () => {
    const lines = new Map(budgetLinesOf(DEFAULT_BUDGET));

    assert.strictEqual(lines.get("Dollars"), "No limit");
    assert.strictEqual(lines.get("Tokens"), "No limit");
    assert.strictEqual(lines.get("Warns at"), "80% of a limit");
  });

  it("shows only the limits Cairn offers, never one nothing sets", () => {
    assert.deepStrictEqual(
      budgetLinesOf({
        ...DEFAULT_BUDGET,
        maxTurns: 40,
        maxMinutes: 30,
        planGuard: {
          provider: "claude-bridge",
          windowId: "five_hour",
          maxUsedFraction: 0.5,
        },
      }).map(([label]) => label),
      ["Dollars", "Tokens", "Warns at"]
    );
  });

  it("words each state, and leaves a thread without a budget out", () => {
    assert.isTrue(Option.isNone(budgetWordOf("none")));
    assert.deepStrictEqual(
      Option.map(budgetWordOf("exhausted"), (word) => word.tone),
      Option.some("failed")
    );
  });
});
