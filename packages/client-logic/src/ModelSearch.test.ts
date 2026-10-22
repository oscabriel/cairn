// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// packages/shared/src/searchRanking.test.ts, apps/web/src/components/chat/modelPickerSearch.test.ts
// and modelPickerKeys.test.ts. Changed: a model is a pi provider and model id, so the catalog's
// sub-provider became the provider's name; legacy section keys are gone. MIT License, Copyright
// (c) 2026 T3 Tools Inc.; the full notice is in ModelSearch.ts.
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  buildModelSearchText,
  exactOnly,
  modelPickerModelKey,
  normalizeSearchQuery,
  parseModelPickerModelKey,
  rankModelSearch,
  rankSearchResults,
  scoreModelSearch,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "./ModelSearch.ts";
import type { SearchableModel } from "./ModelSearch.ts";

describe(normalizeSearchQuery, () => {
  it("trims and lowercases queries", () => {
    assert.strictEqual(normalizeSearchQuery("  UI  "), "ui");
  });

  it("can strip leading trigger characters", () => {
    assert.strictEqual(
      normalizeSearchQuery("  $ui", Option.some(/^\$+/u)),
      "ui"
    );
  });
});

describe(scoreQueryMatch, () => {
  const bases = {
    ...exactOnly(0),
    prefix: Option.some(10),
    boundary: Option.some(20),
    includes: Option.some(30),
    boundaryMarkers: ["-"],
  };

  it("prefers exact matches over broader contains matches", () => {
    assert.deepStrictEqual(scoreQueryMatch("ui", "ui", bases), Option.some(0));
    assert.isTrue(
      Option.getOrThrow(scoreQueryMatch("building native ui", "ui", bases)) > 0
    );
  });

  it("treats boundary matches as stronger than generic contains matches", () => {
    const boundary = Option.getOrThrow(
      scoreQueryMatch("gh-fix-ci", "fix", bases)
    );

    const contains = Option.getOrThrow(
      scoreQueryMatch("highfixci", "fix", bases)
    );

    assert.isTrue(boundary < contains);
  });
});

describe(scoreSubsequenceMatch, () => {
  it("scores tighter subsequences ahead of looser ones", () => {
    const compact = Option.getOrThrow(scoreSubsequenceMatch("ghfixci", "gfc"));

    const spread = Option.getOrThrow(
      scoreSubsequenceMatch("github-fix-ci", "gfc")
    );

    assert.isTrue(compact < spread);
  });
});

describe(rankSearchResults, () => {
  it("keeps the best-ranked candidates within the limit", () => {
    const ranked = rankSearchResults(
      [
        { item: "b", score: 20, tieBreaker: "b" },
        { item: "d", score: 40, tieBreaker: "d" },
        { item: "a", score: 10, tieBreaker: "a" },
        { item: "c", score: 30, tieBreaker: "c" },
      ],
      2
    );

    assert.deepStrictEqual(
      ranked.map((entry) => entry.item),
      ["a", "b"]
    );
  });
});

const model = (
  provider: string,
  providerName: string,
  name: string,
  isFavorite = false
): SearchableModel => ({
  provider,
  providerName,
  name,
  modelId: name.toLowerCase().replaceAll(" ", "-"),
  isFavorite,
});

describe(buildModelSearchText, () => {
  it("builds search text from the name, id and provider", () => {
    assert.strictEqual(
      buildModelSearchText(model("opencode-go", "OpenCode Go", "Kimi K3")),
      "kimi k3 kimi-k3 opencode-go opencode go"
    );
  });
});

describe(scoreModelSearch, () => {
  const opus = model("opencode-go", "GitHub Copilot", "Claude Opus 4.7");

  it("matches typo-tolerant multi-token queries", () => {
    assert.isTrue(Option.isSome(scoreModelSearch(opus, "coplt op")));
  });

  it("rejects results when any query token does not match", () => {
    assert.isTrue(
      Option.isNone(
        scoreModelSearch(model("codex", "Codex", "GPT-5 Codex"), "coplt op")
      )
    );
  });

  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exact = Option.getOrThrow(scoreModelSearch(opus, "copilot opus"));
    const fuzzy = Option.getOrThrow(scoreModelSearch(opus, "coplt op"));

    assert.isTrue(exact < fuzzy);
  });

  it("gives favorite models a strong enough boost for partial queries", () => {
    const favorite = Option.getOrThrow(
      scoreModelSearch(
        model("claude-bridge", "Claude", "Claude Opus 4.7", true),
        "opu"
      )
    );

    const other = Option.getOrThrow(
      scoreModelSearch(model("cursor", "Cursor", "Opus 4.5"), "opu")
    );

    assert.isTrue(favorite < other);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favorite = Option.getOrThrow(
      scoreModelSearch(
        model("claude-bridge", "Claude", "Claude Opus 4.7", true),
        "opus 4.7"
      )
    );

    const exact = Option.getOrThrow(
      scoreModelSearch(model("cursor", "Cursor", "Opus 4.7"), "opus 4.7")
    );

    assert.isTrue(exact < favorite);
  });
});

