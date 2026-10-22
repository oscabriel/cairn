// Ported from elidickinson/pi-claude-bridge, src/usage.ts at
// 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1 apps/server/src/claude/tokens.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0. Behaviour kept: each SDK usage frame overwrites only the
// counters it carries. Changed: renamed so it does not clash with Claude's usage windows, and the
// one-hour cache write split (`cacheWrite1h`, pi-ai 1.4.0) is filled in.
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
import type { Usage } from "@earendil-works/pi-ai";

import type { SdkUsage } from "./ClaudeEvents.ts";

const present = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined;

/**
 * Applies one SDK usage frame onto `usage` in place and recomputes the total. Counters the frame
 * omits keep their value, so the partial frames of `message_start`, `message_delta` and a complete
 * assistant message never zero out an earlier one. Cost stays zero: the plan is the meter.
 */
export const applyUsage = (usage: Usage, frame: SdkUsage): void => {
  if (present(frame.input_tokens)) {
    usage.input = frame.input_tokens;
  }

  if (present(frame.output_tokens)) {
    usage.output = frame.output_tokens;
  }

  if (present(frame.cache_read_input_tokens)) {
    usage.cacheRead = frame.cache_read_input_tokens;
  }

  if (present(frame.cache_creation_input_tokens)) {
    usage.cacheWrite = frame.cache_creation_input_tokens;
  }

  const oneHour = frame.cache_creation?.ephemeral_1h_input_tokens;

  if (present(oneHour)) {
    usage.cacheWrite1h = oneHour;
  }

  const thinking = frame.output_tokens_details?.thinking_tokens;

  if (present(thinking)) {
    usage.reasoning = thinking;
  }

  usage.totalTokens =
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
};

/** A zeroed usage record. */
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
