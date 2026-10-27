// One-shot requests to the bridge, the real `ClaudeOneShot` layer: pi-durable's compaction and every
// other summarizer call arrive with `cacheRetention: "none"`, and a call with no session id has no
// conversation to join. Each runs in its own Claude Code child with no saved session
// (`persistSession: false`), no tools and one turn, and never touches a conversation's held query.
//
// Ported from elidickinson/pi-claude-bridge, src/index.ts (lines 543-666, `runIsolatedSummary`) at
// 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1 apps/server/src/claude/summary.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0. Behaviour kept: route on the `cacheRetention` marker, not
// on which summarizer calls; only a real abort (an `AbortError` reason) stops the child, never
// pi-durable ending the invocation; the caller's reasoning level becomes Claude Code's effort
// (upstream fix #184). Changed: the child goes through `ClaudeSdk` with the bridge's guards (stripped
// env, `settingSources: []`, the init assertion, `assertSendablePrompt` on the instructions); the
// instructions ride as the `claude_code` preset's append instead of replacing it; history before the
// request, when there is any, is carried as a transcript; every failure is one of the bridge's fixed
// texts.
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
  AssistantMessage,
  AssistantMessageEvent,
  Usage,
} from "@earendil-works/pi-ai";
import { Clock, Duration, Effect, Layer, Option, Stream } from "effect";

import type { ClaudeEvent } from "./ClaudeEvents.ts";
import type { ChildOptions } from "./ClaudeGuards.ts";
import {
  CHILD_ENDED_TEXT,
  EMPTY_PROMPT_TEXT,
  INIT_REFUSED_TEXT,
  PAID_CREDITS_TEXT,
  PROMPT_REFUSED_TEXT,
  STREAM_STALLED_TEXT,
  abortKind,
  childEnv,
  claudeFailureText,
  planQuotaExceededText,
  refuseInit,
  unsendableFindings,
} from "./ClaudeGuards.ts";
import { MCP_SERVER_NAME } from "./ClaudeMcp.ts";
import { effortFor, servedModel } from "./ClaudeModels.ts";
import type { OneShotRequest } from "./ClaudeOneShot.ts";
import { ClaudeOneShot } from "./ClaudeOneShot.ts";
import { seedPrompt, userTurnBlocks } from "./ClaudePrompt.ts";
import { ClaudeSdk } from "./ClaudeSdk.ts";
import { ClaudeSettings } from "./ClaudeSettings.ts";
import type { TurnSink } from "./ClaudeStream.ts";
import { applyUsage, emptyUsage } from "./ClaudeTokens.ts";
import { toBridgeContext } from "./ClaudeTranscript.ts";

/** A one-shot child answered with no text. Not retryable: the same request would get the same answer. */
export const ONE_SHOT_EMPTY_TEXT =
  "Claude Code answered a one-shot request with no text.";

/** A one-shot child asked for a tool; one-shots serve none. */
const NO_TOOLS_TEXT = "This request serves no tools.";

/** The text pi shows for a request the user stopped. */
const ABORTED_TEXT = "Operation aborted";

/** How a one-shot ended. */
type Outcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "aborted" };

/** What a one-shot child's events add up to while they arrive. */
interface Progress {
  assistantText: string;
  outcome: Option.Option<Outcome>;
  readonly usage: Usage;
}

/** How often a one-shot child's silence is checked. */
const ONE_SHOT_STALL_CHECK = Duration.seconds(1);

