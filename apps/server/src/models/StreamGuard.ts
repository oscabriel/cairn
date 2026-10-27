// Ported from github.com/HazAT/ultimate, server/tool-arguments.ts (`guardStream`,
// `guardToolArguments`) at 8b26338680fc5bc970b68c281c4e9b03a09887c1. Intent kept: a model that
// degenerates mid tool call into whitespace is cut off with a retryable error instead of streaming
// until the request times out. Code rewritten for Cairn: pi-ai's `lazyStream` forwards the
// events, the stream ends at the `MAX_WHITESPACE_RUN`th character (Ultimate's at one past it), and
// the bridge is never wrapped.
//
// MIT License. Copyright (c) 2026 Daniel Griesser
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Only tool-call argument deltas count. Arguments are JSON, where a file's newlines arrive escaped,
// so a legitimate run of 1,000 raw whitespace characters is all but impossible there. Text and
// thinking carry raw newlines and indentation (padded tables, blank-line art, generated fixtures),
// no degenerate text stream has been seen, and cutting one would throw away an answer the user is
// already reading. The `claude-bridge` provider is left alone: its stream is Claude Code's own
// session, which has its own limits.

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Api,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import { Predicate } from "effect";

import { BRIDGE_PROVIDER } from "./HarnessSettings.ts";

/** Whitespace characters in a row, inside one tool call's arguments, that end the stream. */
export const MAX_WHITESPACE_RUN = 1000;

const WHITESPACE = /\s/u;

/**
 * Why a degenerate stream ended. pi-durable retries a failed generation only when pi-ai's
 * `isRetryableAssistantError` accepts its `errorMessage` (and `isContextOverflow` does not); this
 * text passes through its "you can retry your request" pattern and matches none of the quota or
 * overflow patterns that would stop it.
 */
export const degenerateArgumentsMessage = (toolName: string): string =>
  `Stream guard stopped the response: the arguments of the ${toolName} tool call reached ${MAX_WHITESPACE_RUN} whitespace characters in a row, so the model's output had degenerated. No tool ran; you can retry your request.`;

/** The whitespace run after `delta`, continuing from `run`; stops counting at the limit. */
const runAfter = (run: number, delta: string): number => {
  let current = run;

  for (const char of delta) {
    current = WHITESPACE.test(char) ? current + 1 : 0;

    if (current >= MAX_WHITESPACE_RUN) {
      return current;
    }
  }

  return current;
};

/** The failed message for a response whose tool call at `index` degenerated. */
const degenerated = (
  partial: AssistantMessage,
  index: number
): AssistantMessage => {
  const block = partial.content[index];

  return {
    ...partial,
    content: [...partial.content],
    stopReason: "error",
    errorMessage: degenerateArgumentsMessage(
      block?.type === "toolCall" ? block.name : "unnamed"
    ),
  };
};

/**
 * `source`'s events until a tool call's arguments degenerate; then `stop` aborts the request and
 * one error event ends the response.
 *
 * @yields {AssistantMessageEvent} Each event of `source`, or in place of the degenerate delta, the error that ends it.
 */
const guardEvents = async function* (
  source: AssistantMessageEventStream,
  stop: AbortController
): AsyncGenerator<AssistantMessageEvent> {
  const runs = new Map<number, number>();

  for await (const event of source) {
    if (event.type === "toolcall_delta") {
      const run = runAfter(runs.get(event.contentIndex) ?? 0, event.delta);

      runs.set(event.contentIndex, run);

      if (run >= MAX_WHITESPACE_RUN) {
        stop.abort();

        yield {
          type: "error",
          reason: "error",
          error: degenerated(event.partial, event.contentIndex),
        };

        return;
      }
    }

    yield event;
  }
};

/** One guarded stream; the request sees the caller's signal and the guard's. */
const guardStream = (
  model: Model<Api>,
  open: (signal: AbortSignal) => AssistantMessageEventStream,
  signal: AbortSignal | undefined
): AssistantMessageEventStream => {
  const stop = new AbortController();

  return lazyStream(
    model,
    async () =>
      await Promise.resolve(
        guardEvents(
          open(
            signal === undefined
              ? stop.signal
              : AbortSignal.any([signal, stop.signal])
          ),
          stop
        )
      )
  );
};

/**
 * `models` with every non-bridge `streamSimple` guarded: a response whose tool-call arguments run
 * `MAX_WHITESPACE_RUN` whitespace characters in a row ends at once with a retryable error, and its
 * request is aborted. Every other member is `models`' own, and `completeSimple` streams through
 * the guard.
 */
export const guardModels = <M extends Models>(models: M): M => {
  const streamSimple: Models["streamSimple"] = (model, context, options) =>
    model.provider === BRIDGE_PROVIDER
      ? models.streamSimple(model, context, options)
      : guardStream(
          model,
          (signal) =>
            models.streamSimple(model, context, { ...options, signal }),
          options?.signal
        );

  return new Proxy(models, {
    get: (target, key) => {
      if (key === "streamSimple") {
        return streamSimple;
      }

      // Unbound on purpose: a member called through the guard sees it as `this`, so the runtime's
      // own `completeSimple`, and its route to a virtual model, stream through the guard too. pi's
      // runtimes keep no `#private` fields, which a call through a proxy could not reach.
      return Predicate.hasProperty(target, key) ? target[key] : undefined;
    },
  });
};
