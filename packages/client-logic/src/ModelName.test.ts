import { assert, describe, it } from "@effect/vitest";

import { condensedModelName } from "./ModelName.ts";

describe(condensedModelName, () => {
  it("names a Claude id by its family and version, without the provider word", () => {
    assert.strictEqual(condensedModelName("claude-opus-5-5"), "Opus 5.5");
    assert.strictEqual(condensedModelName("claude-sonnet-5-5"), "Sonnet 5.5");
    assert.strictEqual(condensedModelName("claude-haiku-5-5"), "Haiku 5.5");
    assert.strictEqual(condensedModelName("claude-fable-5-1"), "Fable 5.1");
    assert.strictEqual(condensedModelName("claude-fable-5"), "Fable 5");
    assert.strictEqual(condensedModelName("claude-opus-4-8"), "Opus 4.8");
    assert.strictEqual(condensedModelName("claude-3-5-sonnet"), "Sonnet 3.5");
  });

  it("drops a context-size suffix, a latest tag and a snapshot date", () => {
    assert.strictEqual(condensedModelName("claude-opus-5-5[1m]"), "Opus 5.5");
    assert.strictEqual(
      condensedModelName("claude-haiku-4-5-20251001"),
      "Haiku 4.5"
    );
    assert.strictEqual(
      condensedModelName("claude-opus-4-5-latest"),
      "Opus 4.5"
    );
  });

  it("keeps any other id as it is, less its suffixes", () => {
    assert.strictEqual(condensedModelName("gpt-6-luna"), "gpt-6-luna");
    assert.strictEqual(condensedModelName("gpt-6.1-sol"), "gpt-6.1-sol");
    assert.strictEqual(condensedModelName("gpt-5.6-terra"), "gpt-5.6-terra");
  });
});
