// Ported from w-winter/dot314, extensions/pi-claude-bridge/src/extract-tool-results.ts at
// c157f4e6f9fda15b2d6698a12820e7118d19fbd7, by way of cairn-v1
// apps/server/src/claude/extract-tool-results.ts at 1a5cd4a56e84bfb187940428d144b584d2e084b0.
// Behaviour kept: walk back from the end of pi's context, past user messages (steers), to the
// nearest assistant message, collecting this turn's tool results. Changed: typed over pi-ai's
// messages, and results carry the pairing id as a required field.
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
// Copyright (c) 2026 Warren Winter
// Copyright (c) 2026 Nico Bailon
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
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

/** One block of a tool result as MCP carries it back to Claude Code. */
export type ToolResultBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

/** A pi tool result on its way to the handler Claude Code's call is waiting in. */
export interface ClaudeToolResult {
  readonly toolCallId: string;
  readonly content: ReadonlyArray<ToolResultBlock>;
  readonly isError: boolean;
}

/** pi's tool result content as MCP blocks; never empty, because MCP needs one block. */
export const toolResultBlocks = (
  content: ReadonlyArray<TextContent | ImageContent>
): ReadonlyArray<ToolResultBlock> => {
  const blocks = content.flatMap((block): ReadonlyArray<ToolResultBlock> => {
    if (block.type === "text") {
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
    }

    return block.data.length > 0 && block.mimeType.length > 0
      ? [{ type: "image", data: block.data, mimeType: block.mimeType }]
      : [];
  });

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
};

/** This turn's tool results: those after the last assistant message, in order. */
export const extractToolResults = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<ClaudeToolResult> => {
  const results: Array<ClaudeToolResult> = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message === undefined || message.role === "assistant") {
      break;
    }

    if (message.role === "toolResult") {
      results.unshift({
        toolCallId: message.toolCallId,
        content: toolResultBlocks(message.content),
        isError: message.isError,
      });
    }
  }

  return results;
};

/** The text of `result`, images named by type, for a prompt that carries a result as text. */
export const toolResultText = (result: ClaudeToolResult): string =>
  result.content
    .map((block) =>
      block.type === "text" ? block.text : `[${block.mimeType} image]`
    )
    .join("\n");
