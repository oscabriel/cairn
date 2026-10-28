// A pi TUI extension the tools-only host's tests load through pi's own loader. It behaves like
// the extensions the host serves where that matters to the host:
//
// - like pi-fff, `fixture_where` answers from the cwd of the last `session_start`, not the call's,
//   so a host that shares one instance between folders gives a call the wrong folder;
// - a tool of each exposure, a tool that asks the user (`ui.confirm`), one that posts a message
//   (`pi.sendMessage`), one with an output schema, and a snippet and guidelines for the section;
// - flags the host sets, an `appendEntry` at session start, and a line in the file the
//   `fixture-log` flag names for each `session_start` and `session_shutdown`.
//
// Imports are types only, so a copy of this directory loads anywhere.

import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const noParameters = { type: "object", properties: {} };

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: { value },
});

/** The fixture's factory, as pi's loader calls it. */
const fixture = (pi: ExtensionAPI) => {
  let startedCwd = "(never started)";

  /** Appends `line` to the file the host's `fixture-log` flag names. */
  const log = (line: string) => {
    const file = String(pi.getFlag("fixture-log") ?? "");

    if (file !== "") {
      appendFileSync(file, `${line}\n`);
    }
  };

  pi.registerFlag("fixture-log", {
    description: "Where the fixture logs its lifecycle.",
    type: "string",
  });

  pi.registerFlag("fixture-flag", {
    description: "Set by the host.",
    type: "string",
    default: "unset",
  });

  pi.on("session_start", (_event, ctx) => {
    startedCwd = ctx.cwd;
    pi.appendEntry("fixture-started", { cwd: ctx.cwd });
    log(`start ${ctx.cwd}`);
  });

  pi.on("session_shutdown", () => {
    log(`shutdown ${startedCwd}`);
  });

  pi.registerTool({
    name: "fixture_where",
    label: "Where",
    description: "Says which folder this instance was started in.",
    promptSnippet: "Say where the fixture runs.",
    promptGuidelines: ["Ask fixture_where before guessing a folder."],
    parameters: {
      type: "object",
      properties: { delayMs: { type: "integer" } },
    },
    executionMode: "parallel",
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.(text("looking"));
      onUpdate?.(text("looking..."));

      await sleep(Number(params.delayMs ?? 0));

      return {
        content: [{ type: "text", text: `started in ${startedCwd}` }],
        details: {
          startedCwd,
          callCwd: ctx.cwd,
          flag: pi.getFlag("fixture-flag") ?? null,
          notJson: Number.NaN,
          skipped: undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "fixture_model_only",
    label: "Model only",
    description: "Offered to the model only.",
    exposure: "model-only",
    parameters: noParameters,
    execute: async () => await Promise.resolve(text("model only")),
  });

  pi.registerTool({
    name: "fixture_codemode",
    label: "Code mode",
    description: "Reached from code mode only.",
    exposure: "codemode",
    parameters: noParameters,
    outputSchema: {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
    },
    executionMode: "sequential",
    execute: async () =>
      await Promise.resolve({
        ...text("forty-two"),
        structuredContent: { answer: 42 },
      }),
  });

  pi.registerTool({
    name: "fixture_deferred",
    label: "Deferred",
    description: "Loaded on demand in pi.",
    exposure: "deferred",
    parameters: noParameters,
    execute: async () => await Promise.resolve(text("deferred")),
  });

  pi.registerTool({
    name: "fixture_hidden",
    label: "Hidden",
    description: "Never offered.",
    exposure: "hidden",
    parameters: noParameters,
    execute: async () => await Promise.resolve(text("hidden")),
  });

  pi.registerTool({
    name: "fixture_confirm",
    label: "Confirm",
    description: "Asks the user first.",
    parameters: noParameters,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const yes = await ctx.ui.confirm("Go on?", "The fixture asks.");

      ctx.ui.notify(`asked; the answer was ${String(yes)}`, "info");

      return text(yes ? "confirmed" : "the user said no");
    },
  });

  pi.registerTool({
    name: "fixture_send",
    label: "Send",
    description: "Posts a message into the session.",
    parameters: noParameters,
    async execute() {
      pi.sendMessage({
        customType: "fixture",
        content: "hello",
        display: true,
      });

      return await Promise.resolve(text("sent"));
    },
  });

  pi.registerTool({
    name: "fixture_rename",
    label: "Rename",
    description: "Renames the session.",
    parameters: noParameters,
    async execute() {
      pi.setSessionName("renamed");

      return await Promise.resolve(text("renamed"));
    },
  });

  pi.registerTool({
    name: "fixture_disabled",
    label: "Disabled",
    description: "Dropped by the test policy.",
    parameters: noParameters,
    execute: async () => await Promise.resolve(text("disabled")),
  });
};

export default fixture;
