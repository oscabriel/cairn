// SDK messages as they arrive at `ClaudeSdk`'s boundary (shapes from Agent SDK 0.3.305's sdk.d.ts and
// from children observed on the Beelink), decoded into the events the bridge reads.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { decodeClaudeEvent } from "./ClaudeEvents.ts";

const kinds = (messages: ReadonlyArray<object>) =>
  messages.map((message) =>
    Option.match(decodeClaudeEvent(message), {
      onNone: () => "skipped",
      onSome: (event) => event.type,
    })
  );

describe("decoding SDK messages", () => {
  it("reads the messages the bridge needs and ignores extra fields", () => {
    expect(
      kinds([
        {
          type: "system",
          subtype: "init",
          session_id: "s",
          apiKeySource: "none",
          tools: [],
          mcp_servers: [],
          model: "claude-haiku-5-5",
          cwd: "/w",
          permissionMode: "bypassPermissions",
          slash_commands: [],
          skills: [],
          plugins: [],
          uuid: "x",
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          },
          parent_tool_use_id: null,
          uuid: "y",
          session_id: "s",
        },
        {
          type: "assistant",
          uuid: "u1",
          parent_tool_use_id: null,
          session_id: "s",
          message: {
            id: "msg_1",
            model: "claude-haiku-5-5",
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "server_tool_use", id: "t" },
            ],
            usage: {
              input_tokens: 2,
              cache_creation: {
                ephemeral_1h_input_tokens: 0,
                ephemeral_5m_input_tokens: 10,
              },
            },
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "hi",
          modelUsage: {
            "claude-haiku-5-5": { contextWindow: 1_000_000, costUSD: 0 },
          },
        },
        {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.2,
          },
          uuid: "z",
          session_id: "s",
        },
      ])
    ).toStrictEqual([
      "system",
      "stream_event",
      "assistant",
      "result",
      "rate_limit_event",
    ]);
  });

  it("skips message types the bridge does not read", () => {
    expect(
      kinds([
        { type: "system", subtype: "hook_started", hook_name: "SessionStart" },
        { type: "tool_progress", tool_use_id: "t" },
        { type: "stream_event" },
      ])
    ).toStrictEqual(["skipped", "skipped", "skipped"]);
  });

  it("keeps an unknown streaming event or block type readable as a type alone", () => {
    expect(
      kinds([
        { type: "stream_event", event: { type: "ping" } },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "redacted_thinking", data: "x" },
          },
        },
      ])
    ).toStrictEqual(["stream_event", "stream_event"]);
  });
});

describe("the bridge's own files", () => {
  // Cairn never writes or rebuilds a Claude Code transcript: no module here writes a file.
  it("never write to disk", () => {
    const dir = import.meta.dirname;

    const writers = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) =>
        /\b(?:writeFile|appendFile|mkdir|rename|unlink|rm|createWriteStream|copyFile)(?:Sync)?\b/u.test(
          readFileSync(path.join(dir, file), "utf-8")
        )
      );

    expect(writers).toStrictEqual([]);
  });
});
