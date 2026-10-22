// Ported from elidickinson/pi-claude-bridge, src/transcript.ts at
// 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1 apps/server/src/claude/transcript.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0. Changed: pi-ai 1.4.0's replay helpers do the work, and
// sections render in pi-durable's replay order instead of pi-coding-agent's canonical rank.
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
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import {
  contentText,
  getCurrentSystemMessage,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { Option } from "effect";

/** pi's transcript as the bridge uses it: the instructions, the tools, and the conversation. */
export interface BridgeContext {
  /** The replayed system prompt: the base content, then each section in replay order. */
  readonly instructions: Option.Option<string>;
  readonly tools: ReadonlyArray<Tool>;
  /** Every message that is not prompt state. */
  readonly messages: ReadonlyArray<ConversationMessage>;
}

/** A message of the conversation proper, not prompt state. */
export type ConversationMessage = Exclude<Message, SystemMessage>;

/** The replayed system message rendered as one prompt, or none when it is empty. */
export const renderSystemMessage = (
  message: SystemMessage
): Option.Option<string> => {
  const sections = Object.values(message.sections ?? {}).filter(
    (value): value is string => value !== null && value.length > 0
  );

  const parts = [contentText(message.content), ...sections].filter(
    (part) => part.length > 0
  );

  return parts.length > 0 ? Option.some(parts.join("\n\n")) : Option.none();
};

const isConversationMessage = (
  message: Message
): message is ConversationMessage => message.role !== "system";

/** pi's messages without prompt state. */
export const conversationMessages = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<ConversationMessage> => messages.filter(isConversationMessage);

/** The bridge's view of a transcript pi-durable sent. */
export const toBridgeContext = (
  messages: ReadonlyArray<Message>
): BridgeContext => ({
  instructions: Option.flatMap(
    Option.fromNullishOr(getCurrentSystemMessage(messages)),
    renderSystemMessage
  ),
  tools: getCurrentTools(messages),
  messages: conversationMessages(messages),
});