/** Folds one event into `progress`; sets the outcome once the child has said all it will. */
const readEvent = (progress: Progress, event: ClaudeEvent): void => {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        const refused = refuseInit(
          {
            apiKeySource: event.apiKeySource,
            tools: event.tools,
            mcpServers: event.mcp_servers.map((server) => server.name),
          },
          MCP_SERVER_NAME
        );

        if (Option.isSome(refused)) {
          progress.outcome = Option.some({
            kind: "error",
            text: INIT_REFUSED_TEXT,
          });
        }
      }

      break;
    }

    case "assistant": {
      // A subagent's message is not the answer; one-shots have no tools, so this is defensive.
      if (Option.isSome(Option.fromNullishOr(event.parent_tool_use_id))) {
        break;
      }

      for (const block of event.message.content) {
        if (block.type === "text" && "text" in block) {
          progress.assistantText += block.text;
        }
      }

      for (const usage of Option.toArray(
        Option.fromNullishOr(event.message.usage)
      )) {
        applyUsage(progress.usage, usage);
      }

      break;
    }

    case "rate_limit_event": {
      if (event.rate_limit_info.status === "rejected") {
        progress.outcome = Option.some({
          kind: "error",
          text: planQuotaExceededText(
            Option.fromNullishOr(event.rate_limit_info.rateLimitType)
          ),
        });
      } else if (event.rate_limit_info.isUsingOverage === true) {
        progress.outcome = Option.some({
          kind: "error",
          text: PAID_CREDITS_TEXT,
        });
      }

      break;
    }

    case "result": {
      // The assistant events carry the opening snapshot (output 1 to 6 tokens); the result has
      // the request's final counts.
      for (const usage of Option.toArray(Option.fromNullishOr(event.usage))) {
        applyUsage(progress.usage, usage);
      }

      if (event.is_error === true || event.subtype !== "success") {
        const said = Option.orElse(Option.fromNullishOr(event.result), () =>
          Option.map(Option.fromNullishOr(event.errors), (errors) =>
            errors.join("\n")
          )
        );

        progress.outcome = Option.some({
          kind: "error",
          text: claudeFailureText(said),
        });

        break;
      }

      const text = Option.getOrElse(
        Option.filter(
          Option.fromNullishOr(event.result),
          (result) => result.trim().length > 0
        ),
        () => progress.assistantText
      );

      progress.outcome = Option.some(
        text.trim().length > 0
          ? { kind: "text", text }
          : { kind: "error", text: ONE_SHOT_EMPTY_TEXT }
      );

      break;
    }

    case "stream_event":
    case "user": {
      break;
    }

    default: {
      break;
    }
  }
};

/** Succeeds once `signal` aborts for real (an `AbortError`), never when pi-durable ends the invocation. */
const realAbort = (signal: Option.Option<AbortSignal>) =>
  Option.match(signal, {
    onNone: () => Effect.never,
    onSome: (live) =>
      Effect.callback<true>((resume) => {
        const check = () => {
          if (live.aborted && abortKind(live, false) !== "ended") {
            resume(Effect.succeed(true));
          }
        };

        check();
        live.addEventListener("abort", check, { once: true });

        return Effect.sync(() => {
          live.removeEventListener("abort", check);
        });
      }),
  });

/** The fields every reply of a one-shot carries, whatever its outcome. */
type ReplyFields = Pick<
  AssistantMessage,
  "role" | "api" | "provider" | "model" | "usage" | "timestamp"
>;

/** The terminal stream event for `outcome`. */
const outcomeEvent = (
  outcome: Outcome,
  message: ReplyFields
): AssistantMessageEvent => {
  if (outcome.kind === "text") {
    return {
      type: "done",
      reason: "stop",
      message: {
        ...message,
        content: [{ type: "text", text: outcome.text }],
        stopReason: "stop",
      },
    };
  }

  const aborted = outcome.kind === "aborted";

  return {
    type: "error",
    reason: aborted ? "aborted" : "error",
    error: {
      ...message,
      content: [],
      stopReason: aborted ? "aborted" : "error",
      errorMessage: aborted ? ABORTED_TEXT : outcome.text,
    },
  };
};

