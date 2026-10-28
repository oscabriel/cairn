// A pi extension that registers a model provider while it loads, which the tools-only host
// refuses: the package must stay off, and the brain must boot without it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The fixture's factory, as pi's loader calls it. */
const provider = (pi: ExtensionAPI) => {
  pi.registerProvider("fixture-provider", {
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    models: [],
  });

  pi.registerTool({
    name: "provider_tool",
    label: "Provider tool",
    description: "Never offered: its package registers a provider.",
    parameters: { type: "object", properties: {} },
    execute: async () =>
      await Promise.resolve({
        content: [{ type: "text", text: "unreachable" }],
        details: null,
      }),
  });
};

export default provider;
