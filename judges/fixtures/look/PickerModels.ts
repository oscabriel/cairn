// The model picker's look state lists more than the faux model: a slice of the deployed brain's
// catalog on 2026-10-31 (the bridge's Claude models, OpenCode Go and OpenAI Codex, names from
// `~/.pi/agent/models-store.json`), so the shot shows a rail of several providers and a provider
// whose list scrolls. Only the picker sees them; the look app still runs on the faux model.

import { ModelListing } from "@cairn/protocol/Models";
import { Schema } from "effect";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

const listingsOf = (
  provider: string,
  names: ReadonlyArray<readonly [string, string]>
) =>
  names.map(([modelId, name]) =>
    Schema.decodeSync(ModelListing)({
      provider,
      modelId,
      name,
      thinkingLevels: ALL_LEVELS,
      acceptsImages: true,
      contextWindow: 200_000,
      available: true,
    })
  );

export const PICKER_MODELS: ReadonlyArray<ModelListing> = [
  ...listingsOf("claude-bridge", [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude-fable-5-1", "Claude Fable 5.1"],
  ]),
  ...listingsOf("opencode-go", [
    ["gpt-6-luna", "GPT-6 Luna"],
    ["kimi-k3", "Kimi K3"],
    ["kimi-k3.1-pro", "Kimi K3.1 Pro"],
    ["glm-5.3", "GLM-5.3"],
    ["glm-5.3-flash", "GLM-5.3-Flash"],
    ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
    ["qwen3.8-max", "Qwen3.8 Max"],
    ["minimax-m3", "MiniMax-M3"],
    ["gemini-4-argon", "Gemini 4 Argon"],
    ["grok-4.7", "Grok 4.7"],
  ]),
  ...listingsOf("openai-codex", [
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-sol", "GPT-6 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ]),
];
