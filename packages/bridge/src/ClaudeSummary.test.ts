// One-shot requests on a scripted Claude Code: summarizer calls and calls with no session run in an
// isolated child (no saved session, no tools, one turn), only a real abort stops them, the reasoning
// level becomes effort, and instructions Anthropic reads as a third-party app are refused before any
// child starts (`assertSendablePrompt`, J7's unit half).
import type { Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { Claude } from "./Claude.ts";
import { ClaudeAccount } from "./ClaudeAccount.ts";
import {
  CHILD_ENDED_TEXT,
  INIT_REFUSED_TEXT,
  PAID_CREDITS_TEXT,
  PI_PACKAGES_LINE,
  PI_PREAMBLE,
  planQuotaExceededText,
  PROMPT_REFUSED_TEXT,
  STREAM_STALLED_TEXT,
  THIRD_PARTY_DOC_PATHS,
} from "./ClaudeGuards.ts";
import { claudeModels, DEFAULT_LONG_CONTEXT } from "./ClaudeModels.ts";
import { blocksText } from "./ClaudePrompt.ts";
import { initEvent, SCRIPT_SESSION, textTurn } from "./ClaudeScriptKit.ts";
import type { FakeScript } from "./ClaudeSdk.ts";
import { ClaudeSdk, ClaudeSdkScripts } from "./ClaudeSdk.ts";
import { ClaudeSlots } from "./ClaudeSlots.ts";
import { ClaudeSummary, ONE_SHOT_EMPTY_TEXT } from "./ClaudeSummary.ts";
import { emptyUsage } from "./ClaudeTokens.ts";

const model = Option.getOrThrow(
  Option.fromNullishOr(
    claudeModels(DEFAULT_LONG_CONTEXT).find((m) => m.id === "claude-sonnet-5-5")
  )
);

const summarizer: Message = {
  role: "system",
  content: "Summarize the conversation that follows for a later reader.",
  timestamp: 1,
};

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 2,
});

const bridge = (scripts: ReadonlyArray<FakeScript>) =>
  Claude.layerNoDeps.pipe(
    Layer.provideMerge(ClaudeSummary.layerNoDeps),
    Layer.provideMerge(
      Layer.mergeAll(
        ClaudeSdk.layerTest,
        ClaudeSlots.layer,
        ClaudeAccount.layer
      )
    ),
    Layer.provideMerge(
      Layer.effect(ClaudeSdkScripts, ClaudeSdkScripts.make(scripts))
    )
  );

const call = (
  messages: ReadonlyArray<Message>,
  options?: SimpleStreamOptions
) =>
  Effect.gen(function* () {
    const claude = yield* Claude;

    const stream = claude.provider.streamSimple(
      model,
      normalizeContext({ messages: [...messages] }),
      options ?? { cacheRetention: "none", sessionId: "conv-1" }
    );

    return yield* Effect.promise(async () => await stream.result());
  });

const runs = Effect.gen(function* () {
  const fake = yield* ClaudeSdkScripts;

  return yield* Ref.get(fake.runs);
});

/** Lets other fibers run until `done` holds; the scripted child is pure Effect, so this is deterministic. */
const until = (done: Effect.Effect<boolean, never, ClaudeSdkScripts>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000; turn += 1) {
      if (yield* done) {
        return true;
      }

      yield* Effect.yieldNow;
    }

    return yield* Effect.die(new Error("condition never held"));
  });

/** Records its prompt, then answers it in one text turn. */
const answers =
  (text: string, prompts: Array<string> = []): FakeScript =>
  (io) =>
    Effect.gen(function* () {
      const prompt = yield* io.nextPrompt;

      prompts.push(
        Option.match(prompt, {
          onNone: () => "",
          onSome: (message) => blocksText(message.blocks),
        })
      );
      yield* io.emit(initEvent(SCRIPT_SESSION), ...textTurn("m1", "u1", text));
    });

/** Takes its prompt and never answers. */
const hangs: FakeScript = (io) => Effect.andThen(io.nextPrompt, Effect.never);

