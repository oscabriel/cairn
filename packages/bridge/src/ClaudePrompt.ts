// Ported from elidickinson/pi-claude-bridge, src/index.ts (lines 399-472 and 1612-1619, the
// continuation prompt) at 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1
// apps/server/src/claude/prompt.ts at 1a5cd4a56e84bfb187940428d144b584d2e084b0. Behaviour kept: the
// trailing run of user messages is the prompt, images ride as blocks, a steer is the same blocks.
// Changed: blocks are Cairn values (`ClaudeSdk` maps them onto the Agent SDK); tool results Claude
// Code does not hold, and pi's whole context for a fresh session, render here as prompt text.
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

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Option, Predicate } from "effect";

import type { ClaudeToolResult } from "./ClaudeToolResults.ts";
import { toolResultText } from "./ClaudeToolResults.ts";
import type { ConversationMessage } from "./ClaudeTranscript.ts";

/** Image types Claude accepts in a prompt. */
export type PromptImageType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/** One block of a message written to Claude Code's stdin. */
export type PromptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mediaType: PromptImageType;
      readonly data: string;
    };

/** When Claude Code should take a written message: `next` drains it at the next tool boundary. */
export type PromptPriority = "now" | "next" | "later";

/** A user message on its way to Claude Code. */
export interface PromptMessage {
  readonly blocks: ReadonlyArray<PromptBlock>;
  readonly priority: Option.Option<PromptPriority>;
}

/**
 * The prompt that reopens a turn at a tool result no held query was waiting for (a restart, a
 * crash, a stall): the session's history ends at that result.
 */
export const CONTINUE_AFTER_RESUME_PROMPT =
  "[Your session was interrupted and resumed. What precedes this ends with the tool result you were waiting for. Continue the task from there.]";

const promptImageType = (mimeType: string): Option.Option<PromptImageType> => {
  switch (mimeType) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp": {
      return Option.some(mimeType);
    }

    default: {
      return Option.none();
    }
  }
};

/** pi content as prompt blocks: empty text dropped, images Claude cannot take named in text. */
export const contentBlocks = (
  content: string | ReadonlyArray<TextContent | ImageContent>
): ReadonlyArray<PromptBlock> => {
  if (Predicate.isString(content)) {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  return content.flatMap((block): ReadonlyArray<PromptBlock> => {
    if (block.type === "text") {
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
    }

    return Option.match(promptImageType(block.mimeType), {
      onNone: () => [
        {
          type: "text",
          text: `[An image of type ${block.mimeType} was left out.]`,
        },
      ],
      onSome: (mediaType) =>
        block.data.length > 0
          ? [{ type: "image", mediaType, data: block.data }]
          : [],
    });
  });
};

/**
 * Index of the first message of the current user turn: the trailing run of user messages. Equals
 * the length when the last message is not a user message. Everything before it is history.
 */
export const turnStart = (
  messages: ReadonlyArray<ConversationMessage>
): number => {
  let index = messages.length;

  while (index > 0 && messages[index - 1]?.role === "user") {
    index -= 1;
  }

  return index;
};

/** The current user turn as prompt blocks; empty when the last message is not a user message. */
export const userTurnBlocks = (
  messages: ReadonlyArray<ConversationMessage>
): ReadonlyArray<PromptBlock> =>
  messages
    .slice(turnStart(messages))
    .flatMap((message) =>
      message.role === "user" ? contentBlocks(message.content) : []
    );

/** Tool results Claude Code's session does not hold, as the text that opens a resumed prompt. */
export const toolResultsPrompt = (
  results: ReadonlyArray<ClaudeToolResult>
): ReadonlyArray<PromptBlock> =>
  results.length === 0
    ? []
    : [
        {
          type: "text",
          text: [
            "[Your session was interrupted while these tool calls ran. Their results follow; continue the task from them.]",
            ...results.map(
              (result) =>
                `<tool-result id="${result.toolCallId}"${result.isError ? ' error="true"' : ""}>\n${toolResultText(result)}\n</tool-result>`
            ),
          ].join("\n\n"),
        },
      ];

const SEED_OPENING =
  "This session continues an earlier conversation that ran elsewhere. Its history follows in order, as a transcript; treat it as what was said and done so far. The newest request follows the transcript.";

const renderHistoryMessage = (
  message: ConversationMessage
): ReadonlyArray<PromptBlock> => {
  switch (message.role) {
    case "user": {
      return [
        { type: "text", text: "[user]" },
        ...contentBlocks(message.content),
      ];
    }

    case "assistant": {
      const parts = message.content.flatMap((block) => {
        if (block.type === "text") {
          return block.text.length > 0 ? [block.text] : [];
        }

        if (block.type === "toolCall") {
          return [
            `[tool call ${block.name} id=${block.id}] ${JSON.stringify(block.arguments)}`,
          ];
        }

        return [];
      });

      return parts.length > 0
        ? [{ type: "text", text: `[assistant]\n${parts.join("\n")}` }]
        : [];
    }

    case "toolResult": {
      return [
        {
          type: "text",
          text: `[tool result ${message.toolName} id=${message.toolCallId}${message.isError ? " error" : ""}]`,
        },
        ...contentBlocks(message.content),
      ];
    }

    default: {
      return [];
    }
  }
};

/**
 * The first prompt of a fresh session that must carry pi's context (history diverged, the transcript
 * is gone, the cwd or model changed): the history before the current turn as a transcript, images
 * kept, then the current turn. pi's history at this point is already compacted where it was.
 */
export const seedPrompt = (
  messages: ReadonlyArray<ConversationMessage>,
  current: ReadonlyArray<PromptBlock>
): ReadonlyArray<PromptBlock> => {
  const history = messages.slice(0, turnStart(messages));

  if (history.length === 0) {
    return current;
  }

  return [
    { type: "text", text: `<conversation-history>\n${SEED_OPENING}` },
    ...history.flatMap(renderHistoryMessage),
    { type: "text", text: "</conversation-history>" },
    ...current,
  ];
};

/** The text of `blocks`, images named, for logs and digests. */
export const blocksText = (blocks: ReadonlyArray<PromptBlock>): string =>
  blocks
    .map((block) =>
      block.type === "text" ? block.text : `[${block.mediaType} image]`
    )
    .join("\n");
