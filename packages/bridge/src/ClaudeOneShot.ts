// One-shot requests to the bridge: pi-durable's compaction and other sessionless calls arrive with
// `cacheRetention: "none"` and must never touch a conversation's held query. They run in an isolated
// child with no saved session. The real path is `ClaudeSummary` (2F, in its own layer); the default
// layer refuses with a fixed, non-retryable text, so compaction on a bridge model fails visibly
// rather than corrupting a conversation's Claude Code session.

import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Option } from "effect";
import { Context, Effect, Layer } from "effect";

import { ONE_SHOT_UNAVAILABLE_TEXT } from "./ClaudeGuards.ts";
import type { TurnSink } from "./ClaudeStream.ts";
import { emptyUsage } from "./ClaudeTokens.ts";

/** One one-shot request. */
export interface OneShotRequest {
  readonly model: Model<Api>;
  readonly messages: ReadonlyArray<Message>;
  readonly reasoning: Option.Option<ThinkingLevel>;
  readonly signal: Option.Option<AbortSignal>;
  readonly cwd: string;
  /** Epoch milliseconds when the request arrived. */
  readonly startedAt: number;
}

/** Runs a one-shot request into `sink`, which it always ends. */
export class ClaudeOneShot extends Context.Service<
  ClaudeOneShot,
  {
    run(request: OneShotRequest, sink: TurnSink): Effect.Effect<void>;
  }
>()("cairn/bridge/ClaudeOneShot") {
  /** Refuses every one-shot request. */
  static readonly layer: Layer.Layer<ClaudeOneShot> = Layer.succeed(
    ClaudeOneShot,
    ClaudeOneShot.of({
      run: (request, sink) =>
        Effect.sync(() => {
          sink.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: request.model.api,
              provider: request.model.provider,
              model: request.model.id,
              usage: emptyUsage(),
              stopReason: "error",
              errorMessage: ONE_SHOT_UNAVAILABLE_TEXT,
              timestamp: request.startedAt,
            },
          });
          sink.end();
        }),
    })
  );
}
