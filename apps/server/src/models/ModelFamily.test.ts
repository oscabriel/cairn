// The family table: every provider the user has and the gateways pi knows, read by provider when it
// serves one vendor and by model id otherwise, so a `@judge` on OpenCode Go's `gpt-6-luna` is told
// apart from a `@worker` on the Claude bridge and an unknown vendor never counts as a match.

import { assert, describe, it } from "@effect/vitest";

import { familyOf, sameFamily } from "./ModelFamily.ts";

const ref = (provider: string, modelId: string) => ({ provider, modelId });

describe("model families", () => {
  it("reads the family of each model in the table", () => {
    const table: ReadonlyArray<readonly [string, string, string]> = [
      ["claude-bridge", "claude-opus-5-5", "anthropic"],
      ["claude-bridge", "claude-haiku-5-5", "anthropic"],
      ["anthropic", "claude-sonnet-5-5", "anthropic"],
      ["openai-codex", "gpt-6-luna", "openai"],
      ["openai", "o4-mini", "openai"],
      ["azure", "gpt-6-sol", "openai"],
      ["google", "gemini-4-argon", "google"],
      ["google-vertex", "gemini-3.5-flash", "google"],
      ["opencode-go", "claude-haiku-5-5", "anthropic"],
      ["opencode-go", "gpt-6-luna", "openai"],
      ["opencode-go", "gemini-4-argon-contributor", "google"],
      ["opencode-go", "deepseek-v4.1-flash", "other"],
      ["opencode-go", "qwen3.8-flash", "other"],
      ["opencode-go", "kimi-k3", "other"],
      ["opencode-go", "grok-4.7", "other"],
      ["openrouter", "anthropic/claude-opus-5-5", "anthropic"],
      ["openrouter", "openai/gpt-6-sol", "openai"],
      ["openrouter", "google/gemma-4", "google"],
      ["openrouter", "deepseek/deepseek-v4-pro", "other"],
      ["vercel-ai-gateway", "codex-mini-latest", "openai"],
      ["vercel-ai-gateway", "o4-mini", "openai"],
      ["opencode-go", "gemma-4", "google"],
      ["openrouter", "openai/chatgpt-4o-latest", "openai"],
      ["openrouter", "google/learnlm-2.0-flash", "google"],
      ["amazon-bedrock", "us.anthropic.claude-sonnet-5-5", "anthropic"],
      ["github-copilot", "GPT-6-Luna", "openai"],
      ["faux", "scripted", "other"],
    ];

    for (const [provider, modelId, family] of table) {
      assert.strictEqual(
        familyOf(ref(provider, modelId)),
        family,
        `${provider}/${modelId}`
      );
    }
  });

  it("takes the provider over the id when the provider serves one vendor", () => {
    // A Codex id that mentions Claude is still OpenAI's model.
    assert.strictEqual(
      familyOf(ref("openai-codex", "claude-compat")),
      "openai"
    );
  });

  it("matches the default table's roles: the worker apart from the judge and verifier", () => {
    const worker = ref("claude-bridge", "claude-opus-5-5");
    const judge = ref("opencode-go", "gpt-6-luna");
    const verifier = ref("openai-codex", "gpt-6-luna");

    assert.isFalse(sameFamily(worker, judge));
    assert.isFalse(sameFamily(worker, verifier));
    assert.isTrue(sameFamily(judge, verifier));
    assert.isTrue(sameFamily(worker, ref("opencode-go", "claude-haiku-5-5")));
  });

  it("never counts two unknown vendors as one family", () => {
    assert.isFalse(
      sameFamily(
        ref("opencode-go", "deepseek-v4.1-flash"),
        ref("opencode-go", "qwen3.8-flash")
      )
    );
  });
});
