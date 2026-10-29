// Ported from elidickinson/pi-claude-bridge, src/index.ts (lines 1139-1610: processStreamEvent,
// processAssistantMessage, the drop helpers and consumeQuery's result handling) and src/query-state.ts
// at 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1 apps/server/src/claude/{stream.ts,
// query-state.ts} at 1a5cd4a56e84bfb187940428d144b584d2e084b0. Behaviour kept: stream events map onto
// pi-ai's event protocol; a tool call is dispatched only once its block closes; a stream Claude Code
// abandoned mid-message has its unfinished blocks dropped; a `<synthetic>` assistant message is a
// report, not output; Claude Code's non-streaming fallback is delivered; a rate-limit rejection
// names the failure that follows it. Changed: it reads decoded `ClaudeEvent`s, not SDK types; it
// records each assistant message's chain uuid (the stamp's resume point) and ends a tool-use turn
// only once that uuid is known; a streamed tool-use turn ends on `message_stop`, never on the
// first served tool call, because Claude Code starts a call as its block closes while sibling
// blocks are still streaming; `pending` and `deferred` stop reasons and `cacheWrite1h` are new in
// pi-ai 1.4.0; there are no module singletons; the bash timeout default is gone (pi-durable owns it).
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { Option, Predicate, Schema } from "effect";

import type {
  AssistantBlock,
  ClaudeEvent,
  RateLimitInfo,
  StreamEvent,
} from "./ClaudeEvents.ts";
import { claudeFailureText, planQuotaExceededText } from "./ClaudeGuards.ts";
import type { ToolDeclaration } from "./ClaudeMcp.ts";
import { piToolName } from "./ClaudeMcp.ts";
import { applyUsage, emptyUsage } from "./ClaudeTokens.ts";

/** Where a turn's pi events go: the stream one provider call returned. */
export type TurnSink = AssistantMessageEventStream;

/** What a turn writes to: a sink, or a writer that forwards to one (the conversation's done gate). */
export type TurnWriter = Pick<TurnSink, "push" | "end">;

/** Called with the final message of a delivered reply, just before its `done` event, to stamp it. */
export type StampReply = (message: AssistantMessage) => void;

/** How a turn ended, for the conversation that owns the child. */
export type TurnEnd =
  | { readonly kind: "tool-use"; readonly toolCallIds: ReadonlyArray<string> }
  | { readonly kind: "done" }
  | {
      readonly kind: "failed";
      readonly rejected: Option.Option<RateLimitInfo>;
    };

/** What handling one event did. */
export type EventEffect =
  | { readonly kind: "none" }
  | { readonly kind: "init"; readonly sessionId: string }
  | { readonly kind: "rate-limit"; readonly info: RateLimitInfo }
  | { readonly kind: "api-retry"; readonly delayMs: number }
  | { readonly kind: "ended"; readonly end: TurnEnd }
  /** A successful `result` with no provider call open: the query finished a round pi was not in. */
  | { readonly kind: "unattached-result" };

const NONE: EventEffect = { kind: "none" };

/** Renames for Claude Code argument names that differ from pi's own; other keys pass through. */
const argumentRenames = (toolName: string, key: string): string => {
  const tool = toolName.toLowerCase();

  if (
    key === "file_path" &&
    (tool === "read" || tool === "write" || tool === "edit")
  ) {
    return "path";
  }

  if (tool === "edit") {
    if (key === "old_string" || key === "old_text") {
      return "oldText";
    }

    if (key === "new_string" || key === "new_text") {
      return "newText";
    }
  }

  return key;
};

/** Tool arguments in pi's names; the first alias of a key wins. */
export const mapToolArguments = (
  toolName: string,
  args: JsonObject
): JsonObject => {
  const entries: Array<readonly [string, JsonObject[string]]> = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(args)) {
    const name = argumentRenames(toolName, key);

    if (!seen.has(name)) {
      seen.add(name);
      entries.push([name, value]);
    }
  }

  return Object.fromEntries(entries);
};

