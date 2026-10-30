// The usage page's and role table's words: unknown is never zero (an unpriced model, an unread
// window, Codex with no login, a missing limit), dollars carry their basis, and a rebinding keeps
// what the user did not change.

import type { ModelListing } from "@cairn/protocol/Models";
import type { RoleCheck, RoleTable } from "@cairn/protocol/Roles";
import {
  DEFAULT_ROLE_TABLE,
  RoleCheck as RoleCheckSchema,
  RoleName as RoleNames,
} from "@cairn/protocol/Roles";
import type { ModelSpend, Spend } from "@cairn/protocol/Spend";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { PlanWindow, UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  budgetLinesOf,
  budgetWordOf,
  CODEX_PROVIDER,
  dollarsText,
  modelChoicesOf,
  modelLinesOf,
  planStateOf,
  rebindModel,
  rebindThinking,
  roleStatusOf,
  rolesOf,
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

const listing = (
  provider: string,
  modelId: string,
  available: boolean,
  thinkingLevels: ModelListing["thinkingLevels"]
): ModelListing => ({
  provider,
  modelId,
  name: modelId,
  thinkingLevels,
  acceptsImages: false,
  contextWindow: Option.none(),
  available,
});

const Resolution = RoleCheckSchema.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

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

  it("words each state, and leaves a thread without a budget out", () => {
    assert.isTrue(Option.isNone(budgetWordOf("none")));
    assert.deepStrictEqual(
      Option.map(budgetWordOf("exhausted"), (word) => word.tone),
      Option.some("failed")
    );
  });
});

describe("the role table", () => {
  const verifier = RoleNames.make("@verifier");
  const worker = RoleNames.make("@worker");

  const codexTable: RoleTable = {
    ...DEFAULT_ROLE_TABLE,
    [verifier]: {
      model: { provider: "openai-codex", modelId: "gpt-6-luna" },
      thinkingLevel: Option.some("high"),
      fallbacks: [{ provider: "opencode-go", modelId: "gpt-6-luna" }],
      note: Option.none(),
    },
  };

  const catalog = [
    listing("opencode-go", "gpt-6-luna", true, ["low", "medium"]),
    listing("claude-bridge", "claude-opus-5-5", false, ["medium", "high"]),
  ];

  it("lists the built-in roles first", () => {
    assert.deepStrictEqual(
      rolesOf(codexTable),
      ["@worker", "@scout", "@judge", "@verifier"].map((name) =>
        RoleNames.make(name)
      )
    );
  });

  it("keeps a binding the catalog does not list as the selected choice", () => {
    const choices = modelChoicesOf(catalog, {
      provider: "openai-codex",
      modelId: "gpt-6-luna",
    });

    assert.deepStrictEqual(
      choices.map((choice) => [choice.value, choice.available]),
      [
        ["openai-codex/gpt-6-luna", false],
        ["opencode-go/gpt-6-luna", true],
        ["claude-bridge/claude-opus-5-5", false],
      ]
    );
  });

  it("rebinds one role, dropping a fallback equal to the new model and a level it cannot take", () => {
    const next = Option.getOrThrow(
      rebindModel(
        codexTable,
        verifier,
        { provider: "opencode-go", modelId: "gpt-6-luna" },
        ["low", "medium"]
      )
    );

    assert.deepStrictEqual(next[verifier]?.fallbacks, []);
    assert.deepStrictEqual(next[verifier]?.thinkingLevel, Option.none());
    assert.strictEqual(next[worker], codexTable[worker]);

    const thought = Option.getOrThrow(
      rebindThinking(next, verifier, Option.some("low"))
    );

    assert.deepStrictEqual(
      thought[verifier]?.thinkingLevel,
      Option.some("low")
    );
    assert.isTrue(
      Option.isNone(
        rebindModel(
          codexTable,
          RoleNames.make("@nobody"),
          { provider: "opencode-go", modelId: "gpt-6-luna" },
          []
        )
      )
    );
  });

  it("says why a role has no ready model", () => {
    const check: RoleCheck = {
      spec: "@verifier",
      resolution: Resolution.cases.Unresolved.make({
        reason: "no_ready_model",
        skipped: [
          {
            model: { provider: "openai-codex", modelId: "gpt-6-luna" },
            reason: "missing_credential",
          },
        ],
      }),
      sameFamilyAsWorker: false,
    };

    const status = roleStatusOf(check);

    assert.strictEqual(status.word, "No ready model");
    assert.strictEqual(status.tone, "failed");
    assert.include(
      Option.getOrElse(status.detail, () => ""),
      "openai-codex/gpt-6-luna has no credential here"
    );
  });
});
