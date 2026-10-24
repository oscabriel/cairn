// Building blocks for scripted Claude Code children (`ClaudeSdk.layerTest`): the events one real
// child emits for a text reply and for a tool call, in the order Claude Code sends them with partial
// messages on. Ported in intent from cairn-v1 apps/server/test/fake-claude.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code). Used by the package's tests and judges.

import type { Schema } from "effect";

import type { ClaudeEvent, SdkUsage } from "./ClaudeEvents.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./ClaudeMcp.ts";

/** A session id scripts use when the test does not care which. */
export const SCRIPT_SESSION = "11111111-2222-4333-8444-555555555555";

/** The usage a scripted reply reports: a warm prefix, a small write. */
export const SCRIPT_USAGE: SdkUsage = {
  input_tokens: 3,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 7,
};

/** A subscription child's init message, serving `tools` (pi names). */
export const initEvent = (
  sessionId: string,
  tools: ReadonlyArray<string> = []
): ClaudeEvent => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  apiKeySource: "none",
  tools: tools.map((tool) => `${MCP_TOOL_PREFIX}${tool}`),
  mcp_servers:
    tools.length > 0 ? [{ name: MCP_SERVER_NAME, status: "connected" }] : [],
  model: "claude-scripted",
  cwd: "/",
});

/** One streamed text reply: stream events, the assistant message with chain `uuid`, the result. */
export const textTurn = (
  messageId: string,
  uuid: string,
  text: string
): ReadonlyArray<ClaudeEvent> => [
  {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: messageId, usage: SCRIPT_USAGE },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
  },
  { type: "stream_event", event: { type: "message_stop" } },
  {
    type: "assistant",
    uuid,
    message: { id: messageId, content: [{ type: "text", text }] },
  },
  { type: "result", subtype: "success", is_error: false, result: text },
];

/** One streamed reply that ends on a call to the served pi tool `tool`. */
export const toolTurn = (
  messageId: string,
  uuid: string,
  toolUseId: string,
  tool: string,
  args: Schema.JsonObject = {}
): ReadonlyArray<ClaudeEvent> => [
  {
    type: "stream_event",
    event: {
      type: "message_start",
      message: { id: messageId, usage: SCRIPT_USAGE },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: toolUseId,
        name: `${MCP_TOOL_PREFIX}${tool}`,
        input: {},
      },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    },
  },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 5 },
    },
  },
  { type: "stream_event", event: { type: "message_stop" } },
  {
    type: "assistant",
    uuid,
    message: {
      id: messageId,
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: `${MCP_TOOL_PREFIX}${tool}`,
          input: args,
        },
      ],
    },
  },
];

/** A failed turn in Claude Code's words. */
export const failedTurn = (text: string): ReadonlyArray<ClaudeEvent> => [
  { type: "result", subtype: "success", is_error: true, result: text },
];

/** One served tool call of a multi-block message. */
export interface ToolBlock {
  readonly toolUseId: string;
  readonly tool: string;
  readonly args?: Schema.JsonObject;
  /** The chain uuid of the block's own `assistant` event. */
  readonly uuid: string;
}

const servedBlock = (block: ToolBlock) => ({
  type: "tool_use" as const,
  id: block.toolUseId,
  name: `${MCP_TOOL_PREFIX}${block.tool}`,
  input: block.args ?? {},
});

/** Opens a streamed message. */
export const messageStart = (messageId: string): ClaudeEvent => ({
  type: "stream_event",
  event: {
    type: "message_start",
    message: { id: messageId, usage: SCRIPT_USAGE },
  },
});

/** A tool block's start and the first `cut` characters of its JSON, still open. */
export const toolBlockOpening = (
  index: number,
  block: ToolBlock,
  cut = 0
): ReadonlyArray<ClaudeEvent> => [
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { ...servedBlock(block), input: {} },
    },
  },
  ...(cut > 0
    ? [
        {
          type: "stream_event" as const,
          event: {
            type: "content_block_delta" as const,
            index,
            delta: {
              type: "input_json_delta" as const,
              partial_json: JSON.stringify(block.args ?? {}).slice(0, cut),
            },
          },
        },
      ]
    : []),
];

/** The rest of a tool block after its first `cut` JSON characters, its stop, then its `assistant` event. */
export const toolBlockClosing = (
  messageId: string,
  index: number,
  block: ToolBlock,
  cut = 0
): ReadonlyArray<ClaudeEvent> => [
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.args ?? {}).slice(cut),
      },
    },
  },
  { type: "stream_event", event: { type: "content_block_stop", index } },
  {
    type: "assistant",
    uuid: block.uuid,
    message: { id: messageId, content: [servedBlock(block)] },
  },
];

/**
 * A whole tool block as Claude Code streams it with partial messages on: the block's stream events,
 * then an `assistant` event holding that block alone (one per block, not one per message).
 */
export const toolBlock = (
  messageId: string,
  index: number,
  block: ToolBlock
): ReadonlyArray<ClaudeEvent> => [
  ...toolBlockOpening(index, block),
  ...toolBlockClosing(messageId, index, block),
];

/** Closes a streamed message that ended on tool calls. */
export const toolMessageStop: ReadonlyArray<ClaudeEvent> = [
  {
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 9 },
    },
  },
  { type: "stream_event", event: { type: "message_stop" } },
];

/** Claude Code's non-streaming fallback for a message of tool calls: one `assistant` event per block. */
export const fallbackToolBlocks = (
  messageId: string,
  blocks: ReadonlyArray<ToolBlock>
): ReadonlyArray<ClaudeEvent> =>
  blocks.map((block) => ({
    type: "assistant",
    uuid: block.uuid,
    message: { id: messageId, content: [servedBlock(block)] },
  }));