/** The real `ClaudeOneShot`, over `ClaudeSdk` and the bridge's settings. */
const layerNoDeps = Layer.effect(
  ClaudeOneShot,
  Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const settings = yield* ClaudeSettings;
    const clock = yield* Clock.Clock;
    const stallMs = Duration.toMillis(settings.stallAfter);

    const finish = (
      request: OneShotRequest,
      sink: TurnSink,
      outcome: Outcome,
      usage: Usage
    ) =>
      Effect.sync(() => {
        const message: ReplyFields = {
          role: "assistant",
          api: request.model.api,
          provider: request.model.provider,
          model: request.model.id,
          usage,
          timestamp: clock.currentTimeMillisUnsafe(),
        };

        sink.push(outcomeEvent(outcome, message));

        sink.end();
      });

    const run = Effect.fn("ClaudeSummary.run")(function* (
      request: OneShotRequest,
      sink: TurnSink
    ) {
      const usage = emptyUsage();
      const context = toBridgeContext(request.messages);
      const current = userTurnBlocks(context.messages);

      if (current.length === 0) {
        return yield* finish(
          request,
          sink,
          { kind: "error", text: EMPTY_PROMPT_TEXT },
          usage
        );
      }

      const unsendable = Option.exists(
        context.instructions,
        (text) => unsendableFindings(text).length > 0
      );

      if (unsendable) {
        return yield* finish(
          request,
          sink,
          { kind: "error", text: PROMPT_REFUSED_TEXT },
          usage
        );
      }

      const options: ChildOptions = {
        cwd: request.cwd,
        env: childEnv(settings.env, true),
        model: servedModel(request.model.id, settings.longContext).cliModel,
        builtinTools: [],
        append: context.instructions,
        effort: effortFor(request.model, request.reasoning),
        thinking: Option.isSome(request.reasoning) ? "adaptive" : "disabled",
        session: { kind: "new", sessionId: Option.none() },
        tools: [],
        persistSession: false,
        maxTurns: Option.some(1),
        executable: settings.executable,
      };

      const progress: Progress = {
        assistantText: "",
        outcome: Option.none(),
        usage,
      };

      const answer = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* sdk.open(options, (call) =>
            Effect.succeed({
              toolCallId: call.toolUseId,
              content: [{ type: "text", text: NO_TOOLS_TEXT }],
              isError: true,
            })
          );

          yield* child.input.push({
            blocks: seedPrompt(context.messages, current),
            priority: Option.none(),
          });
          yield* child.input.end;

          // The conversation's watchdog, for one-shots (T13): a child silent for `stallAfter`
          // fails, unless Claude Code said it is waiting out an API retry.
          let lastEventAt = clock.currentTimeMillisUnsafe();
          let quietUntil = 0;

          const read = Stream.runForEachWhile(child.events, (event) =>
            Effect.sync(() => {
              lastEventAt = clock.currentTimeMillisUnsafe();

              if (event.type === "system" && "retry_delay_ms" in event) {
                quietUntil = lastEventAt + event.retry_delay_ms;
              }

              readEvent(progress, event);

              return Option.isNone(progress.outcome);
            })
          ).pipe(Effect.as(false));

          const stalled = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(ONE_SHOT_STALL_CHECK);

              const at = clock.currentTimeMillisUnsafe();

              if (at - lastEventAt > stallMs && at >= quietUntil) {
                return true;
              }
            }
          });

          if (yield* Effect.raceFirst(read, stalled)) {
            yield* Effect.logWarning("claude one-shot stalled");

            return { kind: "error", text: STREAM_STALLED_TEXT } as const;
          }

          return Option.getOrElse(progress.outcome, (): Outcome => ({
            kind: "error",
            text: CHILD_ENDED_TEXT,
          }));
        })
      ).pipe(
        Effect.catchTags({
          ClaudeStartError: (error) =>
            Effect.as(
              Effect.logWarning("claude one-shot did not start").pipe(
                Effect.annotateLogs({ reason: error.message })
              ),
              { kind: "error", text: CHILD_ENDED_TEXT } as const
            ),
          ClaudeQueryError: (error) =>
            Effect.as(
              Effect.logWarning("claude one-shot child failed").pipe(
                Effect.annotateLogs({ reason: error.message })
              ),
              { kind: "error", text: CHILD_ENDED_TEXT } as const
            ),
          PromptStreamClosed: () =>
            Effect.succeed({
              kind: "error",
              text: CHILD_ENDED_TEXT,
            } as const),
        })
      );

      const outcome: Outcome = yield* Effect.raceFirst(
        answer,
        Effect.as(realAbort(request.signal), { kind: "aborted" } as const)
      );

      return yield* finish(request, sink, outcome, usage);
    });

    return ClaudeOneShot.of({ run });
  })
);

/** One-shot requests in isolated Claude Code children: the layers of the real `ClaudeOneShot`. */
export const ClaudeSummary = {
  layerNoDeps,
  /** The real one-shot path on the real Agent SDK. */
  layer: layerNoDeps.pipe(Layer.provide(ClaudeSdk.layer)),
} as const;