describe("one-shot requests", () => {
  it.effect(
    "report the request's final usage from the result, not the opening snapshot",
    () =>
      Effect.gen(function* () {
        const reply = yield* call([summarizer, user("text")]);

        expect([reply.usage.output, reply.usage.cacheRead]).toStrictEqual([
          412, 2040,
        ]);
      }).pipe(
        Effect.provide(
          bridge([
            (io) =>
              Effect.andThen(
                io.nextPrompt,
                io.emit(
                  initEvent(SCRIPT_SESSION),
                  ...textTurn("m1", "u1", "the summary").slice(0, -1),
                  {
                    type: "result",
                    subtype: "success",
                    is_error: false,
                    result: "the summary",
                    usage: {
                      input_tokens: 3,
                      output_tokens: 412,
                      cache_read_input_tokens: 2040,
                    },
                  }
                )
              ),
          ])
        )
      )
  );

  it.effect("stop a one-shot that starts drawing on paid usage credits", () =>
    Effect.gen(function* () {
      const reply = yield* call([summarizer, user("text")]);

      expect([reply.stopReason, reply.errorMessage]).toStrictEqual([
        "error",
        PAID_CREDITS_TEXT,
      ]);
    }).pipe(
      Effect.provide(
        bridge([
          (io) =>
            Effect.andThen(
              io.nextPrompt,
              io.emit(initEvent(SCRIPT_SESSION), {
                type: "rate_limit_event",
                rate_limit_info: { status: "allowed", isUsingOverage: true },
              })
            ),
        ])
      )
    )
  );

  it.effect(
    "run a summarizer call in an isolated child: no saved session, no tools, one turn, the instructions appended",
    () => {
      const prompts: Array<string> = [];

      return Effect.gen(function* () {
        const claude = yield* Claude;

        const reply = yield* call([summarizer, user("the transcript")], {
          cacheRetention: "none",
          sessionId: "conv-1",
          reasoning: "high",
        });

        const [run] = yield* runs;
        const options = run?.options;

        expect([
          reply.stopReason,
          reply.content,
          options?.persistSession,
          options?.tools,
          options?.builtinTools,
          options?.maxTurns,
          options?.session,
          options?.append,
          options?.effort,
          options?.thinking,
          (run?.closed ?? 0) >= 1,
          yield* claude.hasChild("conv-1"),
        ]).toStrictEqual([
          "stop",
          [{ type: "text", text: "the summary" }],
          false,
          [],
          [],
          Option.some(1),
          { kind: "new", sessionId: Option.none() },
          Option.some(summarizer.content),
          Option.some("high"),
          "adaptive",
          true,
          false,
        ]);

        expect(prompts).toStrictEqual(["the transcript"]);
      }).pipe(Effect.provide(bridge([answers("the summary", prompts)])));
    }
  );

  it.effect(
    "run a call with no session id as a one-shot, thinking off without a level",
    () =>
      Effect.gen(function* () {
        const reply = yield* call([user("name this thread")], {});
        const [run] = yield* runs;

        expect([
          reply.stopReason,
          reply.content,
          run?.options.persistSession,
          run?.options.effort,
          run?.options.thinking,
          run?.options.append,
        ]).toStrictEqual([
          "stop",
          [{ type: "text", text: "A title" }],
          false,
          Option.none(),
          "disabled",
          Option.none(),
        ]);
      }).pipe(Effect.provide(bridge([answers("A title")])))
  );

  it.effect("carry history before the request as a transcript", () => {
    const prompts: Array<string> = [];

    return Effect.gen(function* () {
      yield* call([
        user("first question"),
        {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          api: "claude-bridge",
          provider: "claude-bridge",
          model: "claude-sonnet-5-5",
          usage: emptyUsage(),
          stopReason: "stop",
          timestamp: 3,
        },
        user("now summarize"),
      ]);

      expect(
        [
          "<conversation-history>",
          "first question",
          "first answer",
          "</conversation-history>",
          "now summarize",
        ].map((part) => prompts[0]?.includes(part))
      ).toStrictEqual([true, true, true, true, true]);
    }).pipe(Effect.provide(bridge([answers("ok", prompts)])));
  });
});

describe("aborts", () => {
  it.effect(
    "ignore pi-durable ending the invocation: the child finishes its answer",
    () => {
      const ended = new AbortController();

      ended.abort(new Error("Task 1 invocation has ended"));

      return Effect.gen(function* () {
        const reply = yield* call([summarizer, user("text")], {
          cacheRetention: "none",
          sessionId: "conv-1",
          signal: ended.signal,
        });

        expect([reply.stopReason, reply.content]).toStrictEqual([
          "stop",
          [{ type: "text", text: "still here" }],
        ]);
      }).pipe(Effect.provide(bridge([answers("still here")])));
    }
  );

  it.effect("stop the child on a real abort, and report aborted", () => {
    const user_ = new AbortController();

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        call([summarizer, user("text")], {
          cacheRetention: "none",
          sessionId: "conv-1",
          signal: user_.signal,
        })
      );

      yield* until(Effect.map(runs, (all) => all.length === 1));
      user_.abort();

      const reply = yield* Fiber.join(fiber);
      const [run] = yield* runs;

      expect([
        reply.stopReason,
        reply.errorMessage,
        (run?.closed ?? 0) >= 1,
      ]).toStrictEqual(["aborted", "Operation aborted", true]);
    }).pipe(Effect.provide(bridge([hangs])));
  });
});

