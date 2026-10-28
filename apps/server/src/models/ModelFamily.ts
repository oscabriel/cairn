// Ported from github.com/humanlayer/fold, packages/fold-core/src/Model/ModelFamily.ts at
// 4bd8c58c4c644ad43df573c156ecdf8bddedd04d. Kept: the provider decides first, then the model id for
// providers that serve many vendors (openrouter-style `vendor/model` ids included). Changed: the
// families are Cairn's (`anthropic`, `openai`, `google`, `other`), keyed by pi's provider ids, for
// the rule that a judge or verifier does not share the worker's family (ADR 0035).
//
// MIT License. Copyright (c) 2026 HumanLayer
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { ModelRef } from "@cairn/protocol/Models";
import type { ModelFamily } from "@cairn/protocol/Roles";

/**
 * Providers that serve one vendor's models only, so the provider alone names the family. Every
 * other provider (OpenCode Go, OpenRouter, Bedrock, a gateway) is read by its model id.
 */
const VENDOR_PROVIDERS = new Map<string, ModelFamily>([
  ["anthropic", "anthropic"],
  ["claude-bridge", "anthropic"],
  ["openai", "openai"],
  ["openai-codex", "openai"],
  ["azure", "openai"],
  ["google", "google"],
  ["google-vertex", "google"],
]);

/** The vendor prefix of an openrouter-style id (`anthropic/claude-...`), when it names a family. */
const VENDOR_PREFIXES = new Map<string, ModelFamily>([
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["google", "google"],
]);

/**
 * Model ids by family, for providers that serve many vendors. `claude` anywhere covers Bedrock's
 * `us.anthropic.claude-...`; OpenAI's are `gpt-...`, `o<digit>...` and `codex`; Google's `gemini`
 * and `gemma`.
 */
const ID_PATTERNS: ReadonlyArray<readonly [RegExp, ModelFamily]> = [
  [/claude/u, "anthropic"],
  [/^(?:gpt|o\d)|codex/u, "openai"],
  [/^(?:gemini|gemma)/u, "google"],
];

/**
 * The family a model belongs to: by its provider when the provider serves one vendor, otherwise by
 * its id, and `other` when neither says (DeepSeek, Qwen, GLM, Kimi and the like).
 */
export const familyOf = (model: ModelRef): ModelFamily => {
  const byProvider = VENDOR_PROVIDERS.get(model.provider);

  if (byProvider !== undefined) {
    return byProvider;
  }

  const id = model.modelId.toLowerCase();
  const slash = id.indexOf("/");

  if (slash !== -1) {
    const byPrefix = VENDOR_PREFIXES.get(id.slice(0, slash));

    if (byPrefix !== undefined) {
      return byPrefix;
    }
  }

  const bare = slash === -1 ? id : id.slice(slash + 1);

  for (const [pattern, family] of ID_PATTERNS) {
    if (pattern.test(bare)) {
      return family;
    }
  }

  return "other";
};

/** Whether two models share a family; two `other` models are not counted as the same family. */
export const sameFamily = (a: ModelRef, b: ModelRef): boolean => {
  const family = familyOf(a);

  return family !== "other" && family === familyOf(b);
};
