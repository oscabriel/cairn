import { describe, expect, it } from "@effect/vitest";

import { providerMarkKind } from "./ProviderMark.ts";

describe("a provider's mark", () => {
  it.each([
    ["claude-bridge", "claude"],
    ["anthropic", "claude"],
    ["openai-codex", "openai"],
    ["openai", "openai"],
    ["opencode-go", "opencode"],
    ["faux", "initial"],
  ] as const)("is drawn for %s as %s", (provider, kind) => {
    expect(providerMarkKind(provider)).toBe(kind);
  });
});
