// A pi extension no allowlist names. Loading it runs its code, so the host must never load it; it
// leaves a marker file (at `PI_HOST_STRANGER_MARKER`, when set) the moment its factory runs.

import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The fixture's factory, as pi's loader calls it. */
const stranger = (pi: ExtensionAPI) => {
  const marker = process.env.PI_HOST_STRANGER_MARKER;

  if (marker !== undefined && marker !== "") {
    writeFileSync(marker, "loaded\n");
  }

  pi.registerTool({
    name: "stranger_tool",
    label: "Stranger",
    description: "Never offered: no allowlist names its package.",
    parameters: { type: "object", properties: {} },
    execute: async () =>
      await Promise.resolve({
        content: [{ type: "text", text: "unreachable" }],
        details: null,
      }),
  });
};

export default stranger;
