// Ported from elidickinson/pi-claude-bridge, src/prompt-stream.ts at
// 874fa7c2678456336f23b64e784e2057e608d83e. Behaviour kept: the prompt is a long-lived input the SDK
// pumps into Claude Code's stdin, so a steer can be written while a tool runs; a push is acknowledged
// only once the consumer asks for the next message, which proves the previous one was written; a
// failure rejects every queued and in-flight push instead of leaving one hanging. Changed: written
// with Effect's Queue and Deferred; the consumer side is `take`, which `ClaudeSdk` turns into the
// SDK's async iterable.
//
// The drain and the stdin ordering are Claude Code internals, not SDK contract, so this can break
// under a Claude Code upgrade without a type error. `ClaudeConversation.test.ts` covers the ordering.
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
import type { Cause } from "effect";
import { Deferred, Effect, Option, Queue, Ref, Schema } from "effect";

import type { PromptMessage } from "./ClaudePrompt.ts";

/** A push to a prompt stream that was ended or abandoned, or never written. */
export class PromptStreamClosed extends Schema.TaggedError<PromptStreamClosed>()(
  "PromptStreamClosed",
  {
    message: Schema.String,
  }
) {}

interface Item {
  readonly message: PromptMessage;
  readonly written: Deferred.Deferred<true, PromptStreamClosed>;
}

/** The input side of one Claude Code child. */
export interface PromptStream {
  /** Queues `message`; succeeds once Claude Code's stdin took it, fails if the stream closed first. */
  push(message: PromptMessage): Effect.Effect<true, PromptStreamClosed>;
  /** No more input: the consumer ends after what is queued, and the SDK closes Claude Code's stdin. */
  readonly end: Effect.Effect<void>;
  /**
   * Abandons the input: every queued and in-flight push fails with `reason`. The first reason wins;
   * true when this call closed the stream.
   */
  fail(reason: string): Effect.Effect<boolean>;
  /** The consumer's next message, acknowledging the previous one; none once the input ended or failed. */
  readonly take: Effect.Effect<Option.Option<PromptMessage>>;
}

/** A new prompt stream. */
export const openPromptStream: Effect.Effect<PromptStream> = Effect.gen(
  function* () {
    const queue = yield* Queue.unbounded<Item, Cause.Done>();
    const inflight = yield* Ref.make(Option.none<Item>());
    const failure = yield* Ref.make(Option.none<PromptStreamClosed>());

    const acknowledge = Effect.gen(function* () {
      const previous = yield* Ref.getAndSet(inflight, Option.none());

      if (Option.isSome(previous)) {
        yield* Deferred.succeed(previous.value.written, true);
      }
    });

    const push = Effect.fn("PromptStream.push")(function* (
      message: PromptMessage
    ) {
      const failed = yield* Ref.get(failure);

      if (Option.isSome(failed)) {
        return yield* failed.value;
      }

      const written = yield* Deferred.make<true, PromptStreamClosed>();
      const accepted = yield* Queue.offer(queue, { message, written });

      if (!accepted) {
        return yield* new PromptStreamClosed({
          message:
            "Claude Code's input is closed; the message was not written.",
        });
      }

      return yield* Deferred.await(written);
    });

    const fail = Effect.fn("PromptStream.fail")(function* (reason: string) {
      const error = new PromptStreamClosed({ message: reason });

      const first = yield* Ref.modify(failure, (current) =>
        Option.isSome(current) ? [false, current] : [true, Option.some(error)]
      );

      if (!first) {
        return false;
      }

      const queued = yield* Queue.clear(queue).pipe(
        Effect.orElseSucceed(() => [])
      );

      yield* Queue.end(queue);

      const current = yield* Ref.getAndSet(inflight, Option.none());

      for (const item of [...queued, ...Option.toArray(current)]) {
        yield* Deferred.fail(item.written, error);
      }

      return true;
    });

    const take = Effect.gen(function* () {
      yield* acknowledge;

      const failed = yield* Ref.get(failure);

      if (Option.isSome(failed)) {
        return Option.none<PromptMessage>();
      }

      const next = yield* Queue.take(queue).pipe(Effect.option);

      if (Option.isSome(next)) {
        yield* Ref.set(inflight, next);
      }

      return Option.map(next, (item) => item.message);
    });

    return {
      push,
      end: Effect.asVoid(Queue.end(queue)),
      fail,
      take,
    };
  }
);