describe("a silent one-shot", () => {
  it.effect("fails once it says nothing for the stall limit", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(call([summarizer, user("text")]));

      yield* until(Effect.map(runs, (all) => all.length === 1));
      yield* TestClock.adjust("89 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("3 seconds");

      const reply = yield* Fiber.join(fiber);

      expect([reply.stopReason, reply.errorMessage]).toStrictEqual([
        "error",
        STREAM_STALLED_TEXT,
      ]);
    }).pipe(Effect.provide(bridge([hangs])))
  );
});

describe("failures", () => {
  it.effect("refuse a child that did not start on the subscription login", () =>
    Effect.gen(function* () {
      const reply = yield* call([summarizer, user("text")]);

      expect([reply.stopReason, reply.errorMessage]).toStrictEqual([
        "error",
        INIT_REFUSED_TEXT,
      ]);
    }).pipe(
      Effect.provide(
        bridge([
          (io) =>
            Effect.andThen(
              io.nextPrompt,
              io.emit({
                type: "system",
                subtype: "init",
                session_id: SCRIPT_SESSION,
                apiKeySource: "ANTHROPIC_API_KEY",
                tools: [],
                mcp_servers: [],
                model: "claude-scripted",
                cwd: "/",
              })
            ),
        ])
      )
    )
  );

  it.effect(
    "report Claude Code's own error, an empty answer, a spent plan window and a child that ended early",
    () =>
      Effect.gen(function* () {
        const replies = yield* Effect.forEach([1, 2, 3, 4], () =>
          call([summarizer, user("text")])
        );

        expect(replies.map((reply) => reply.errorMessage)).toStrictEqual([
          "Overloaded",
          ONE_SHOT_EMPTY_TEXT,
          planQuotaExceededText(Option.some("five_hour")),
          CHILD_ENDED_TEXT,
        ]);
      }).pipe(
        Effect.provide(
          bridge([
            (io) =>
              Effect.andThen(
                io.nextPrompt,
                io.emit(initEvent(SCRIPT_SESSION), {
                  type: "result",
                  subtype: "success",
                  is_error: true,
                  result: "Overloaded",
                })
              ),
            (io) =>
              Effect.andThen(
                io.nextPrompt,
                io.emit(initEvent(SCRIPT_SESSION), {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  result: "",
                })
              ),
            (io) =>
              Effect.andThen(
                io.nextPrompt,
                io.emit(initEvent(SCRIPT_SESSION), {
                  type: "rate_limit_event",
                  rate_limit_info: {
                    status: "rejected",
                    rateLimitType: "five_hour",
                    utilization: 1,
                  },
                })
              ),
            (io) => Effect.asVoid(io.nextPrompt),
          ])
        )
      )
  );

  it("an empty answer is neither retried nor read as an overflow", () => {
    const failed = {
      role: "assistant" as const,
      content: [],
      api: "claude-bridge",
      provider: "claude-bridge",
      model: "claude-sonnet-5-5",
      usage: emptyUsage(),
      stopReason: "error" as const,
      errorMessage: ONE_SHOT_EMPTY_TEXT,
      timestamp: 1,
    };

    expect([
      isRetryableAssistantError(failed),
      isContextOverflow(failed),
    ]).toStrictEqual([false, false]);
  });
});

describe("assertSendablePrompt on one-shot instructions (J7)", () => {
  const instructions = [
    `${PI_PREAMBLE}. You help users by reading files.`,
    `Docs: ${THIRD_PARTY_DOC_PATHS[0] ?? ""} and ${THIRD_PARTY_DOC_PATHS[1] ?? ""}.`,
    `- When asked about ${PI_PACKAGES_LINE}, read the docs first.`,
  ];

  it.effect(
    "refuses pi's preamble, both doc paths and the documentation routing line, before any child starts",
    () =>
      Effect.gen(function* () {
        const replies = yield* Effect.forEach(instructions, (content) =>
          call([{ role: "system", content, timestamp: 1 }, user("summarize")])
        );

        expect([
          replies.map((reply) => reply.errorMessage),
          (yield* runs).length,
        ]).toStrictEqual([instructions.map(() => PROMPT_REFUSED_TEXT), 0]);
      }).pipe(Effect.provide(bridge([])))
  );

  it.effect(
    "passes the preamble mentioned mid-line, and one doc path alone",
    () =>
      Effect.gen(function* () {
        const replies = yield* Effect.forEach(
          [
            `Cairn is not pi; never write "${PI_PREAMBLE}".`,
            `See ${THIRD_PARTY_DOC_PATHS[0] ?? ""}.`,
          ],
          (content) =>
            call([{ role: "system", content, timestamp: 1 }, user("summarize")])
        );

        expect(replies.map((reply) => reply.stopReason)).toStrictEqual([
          "stop",
          "stop",
        ]);
      }).pipe(Effect.provide(bridge([answers("a"), answers("b")])))
  );
});