const decodeArguments = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const jsonObject = (
  value: Schema.Json | undefined
): Option.Option<JsonObject> =>
  value !== undefined && isJsonObject(value)
    ? Option.some(value)
    : Option.none();

const parseArguments = (text: string, fallback: JsonObject): JsonObject =>
  text.length === 0
    ? fallback
    : Option.getOrElse(decodeArguments(text), () => fallback);

/** A block of the turn still open in the stream: its stream index and the tool JSON received so far. */
interface OpenBlock {
  readonly streamIndex: number;
  partialJson: string;
}

const stopReasonOf = (reason: string): AssistantMessage["stopReason"] => {
  switch (reason) {
    case "tool_use": {
      return "toolUse";
    }

    case "max_tokens":
    case "model_context_window_exceeded": {
      return "length";
    }

    default: {
      return "stop";
    }
  }
};

/**
 * One Claude Code query's event mapping. It survives across the pi provider calls of one held query:
 * `begin` swaps in the next call's sink, and the query-scoped state (the session id, the last chain
 * uuid, the turn's tool call ids) carries over.
 */
export class ClaudeStream {
  /** Claude Code's session id, from `system:init`. */
  sessionId: Option.Option<string> = Option.none();

  /** The chain uuid of the newest top-level assistant message: where a resume of this reply cuts. */
  lastUuid: Option.Option<string> = Option.none();

  /** The tool_use ids of the current assistant message; a delivered result routes by them. */
  toolCallIds: ReadonlyArray<string> = [];

  readonly #model: Model<Api>;
  readonly #tools: ReadonlyArray<ToolDeclaration>;
  readonly #stamp: StampReply;

  #sink: Option.Option<TurnWriter> = Option.none();
  #output: AssistantMessage;
  #open: Array<OpenBlock | undefined> = [];
  #started = false;
  #sawStreamEvent = false;
  #sawToolCall = false;
  #streamMessageId: Option.Option<string> = Option.none();
  #streamOpen = false;
  #streamBlockStart = 0;
  #messageStopped = false;
  #toolUseSeen = new Set<string>();
  /** The message id of a non-streaming fallback message being delivered block by block. */
  #fallbackId: Option.Option<string> = Option.none();
  /** Served tool calls Claude Code has made during this turn. */
  #callsArrived = new Set<string>();
  #rejection: Option.Option<RateLimitInfo> = Option.none();

  constructor(
    model: Model<Api>,
    tools: ReadonlyArray<ToolDeclaration>,
    stamp: StampReply
  ) {
    this.#model = model;
    this.#tools = tools;
    this.#stamp = stamp;
    this.#output = this.#freshOutput(0);
  }

  /** The reply being assembled. */
  get output(): AssistantMessage {
    return this.#output;
  }

