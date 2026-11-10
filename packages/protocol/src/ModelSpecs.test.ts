// The model spec pattern: a `provider/model` whose model id may hold `@` (a Workers AI id such as
// `@cf/meta/...`), `~`, `/` and `:` (OpenRouter's aliases and tiers, Bedrock's versions), with an
// optional thinking suffix. The server's `ModelSpecs.test.ts` reads back every id pi-ai lists. A role name (`@worker`) is no spec: the
// records that held one were migrated when roles were retired (ADR 0052), so nothing decodes one.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { ModelSpec } from "./ModelSpecs.ts";

const decodes = Schema.is(ModelSpec);

describe("a model spec", () => {
  it("is a model with an optional thinking suffix", () => {
    assert.deepStrictEqual(
      [
        "opencode-go/gpt-6-luna",
        "opencode-go/gpt-6-luna:low",
        "cloudflare-workers-ai/@cf/meta/llama-4-scout",
        "cloudflare-workers-ai/@cf/meta/llama-4-scout:low",
      ].map(decodes),
      [true, true, true, true]
    );
  });

  it("takes a model id holding ~, / and : as pi-ai's catalog lists them", () => {
    assert.deepStrictEqual(
      [
        "openrouter/~anthropic/claude-haiku-latest",
        "openrouter/~anthropic/claude-haiku-latest:high",
        "openrouter/google/gemma-4-31b-it:free",
        "amazon-bedrock/us.amazon.nova-pro-v1:0:low",
      ].map(decodes),
      [true, true, true, true]
    );
  });

  it("refuses a model with no provider and a role name", () => {
    assert.deepStrictEqual(
      ["gpt-6-luna", "@worker", "@worker:high", "@cf/meta/llama-4-scout"].map(
        decodes
      ),
      [false, false, false, false]
    );
  });
});
