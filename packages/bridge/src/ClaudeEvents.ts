// The part of the Agent SDK's message stream the bridge reads, as Cairn schemas. `ClaudeSdk` decodes
// every SDK message through `decodeClaudeEvent` at its boundary (coding standard S10), so nothing past
// it sees an SDK type. Field names keep the SDK's spelling, because these schemas describe its wire.
// A message type the bridge does not read fails to decode and is skipped.
import { Schema } from "effect";

const Count = Schema.optional(Schema.NullOr(Schema.Finite));

/** The usage counters Claude Code reports on `message_start`, `message_delta` and assistant messages. */
export const SdkUsage = Schema.Struct({
  input_tokens: Count,
  output_tokens: Count,
  cache_read_input_tokens: Count,
  cache_creation_input_tokens: Count,
  cache_creation: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ephemeral_1h_input_tokens: Count,
        ephemeral_5m_input_tokens: Count,
      })
    )
  ),
  output_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ thinking_tokens: Count }))
  ),
});

/** One usage frame. */
export type SdkUsage = typeof SdkUsage.Type;

/** The child's `system:init` message: who it runs as and what it can call. */
export const InitEvent = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: Schema.String,
  apiKeySource: Schema.String,
  tools: Schema.Array(Schema.String),
  mcp_servers: Schema.Array(
    Schema.Struct({ name: Schema.String, status: Schema.String })
  ),
  model: Schema.String,
  cwd: Schema.String,
  claude_code_version: Schema.optional(Schema.String),
});

/** Claude Code is about to retry an API request after `retry_delay_ms`; the stream is quiet until then. */
export const ApiRetryEvent = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("api_retry"),
  attempt: Schema.Finite,
  retry_delay_ms: Schema.Finite,
});

const TextBlockStart = Schema.Struct({ type: Schema.Literal("text") });

const ThinkingBlockStart = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
});

const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.optional(Schema.Json),
});

const OtherBlock = Schema.Struct({ type: Schema.String });

const StreamMessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({
    id: Schema.optional(Schema.String),
    usage: Schema.optional(SdkUsage),
  }),
});

const StreamBlockStart = Schema.Struct({
  type: Schema.Literal("content_block_start"),
  index: Schema.Finite,
  content_block: Schema.Union([
    TextBlockStart,
    ThinkingBlockStart,
    ToolUseBlock,
    OtherBlock,
  ]),
});

const StreamBlockDelta = Schema.Struct({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Finite,
  delta: Schema.Union([
    Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("thinking_delta"),
      thinking: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("input_json_delta"),
      partial_json: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("signature_delta"),
      signature: Schema.String,
    }),
    Schema.Struct({ type: Schema.String }),
  ]),
});

const StreamBlockStop = Schema.Struct({
  type: Schema.Literal("content_block_stop"),
  index: Schema.Finite,
});

const StreamMessageDelta = Schema.Struct({
  type: Schema.Literal("message_delta"),
  delta: Schema.Struct({
    stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  usage: Schema.optional(Schema.NullOr(SdkUsage)),
});

const StreamMessageStop = Schema.Struct({
  type: Schema.Literal("message_stop"),
});

/** One Anthropic streaming event, as far as the bridge reads it. */
export const StreamEvent = Schema.Union([
  StreamMessageStart,
  StreamBlockStart,
  StreamBlockDelta,
  StreamBlockStop,
  StreamMessageDelta,
  StreamMessageStop,
  Schema.Struct({ type: Schema.String }),
]);

/** One streaming event. */
export type StreamEvent = typeof StreamEvent.Type;

/** A streamed fragment of the reply (`includePartialMessages`). Subagent frames carry a parent id. */
export const PartialEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: StreamEvent,
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
});

/** A completed assistant block. */
export const AssistantBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("thinking"),
    thinking: Schema.optional(Schema.String),
    signature: Schema.optional(Schema.String),
  }),
  ToolUseBlock,
  OtherBlock,
]);

/** A completed assistant block. */
export type AssistantBlock = typeof AssistantBlock.Type;

/**
 * A completed assistant message. `uuid` is its place in Claude Code's transcript chain: the stamp
 * records the last one of a reply, and a resume cuts there.
 */
export const AssistantEvent = Schema.Struct({
  type: Schema.Literal("assistant"),
  uuid: Schema.String,
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.Struct({
    id: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    content: Schema.Array(AssistantBlock),
    usage: Schema.optional(Schema.NullOr(SdkUsage)),
  }),
});

/** A user message as Claude Code echoes it: a prompt, or the tool results its MCP calls returned. */
export const UserEvent = Schema.Struct({
  type: Schema.Literal("user"),
  uuid: Schema.optional(Schema.String),
});

/** The turn's outcome: success, or a failure in Claude Code's words. */
export const ResultEvent = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
  modelUsage: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ contextWindow: Schema.optional(Schema.Finite) })
    )
  ),
});

/** One reading of the plan windows, from a `rate_limit_event`. Utilization is 0 to 1; resets are epoch seconds. */
export const RateLimitInfo = Schema.Struct({
  status: Schema.String,
  resetsAt: Schema.optional(Schema.Finite),
  rateLimitType: Schema.optional(Schema.String),
  utilization: Schema.optional(Schema.Finite),
  isUsingOverage: Schema.optional(Schema.Boolean),
  overageInUse: Schema.optional(Schema.Boolean),
});

/** One plan-window reading. */
export type RateLimitInfo = typeof RateLimitInfo.Type;

/** A plan-window reading that arrived during a turn. */
export const RateLimitEvent = Schema.Struct({
  type: Schema.Literal("rate_limit_event"),
  rate_limit_info: RateLimitInfo,
});

/** Every SDK message the bridge reads. */
export const ClaudeEvent = Schema.Union([
  InitEvent,
  ApiRetryEvent,
  PartialEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  RateLimitEvent,
]);

/** One SDK message the bridge reads. */
export type ClaudeEvent = typeof ClaudeEvent.Type;

/** Decodes one SDK message; none for a message type the bridge does not read. */
export const decodeClaudeEvent = Schema.decodeUnknownOption(ClaudeEvent);