const instance = (
  provider: string,
  providerName: string,
  names: ReadonlyArray<string>
) => names.map((name) => model(provider, providerName, name));

const catalog: ReadonlyArray<SearchableModel> = [
  ...instance("claude-bridge", "Claude", [
    "Claude Opus 5.5",
    "Claude Sonnet 5.5",
    "Claude Opus 5",
    "Claude Opus 4.8",
    "Claude Opus 4.7",
    "Claude Sonnet 5",
    "Claude Haiku 5.5",
    "Claude Haiku 4.5",
  ]),
  ...instance("openai", "OpenAI", [
    "GPT-6.1 Sol",
    "GPT-6 Luna",
    "GPT-6 Sol",
    "GPT-5.6 Sol",
  ]),
  ...instance("moonshot", "Moonshot", ["Kimi K3", "Kimi K2.5", "Kimi K2"]),
];

const search = (
  query: string,
  models: ReadonlyArray<SearchableModel> = catalog
) => rankModelSearch(models, query, (entry) => entry).map(({ name }) => name);

describe(rankModelSearch, () => {
  it.each([
    [
      "opus",
      [
        "Claude Opus 5.5",
        "Claude Opus 5",
        "Claude Opus 4.8",
        "Claude Opus 4.7",
      ],
    ],
    ["sonnet", ["Claude Sonnet 5.5", "Claude Sonnet 5"]],
    ["haiku", ["Claude Haiku 5.5", "Claude Haiku 4.5"]],
    ["sol", ["GPT-6.1 Sol", "GPT-6 Sol", "GPT-5.6 Sol"]],
    ["kimi", ["Kimi K3", "Kimi K2.5", "Kimi K2"]],
  ])(
    "lists equally good matches for %j in the given order",
    (query, expected) => {
      assert.deepStrictEqual(search(query).slice(0, expected.length), expected);
    }
  );

  it("still ranks an exact name above newer models that extend it", () => {
    assert.deepStrictEqual(search("gpt-6 sol").slice(0, 2), [
      "GPT-6 Sol",
      "GPT-6.1 Sol",
    ]);
    assert.deepStrictEqual(search("claude opus 5").slice(0, 2), [
      "Claude Opus 5",
      "Claude Opus 5.5",
    ]);
  });

  it("matches an exact name regardless of extra whitespace in the query", () => {
    assert.strictEqual(search("  claude   opus 5 ")[0], "Claude Opus 5");
  });

  it("ranks an exact name above a favorite partial match", () => {
    const models = catalog.map((entry) =>
      entry.name === "Claude Opus 5.5" ? { ...entry, isFavorite: true } : entry
    );

    assert.strictEqual(search("claude opus 5", models)[0], "Claude Opus 5");
  });

  it("matches the provider when the name does not", () => {
    assert.deepStrictEqual(search("moonshot"), [
      "Kimi K3",
      "Kimi K2.5",
      "Kimi K2",
    ]);
  });

  it("ranks a favorite above newer models in the same family", () => {
    const models = catalog.map((entry) =>
      entry.name === "Claude Opus 4.7" ? { ...entry, isFavorite: true } : entry
    );

    assert.deepStrictEqual(search("opus", models).slice(0, 2), [
      "Claude Opus 4.7",
      "Claude Opus 5.5",
    ]);
  });

  it("follows the order it is given", () => {
    assert.deepStrictEqual(search("kimi", catalog.toReversed()), [
      "Kimi K2",
      "Kimi K2.5",
      "Kimi K3",
    ]);
  });

  it("lists everything for an empty query", () => {
    assert.strictEqual(search("").length, catalog.length);
  });
});

describe("model picker keys", () => {
  it("round-trips provider and model ids that contain separators", () => {
    const key = modelPickerModelKey("opencode-go", "model:\uDFFF");

    assert.deepStrictEqual(
      parseModelPickerModelKey(key),
      Option.some({ provider: "opencode-go", modelId: "model:\uDFFF" })
    );
  });

  it("keeps colliding concatenations apart", () => {
    assert.notStrictEqual(
      modelPickerModelKey("ab", "c"),
      modelPickerModelKey("a", "bc")
    );
  });

  it("refuses other strings", () => {
    assert.isTrue(Option.isNone(parseModelPickerModelKey("legacy-models:x")));
    assert.isTrue(Option.isNone(parseModelPickerModelKey("model:99:ab")));
  });
});