  /** Whether a provider call is waiting on this query. */
  get open(): boolean {
    return Option.isSome(this.#sink);
  }

  #freshOutput(timestamp: number): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: this.#model.api,
      provider: this.#model.provider,
      model: this.#model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp,
    };
  }

  /** Starts a turn on `sink`; `timestamp` is epoch milliseconds from the caller's clock. */
  begin(sink: TurnWriter, timestamp: number): void {
    // A rejection belongs to the turn it arrived in: a stale one would label a later, unrelated
    // failure a spent plan window (T13).
    this.#rejection = Option.none();
    this.#sink = Option.some(sink);
    this.#output = this.#freshOutput(timestamp);
    this.#open = [];
    this.#started = false;
    this.#sawStreamEvent = false;
    this.#sawToolCall = false;
    this.#streamMessageId = Option.none();
    this.#streamOpen = false;
    this.#streamBlockStart = 0;
    this.#messageStopped = false;
    this.#toolUseSeen = new Set();
    this.#fallbackId = Option.none();
    this.#callsArrived = new Set();
  }

  #push(event: Parameters<TurnWriter["push"]>[0]): void {
    if (Option.isSome(this.#sink)) {
      this.#sink.value.push(event);
    }
  }

  #ensureStarted(): void {
    if (!this.#started && Option.isSome(this.#sink)) {
      this.#started = true;
      this.#push({ type: "start", partial: this.#output });
    }
  }

  #end(): void {
    if (Option.isSome(this.#sink)) {
      this.#sink.value.end();
    }

    this.#sink = Option.none();
  }

  /** Ends the turn as a failure: `aborted` for an abort, `error` otherwise. */
  fail(reason: "aborted" | "error", text: string): void {
    if (Option.isNone(this.#sink)) {
      return;
    }

    this.#ensureStarted();
    this.#output.stopReason = reason;
    this.#output.errorMessage = text;
    this.#push({ type: "error", reason, error: this.#output });
    this.#end();
  }

  /** Ends the turn as delivered: stamps the reply, then `done`. */
  #done(reason: "stop" | "length" | "toolUse"): void {
    if (Option.isNone(this.#sink)) {
      return;
    }

    this.#ensureStarted();
    this.#output.stopReason = reason;

    if (
      this.#output.responseId === undefined &&
      Option.isSome(this.#streamMessageId)
    ) {
      this.#output.responseId = this.#streamMessageId.value;
    }

    this.#stamp(this.#output);
    this.#push({ type: "done", reason, message: this.#output });
    this.#end();
  }

  #endedToolUse(): EventEffect {
    this.#done("toolUse");

    return {
      kind: "ended",
      end: { kind: "tool-use", toolCallIds: this.toolCallIds },
    };
  }

  /**
   * Ends a streamed tool-use turn once its message has stopped and every call's own `assistant` event
   * (which carries the chain uuid the stamp cuts at) has arrived. Unfinished blocks were dropped at
   * `message_stop`, so no call reaches pi with partial arguments.
   */
  #endToolUse(): EventEffect {
    const allSeen = this.toolCallIds.every((id) => this.#toolUseSeen.has(id));

    if (!this.#sawToolCall || !this.open || !this.#messageStopped || !allSeen) {
      return NONE;
    }

    return this.#endedToolUse();
  }

  /**
   * Ends a fallback tool-use turn. A fallback message has no `message_stop`, so the turn ends once
   * Claude Code has called one of its delivered tools: it dispatches a call only after emitting the
   * call's block. A block emitted after that call is lost to this turn; the conversation treats its
   * call as an orphan.
   */
  #endFallback(): EventEffect {
    if (
      !this.open ||
      !this.toolCallIds.some((id) => this.#callsArrived.has(id))
    ) {
      return NONE;
    }

    return this.#endedToolUse();
  }

  /**
   * Claude Code called the served tool `toolUseId`. A streamed message keeps going (the call is
   * parked until pi delivers its result); a fallback message ends here.
   */
  toolCallArrived(toolUseId: string): EventEffect {
    this.#callsArrived.add(toolUseId);

    return Option.isSome(this.#fallbackId) ? this.#endFallback() : NONE;
  }

  #dropUnfinished(): void {
    for (
      let index = this.#output.content.length - 1;
      index >= this.#streamBlockStart;
      index -= 1
    ) {
      if (this.#open[index] !== undefined) {
        this.#output.content.splice(index, 1);
        this.#open.splice(index, 1);
      }
    }

    this.#recountToolCalls();
  }

  #dropAbandoned(): void {
    this.#output.content.splice(this.#streamBlockStart);
    this.#open.splice(this.#streamBlockStart);
    this.#streamOpen = false;
    this.#recountToolCalls();
  }

  #recountToolCalls(): void {
    const calls = this.#output.content.filter(
      (block): block is ToolCall => block.type === "toolCall"
    );

    this.toolCallIds = calls.map((call) => call.id);
    this.#sawToolCall = calls.length > 0;
  }

  #indexOfStream(streamIndex: number): number {
    return this.#open.findIndex((block) => block?.streamIndex === streamIndex);
  }

  #onStream(event: StreamEvent): EventEffect {
    if (!this.open) {
      return NONE;
    }

    this.#sawStreamEvent = true;

    if ("message" in event && event.type === "message_start") {
      // Still open from an earlier message_start: Claude Code gave up on that stream and retries it.
      if (this.#streamOpen) {
        this.#dropAbandoned();
      }

      this.toolCallIds = [];
      this.#fallbackId = Option.none();
      this.#streamMessageId = Option.fromNullishOr(event.message.id);
      this.#streamOpen = true;
      this.#messageStopped = false;
      this.#streamBlockStart = this.#output.content.length;

      if (event.message.usage !== undefined) {
        applyUsage(this.#output.usage, event.message.usage);
      }

      return NONE;
    }

    if ("content_block" in event) {
      return this.#onBlockStart(event.index, event.content_block);
    }

    if ("delta" in event && event.type === "content_block_delta") {
      return this.#onBlockDelta(event.index, event.delta);
    }

    if ("index" in event && event.type === "content_block_stop") {
      return this.#onBlockStop(event.index);
    }

    if ("delta" in event && event.type === "message_delta") {
      this.#output.stopReason = stopReasonOf(
        event.delta.stop_reason ?? "end_turn"
      );

      if (event.usage !== undefined && event.usage !== null) {
        applyUsage(this.#output.usage, event.usage);
      }

      return NONE;
    }

    if (event.type === "message_stop") {
      this.#dropUnfinished();
      this.#streamOpen = false;
      this.#messageStopped = true;

      return this.#endToolUse();
    }

    return NONE;
  }

  #onBlockStart(index: number, block: AssistantBlock): EventEffect {
    if (block.type === "text") {
      this.#ensureStarted();
      this.#output.content.push({ type: "text", text: "" });
      this.#open.push({ streamIndex: index, partialJson: "" });
      this.#push({
        type: "text_start",
        contentIndex: this.#output.content.length - 1,
        partial: this.#output,
      });

      return NONE;
    }

    if (block.type === "thinking") {
      this.#ensureStarted();
      this.#output.content.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: "",
      });
      this.#open.push({ streamIndex: index, partialJson: "" });
      this.#push({
        type: "thinking_start",
        contentIndex: this.#output.content.length - 1,
        partial: this.#output,
      });

      return NONE;
    }

    if ("id" in block && block.type === "tool_use") {
      const name = piToolName(block.name, this.#tools);

      // An unserved name is the model reaching for a builtin; Claude Code rejects it and retries.
      if (Option.isNone(name)) {
        return NONE;
      }

      this.#ensureStarted();
      this.toolCallIds = [...this.toolCallIds, block.id];
      this.#output.content.push({
        type: "toolCall",
        id: block.id,
        name: name.value,
        arguments: Option.getOrElse(jsonObject(block.input), () => ({})),
      });
      this.#open.push({ streamIndex: index, partialJson: "" });
      this.#push({
        type: "toolcall_start",
        contentIndex: this.#output.content.length - 1,
        partial: this.#output,
      });
    }

    return NONE;
  }

  #onBlockDelta(
    index: number,
    delta: Extract<
      StreamEvent,
      { readonly type: "content_block_delta" }
    >["delta"]
  ): EventEffect {
    const contentIndex = this.#indexOfStream(index);
    const block = this.#output.content[contentIndex];
    const open = this.#open[contentIndex];

    if (block === undefined || open === undefined) {
      return NONE;
    }

    if ("text" in delta && block.type === "text") {
      block.text += delta.text;
      this.#push({
        type: "text_delta",
        contentIndex,
        delta: delta.text,
        partial: this.#output,
      });
    } else if ("thinking" in delta && block.type === "thinking") {
      block.thinking += delta.thinking;
      this.#push({
        type: "thinking_delta",
        contentIndex,
        delta: delta.thinking,
        partial: this.#output,
      });
    } else if ("partial_json" in delta && block.type === "toolCall") {
      // Parsed once, at the block's stop: the JSON only decodes whole, so parsing the growing
      // text on every delta was quadratic and never yielded anything earlier (T52).
      open.partialJson += delta.partial_json;
      this.#push({
        type: "toolcall_delta",
        contentIndex,
        delta: delta.partial_json,
        partial: this.#output,
      });
    } else if ("signature" in delta && block.type === "thinking") {
      block.thinkingSignature = `${block.thinkingSignature ?? ""}${delta.signature}`;
    }

    return NONE;
  }

  #onBlockStop(index: number): EventEffect {
    const contentIndex = this.#indexOfStream(index);
    const block = this.#output.content[contentIndex];
    const open = this.#open[contentIndex];

    if (block === undefined || open === undefined) {
      return NONE;
    }

    this.#open[contentIndex] = undefined;

    if (block.type === "text") {
      this.#push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: this.#output,
      });
    } else if (block.type === "thinking") {
      this.#push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: this.#output,
      });
    } else {
      this.#sawToolCall = true;
      block.arguments = mapToolArguments(
        block.name,
        parseArguments(open.partialJson, block.arguments)
      );
      this.#push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial: this.#output,
      });
    }

    return NONE;
  }

  #onAssistant(
    event: Extract<ClaudeEvent, { readonly type: "assistant" }>
  ): EventEffect {
    // Subagent frames belong to Claude Code's own Agent tool, which a child never has.
    if (
      event.parent_tool_use_id !== undefined &&
      event.parent_tool_use_id !== null
    ) {
      return NONE;
    }

    this.lastUuid = Option.some(event.uuid);

    for (const block of event.message.content) {
      if ("id" in block && block.type === "tool_use") {
        this.#toolUseSeen.add(block.id);
      }
    }

    if (!this.open) {
      return NONE;
    }

    const { usage } = event.message;

    // A `<synthetic>` message is Claude Code's report of a failure, not model output: keep its words
    // for the failed turn, emit nothing.
    if (event.message.model === "<synthetic>") {
      if (this.#sawStreamEvent && this.#streamOpen) {
        this.#dropAbandoned();
      }

      return NONE;
    }

    if (this.#sawStreamEvent) {
      // The same id was streamed already. A new id while the stream is open is Claude Code's
      // non-streaming fallback for a stalled stream: deliver it.
      const id = Option.fromNullishOr(event.message.id);

      const fallback =
        Option.isSome(id) &&
        Option.isSome(this.#streamMessageId) &&
        id.value !== this.#streamMessageId.value;

      if (!fallback) {
        return this.#endToolUse();
      }

      if (this.#streamOpen) {
        this.#dropAbandoned();
      }
    }

    // Claude Code emits one `assistant` event per block, so a message's calls arrive over several
    // events that share its id.
    const messageId = event.message.id ?? event.uuid;

    if (
      Option.isNone(this.#fallbackId) ||
      this.#fallbackId.value !== messageId
    ) {
      this.toolCallIds = [];
      this.#fallbackId = Option.some(messageId);
    }

    this.#deliverBlocks(event.message.content);

    if (usage !== undefined && usage !== null) {
      applyUsage(this.#output.usage, usage);
    }

    this.#messageStopped = true;

    return this.#endFallback();
  }

  #deliverBlocks(blocks: ReadonlyArray<AssistantBlock>): void {
    for (const block of blocks) {
      if ("text" in block && block.type === "text" && block.text.length > 0) {
        this.#ensureStarted();
        this.#output.content.push({ type: "text", text: block.text });
        this.#open.push(undefined);

        const contentIndex = this.#output.content.length - 1;

        this.#push({ type: "text_start", contentIndex, partial: this.#output });
        this.#push({
          type: "text_delta",
          contentIndex,
          delta: block.text,
          partial: this.#output,
        });
        this.#push({
          type: "text_end",
          contentIndex,
          content: block.text,
          partial: this.#output,
        });
      } else if (block.type === "thinking" && "thinking" in block) {
        this.#ensureStarted();

        const thinking = block.thinking ?? "";

        this.#output.content.push({
          type: "thinking",
          thinking,
          thinkingSignature: block.signature ?? "",
        });
        this.#open.push(undefined);

        const contentIndex = this.#output.content.length - 1;

        this.#push({
          type: "thinking_start",
          contentIndex,
          partial: this.#output,
        });
        this.#push({
          type: "thinking_end",
          contentIndex,
          content: thinking,
          partial: this.#output,
        });
      } else if ("id" in block && block.type === "tool_use") {
        this.#deliverToolUse(block.id, block.name, block.input);
      }
    }
  }

  #deliverToolUse(
    id: string,
    servedName: string,
    input: Schema.Json | undefined
  ): void {
    const name = piToolName(servedName, this.#tools);

    if (Option.isNone(name)) {
      return;
    }

    this.#ensureStarted();
    this.#sawToolCall = true;
    this.toolCallIds = [...this.toolCallIds, id];

    const toolCall: ToolCall = {
      type: "toolCall",
      id,
      name: name.value,
      arguments: mapToolArguments(
        name.value,
        Option.getOrElse(jsonObject(input), () => ({}))
      ),
    };

    this.#output.content.push(toolCall);
    this.#open.push(undefined);

    const contentIndex = this.#output.content.length - 1;

    this.#push({ type: "toolcall_start", contentIndex, partial: this.#output });
    this.#push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: this.#output,
    });
  }

  #onResult(
    event: Extract<ClaudeEvent, { readonly type: "result" }>
  ): EventEffect {
    const failed = event.subtype !== "success" || event.is_error === true;

    if (failed) {
      const rejected = this.#rejection;

      this.#rejection = Option.none();

      const text = Option.match(rejected, {
        onNone: () =>
          claudeFailureText(
            Option.orElse(Option.fromNullishOr(event.result), () =>
              Option.fromNullishOr(event.errors?.join("\n"))
            )
          ),
        onSome: (info) =>
          planQuotaExceededText(Option.fromNullishOr(info.rateLimitType)),
      });

      this.fail("error", text);

      return { kind: "ended", end: { kind: "failed", rejected } };
    }

    this.#rejection = Option.none();

    if (!this.open) {
      return { kind: "unattached-result" };
    }

    if (
      !this.#sawStreamEvent &&
      this.#output.content.length === 0 &&
      event.result !== undefined
    ) {
      this.#deliverBlocks([{ type: "text", text: event.result }]);
    }

    this.#done(this.#output.stopReason === "length" ? "length" : "stop");

    return { kind: "ended", end: { kind: "done" } };
  }

  /** Handles one event of the query; the effect says what the conversation must do about it. */
  handle(event: ClaudeEvent): EventEffect {
    switch (event.type) {
      case "system": {
        if ("session_id" in event) {
          this.sessionId = Option.some(event.session_id);

          return { kind: "init", sessionId: event.session_id };
        }

        return "retry_delay_ms" in event
          ? { kind: "api-retry", delayMs: event.retry_delay_ms }
          : NONE;
      }

      case "rate_limit_event": {
        if (event.rate_limit_info.status === "rejected") {
          this.#rejection = Option.some(event.rate_limit_info);
        }

        return { kind: "rate-limit", info: event.rate_limit_info };
      }

      case "stream_event": {
        return event.parent_tool_use_id === undefined ||
          event.parent_tool_use_id === null
          ? this.#onStream(event.event)
          : NONE;
      }

      case "assistant": {
        return this.#onAssistant(event);
      }

      case "result": {
        return this.#onResult(event);
      }

      case "user": {
        return NONE;
      }

      default: {
        return NONE;
      }
    }
  }
}
