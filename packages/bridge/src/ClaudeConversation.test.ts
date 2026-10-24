// The bridge end to end on a scripted Claude Code (`ClaudeSdk.layerTest`): tool-result routing,
// steering, aborts, resume, fresh sessions, refusals, the watchdog, plan windows and the semaphore.
// Ported in intent from cairn-v1 apps/server/test/{claude.test.ts, claude-resume.test.ts} at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code).
import type {
  AssistantMessage,
  Message,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Claude } from "./Claude.ts";
import { ClaudeAccount } from "./ClaudeAccount.ts";
import {
  INIT_REFUSED_TEXT,
  PLAN_QUOTA_PREFIX,
  STREAM_STALLED_TEXT,
} from "./ClaudeGuards.ts";
import { heldOf, instructionState } from "./ClaudeInstructions.ts";
import { claudeModels, DEFAULT_LONG_CONTEXT } from "./ClaudeModels.ts";
import { ClaudeOneShot } from "./ClaudeOneShot.ts";
import type { PromptMessage } from "./ClaudePrompt.ts";
import { blocksText, CONTINUE_AFTER_RESUME_PROMPT } from "./ClaudePrompt.ts";
import type { ToolBlock } from "./ClaudeScriptKit.ts";
import {
  failedTurn,
  fallbackToolBlocks,
  initEvent,
  messageStart,
  SCRIPT_SESSION,
  textTurn,
  toolBlock,
  toolBlockClosing,
  toolBlockOpening,
  toolMessageStop,
  toolTurn,
} from "./ClaudeScriptKit.ts";
import type { FakeScript, SessionEntry } from "./ClaudeSdk.ts";
import { ClaudeSdk, ClaudeSdkScripts } from "./ClaudeSdk.ts";
import { ClaudeSettings } from "./ClaudeSettings.ts";
import { ClaudeSlots } from "./ClaudeSlots.ts";
import { historyDigest, stampMessage, stampOf } from "./ClaudeStamp.ts";
import { emptyUsage } from "./ClaudeTokens.ts";
import type { ClaudeToolResult } from "./ClaudeToolResults.ts";

const CWD = "/nonexistent/work/project";

const CLI_MODEL = "claude-sonnet-5-5[1m]";

const FORKED = "22222222-2222-4333-8444-555555555555";

const model = Option.getOrThrow(
  Option.fromNullishOr(
    claudeModels(DEFAULT_LONG_CONTEXT).find((m) => m.id === "claude-sonnet-5-5")
  )
);

const markTool: Tool = {
  name: "mark",
  description: "Append a line to the marker file.",
  parameters: Type.Object({ line: Type.Optional(Type.String()) }),
};

const system: Message = {
  role: "system",
  content: "You are in a test.",
  sections: { cairn: "<cairn>test</cairn>" },
  toolsAdded: [markTool],
  timestamp: 1,
};

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 2,
});

const toolResult = (toolCallId: string, text: string): Message => ({
  role: "toolResult",
  toolCallId,
  toolName: "mark",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"]
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "claude-bridge",
  provider: "claude-bridge",
  model: "claude-sonnet-5-5",
  usage: emptyUsage(),
  stopReason,
  timestamp: 3,
});

const stamped = (
  prior: ReadonlyArray<Message>,
  reply: AssistantMessage,
  ccUuid: string
): AssistantMessage => {
  stampMessage(
    reply,
    {
      ccSessionId: SCRIPT_SESSION,
      ccUuid,
      piSessionId: "conv-1",
      historyDigest: historyDigest([...prior, reply]),
      held: heldOf(instructionState([system])),
      cliModel: CLI_MODEL,
      cwd: CWD,
    },
    0
  );

  return reply;
};

interface EntryIds {
  readonly uses?: ReadonlyArray<string>;
  readonly results?: ReadonlyArray<string>;
}

const entry = (
  uuid: string,
  role: SessionEntry["role"],
  ids: EntryIds = {}
): SessionEntry => ({
  uuid,
  role,
  toolUseIds: ids.uses ?? [],
  toolResultIds: ids.results ?? [],
});

/** The bridge on `scripts`, with transcripts already on disk when given. */
const bridge = (
  scripts: ReadonlyArray<FakeScript>,
  sessions: ReadonlyMap<string, ReadonlyArray<SessionEntry>> = new Map()
) =>
  Claude.layerNoDeps.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ClaudeSdk.layerTest,
        ClaudeSlots.layer,
        ClaudeAccount.layer,
        ClaudeOneShot.layer
      )
    ),
    Layer.provideMerge(
      Layer.effect(
        ClaudeSdkScripts,
        Effect.tap(ClaudeSdkScripts.make(scripts), (fake) =>
          Ref.set(fake.sessions, sessions)
        )
      )
    )
  );

const call = (
  messages: ReadonlyArray<Message>,
  options: SimpleStreamOptions = {},
  sessionId = "conv-1"
) =>
  Effect.gen(function* () {
    const claude = yield* Claude;

    yield* claude.noteConversation(sessionId, {
      cwd: CWD,
      threadId: Option.some(`thread-${sessionId}`),
    });

    const stream = claude.provider.streamSimple(
      model,
      normalizeContext({ messages: [...messages] }),
      {
        sessionId,
        ...options,
      }
    );

    return yield* Effect.promise(async () => await stream.result());
  });

const runs = Effect.gen(function* () {
  const fake = yield* ClaudeSdkScripts;

  return yield* Ref.get(fake.runs);
});

const settle = Effect.repeat(Effect.yieldNow, { times: 50 });

/** Gives the scheduler turns until `done` holds; the bridge's off-clock work (the realpath) ends. */
const until = (done: Effect.Effect<boolean, never, ClaudeSdkScripts>) =>
  Effect.gen(function* () {
    while (!(yield* done)) {
      yield* Effect.yieldNow;
    }
  });

const textOf = (prompt: Option.Option<PromptMessage>): string =>
  Option.match(prompt, {
    onNone: () => "",
    onSome: (message) => blocksText(message.blocks),
  });

/** Answers its first prompt with "hi". */
const answersHi: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(
      initEvent(SCRIPT_SESSION, ["mark"]),
      ...textTurn("m1", "u1", "hi")
    );

    return yield* Effect.never;
  });

/** Starts, then says nothing. */
const goesQuiet: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(initEvent(SCRIPT_SESSION));

    return yield* Effect.never;
  });

/** Answers "hello" as chain entry u0, recorded in its transcript. */
const saysHello: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.record(SCRIPT_SESSION, entry("u0", "assistant"));
    yield* io.emit(initEvent(SCRIPT_SESSION), ...textTurn("m0", "u0", "hello"));

    return yield* Effect.never;
  });

/** Answers "again". */
const saysAgain: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(initEvent(SCRIPT_SESSION), ...textTurn("m1", "u1", "again"));

    return yield* Effect.never;
  });

/** Starts with an API key source: not a subscription child. */
const paidChild: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(
      {
        type: "system",
        subtype: "init",
        session_id: SCRIPT_SESSION,
        apiKeySource: "ANTHROPIC_API_KEY",
        tools: [],
        mcp_servers: [],
        model: "claude-scripted",
        cwd: "/",
      },
      ...textTurn("m1", "u1", "paid")
    );

    return yield* Effect.never;
  });

/** Hits a spent five-hour window. */
const planSpent: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(
      initEvent(SCRIPT_SESSION),
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_800_000_000,
        },
      },
      ...failedTurn("You're out of extra usage · resets 6:30pm")
    );

    return yield* Effect.never;
  });

/** Opens a message and stalls inside it. */
const stalls: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(initEvent(SCRIPT_SESSION), {
      type: "stream_event",
      event: { type: "message_start", message: { id: "m1" } },
    });

    return yield* Effect.never;
  });

describe("tool calls", () => {
  it.effect(
    "keep a held query alive when the generation's invocation ends, and deliver the result into it",
    () => {
      const received: Array<ClaudeToolResult> = [];
      const first = new AbortController();

      const script: FakeScript = (io) =>
        Effect.gen(function* () {
          yield* io.nextPrompt;
          yield* io.emit(initEvent(SCRIPT_SESSION, ["mark"]));
          yield* io.emit(
            ...toolTurn("m1", "u1", "toolu_1", "mark", { line: "a" })
          );
          received.push(yield* io.callTool("mark", "toolu_1"));
          yield* io.emit(...textTurn("m2", "u2", "done"));

          return yield* Effect.never;
        });

      return Effect.gen(function* () {
        const claude = yield* Claude;

        const held = yield* call([system, user("mark it")], {
          signal: first.signal,
        });

        first.abort(new Error("Task 1 invocation has ended"));
        yield* settle;

        const alive = yield* claude.hasChild("conv-1");

        const answer = yield* call([
          system,
          user("mark it"),
          held,
          toolResult("toolu_1", "marked"),
        ]);

        expect([held.stopReason, alive, answer.stopReason]).toStrictEqual([
          "toolUse",
          true,
          "stop",
        ]);
        expect([held.content, answer.content]).toStrictEqual([
          [
            {
              type: "toolCall",
              id: "toolu_1",
              name: "mark",
              arguments: { line: "a" },
            },
          ],
          [{ type: "text", text: "done" }],
        ]);
        expect(received.map((result) => result.content)).toStrictEqual([
          [{ type: "text", text: "marked" }],
        ]);
        expect((yield* runs).map((run) => run.closed)).toStrictEqual([0]);
        expect(
          [stampOf(held), stampOf(answer)].map((stamp) =>
            Option.map(stamp, ({ ccSessionId, ccUuid, piSessionId, cwd }) => ({
              ccSessionId,
              ccUuid,
              piSessionId,
              cwd,
            }))
          )
        ).toStrictEqual([
          Option.some({
            ccSessionId: SCRIPT_SESSION,
            ccUuid: "u1",
            piSessionId: "conv-1",
            cwd: CWD,
          }),
          Option.some({
            ccSessionId: SCRIPT_SESSION,
            ccUuid: "u2",
            piSessionId: "conv-1",
            cwd: CWD,
          }),
        ]);
      }).pipe(Effect.provide(bridge([script])));
    }
  );

  it.effect(
    "start a first turn as a subscription child under pi's session id with the instructions appended",
    () =>
      Effect.gen(function* () {
        yield* call([system, user("hello")]);

        const [run] = yield* runs;
        const options = Option.getOrThrow(Option.fromNullishOr(run?.options));

        const anthropic = Object.keys(options.env).some(
          (key) => key.startsWith("ANTHROPIC_") || key.startsWith("CAIRN_")
        );

        expect([
          options.session,
          options.model,
          options.thinking,
          options.builtinTools,
        ]).toStrictEqual([
          { kind: "new", sessionId: Option.some("conv-1") },
          CLI_MODEL,
          "disabled",
          [],
        ]);
        expect([
          options.append,
          options.tools.map((tool) => tool.name),
          options.cwd,
        ]).toStrictEqual([
          Option.some("You are in a test.\n\n<cairn>test</cairn>"),
          ["mark"],
          CWD,
        ]);
        expect([
          anthropic,
          options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
          options.env.DISABLE_AUTO_COMPACT,
        ]).toStrictEqual([false, "1", "1"]);
      }).pipe(Effect.provide(bridge([answersHi])))
  );

  it.effect(
    "write a steer to Claude Code's input before the tool results it rides with",
    () => {
      const writtenAtResult: Array<ReadonlyArray<string>> = [];

      const script: FakeScript = (io) =>
        Effect.gen(function* () {
          yield* io.nextPrompt;
          yield* io.emit(
            initEvent(SCRIPT_SESSION, ["mark"]),
            ...toolTurn("m1", "u1", "toolu_1", "mark")
          );
          yield* io.callTool("mark", "toolu_1");

          const written = yield* io.written;

          writtenAtResult.push(
            written.map(
              (message) =>
                `${Option.getOrElse(message.priority, () => "-")}:${blocksText(message.blocks)}`
            )
          );
          yield* io.emit(...textTurn("m2", "u2", "stopped"));

          return yield* Effect.never;
        });

      return Effect.gen(function* () {
        const held = yield* call([system, user("go")]);

        yield* call([
          system,
          user("go"),
          held,
          toolResult("toolu_1", "r"),
          user("stop after this"),
        ]);

        expect(writtenAtResult).toStrictEqual([
          ["-:go", "next:stop after this"],
        ]);
      }).pipe(Effect.provide(bridge([script])));
    }
  );

  it.effect(
    "end an orphaned tool result after a real abort with no output and no child",
    () => {
      const aborted = new AbortController();

      aborted.abort();

      return Effect.gen(function* () {
        const held = assistant(
          [{ type: "toolCall", id: "toolu_9", name: "mark", arguments: {} }],
          "toolUse"
        );

        const reply = yield* call(
          [system, user("go"), held, toolResult("toolu_9", "aborted")],
          { signal: aborted.signal }
        );

        expect([
          reply.stopReason,
          reply.content,
          (yield* runs).length,
        ]).toStrictEqual(["stop", [], 0]);
      }).pipe(Effect.provide(bridge([])));
    }
  );
});

const blockA: ToolBlock = {
  toolUseId: "toolu_a",
  tool: "mark",
  args: { line: "first line" },
  uuid: "u1a",
};

const blockB: ToolBlock = {
  toolUseId: "toolu_b",
  tool: "mark",
  args: { line: "second line" },
  uuid: "u1b",
};

/** pi's results for every call of `held`, in order. */
const resultsFor = (held: AssistantMessage): ReadonlyArray<Message> =>
  held.content.flatMap((block) =>
    block.type === "toolCall" ? [toolResult(block.id, `r-${block.id}`)] : []
  );

/**
 * Runs one turn of two parallel calls on `script`: pi's held reply, then its answer once both results
 * are delivered, and what each MCP call received.
 */
const parallelTurn = (
  script: (
    io: Parameters<FakeScript>[0],
    received: Array<ClaudeToolResult>
  ) => Effect.Effect<void>
) => {
  const received: Array<ClaudeToolResult> = [];

  return Effect.gen(function* () {
    const held = yield* call([system, user("mark both")]);

    expect(held.content).toStrictEqual([
      {
        type: "toolCall",
        id: "toolu_a",
        name: "mark",
        arguments: { line: "first line" },
      },
      {
        type: "toolCall",
        id: "toolu_b",
        name: "mark",
        arguments: { line: "second line" },
      },
    ]);
    expect(held.stopReason).toBe("toolUse");

    const answer = yield* call([
      system,
      user("mark both"),
      held,
      ...resultsFor(held),
    ]);

    expect([
      answer.stopReason,
      answer.content,
      received.map((result) => result.content),
      Option.map(stampOf(held), (stamp) => stamp.ccUuid),
      (yield* runs).map((run) => run.closed),
    ]).toStrictEqual([
      "stop",
      [{ type: "text", text: "done" }],
      [
        [{ type: "text", text: "r-toolu_a" }],
        [{ type: "text", text: "r-toolu_b" }],
      ],
      Option.some("u1b"),
      [0],
    ]);
  }).pipe(
    Effect.provide(
      bridge([
        (io) =>
          Effect.gen(function* () {
            yield* io.nextPrompt;
            yield* io.emit(initEvent(SCRIPT_SESSION, ["mark"]));
            yield* script(io, received);
            yield* io.emit(...textTurn("m2", "u2", "done"));

            return yield* Effect.never;
          }),
      ])
    )
  );
};

/** Calls both tools at once, as Claude Code does, and records what each received in call order. */
const callBoth = (
  io: Parameters<FakeScript>[0],
  received: Array<ClaudeToolResult>,
  first: Fiber.Fiber<ClaudeToolResult>
) =>
  Effect.gen(function* () {
    const second = yield* Effect.forkChild(io.callTool("mark", "toolu_b"));

    const firstResult = yield* Fiber.join(first);
    const secondResult = yield* Fiber.join(second);

    received.push(firstResult, secondResult);
  });

describe("parallel tool calls (seed 1)", () => {
  it.effect(
    "deliver both calls of one message when the first call lands between its blocks",
    () =>
      parallelTurn((io, received) =>
        Effect.gen(function* () {
          yield* io.emit(messageStart("m1"), ...toolBlock("m1", 0, blockA));
          yield* settle;

          // Claude Code starts the first call as its block closes, before the next block streams.
          const first = yield* Effect.forkChild(io.callTool("mark", "toolu_a"));

          yield* settle;
          yield* io.emit(...toolBlock("m1", 1, blockB), ...toolMessageStop);
          yield* callBoth(io, received, first);
        })
      )
  );

  it.effect(
    "never hand pi a call whose arguments are still streaming when the first call lands",
    () =>
      parallelTurn((io, received) =>
        Effect.gen(function* () {
          yield* io.emit(
            messageStart("m1"),
            ...toolBlock("m1", 0, blockA),
            ...toolBlockOpening(1, blockB, 6)
          );
          yield* settle;

          const first = yield* Effect.forkChild(io.callTool("mark", "toolu_a"));

          yield* settle;
          yield* io.emit(
            ...toolBlockClosing("m1", 1, blockB, 6),
            ...toolMessageStop
          );
          yield* callBoth(io, received, first);
        })
      )
  );

  it.effect(
    "deliver both calls of a non-streaming fallback message, one assistant event per block",
    () =>
      parallelTurn((io, received) =>
        Effect.gen(function* () {
          yield* io.emit(...fallbackToolBlocks("m1", [blockA, blockB]));
          yield* settle;

          const first = yield* Effect.forkChild(io.callTool("mark", "toolu_a"));

          yield* callBoth(io, received, first);
        })
      )
  );
});

/** Calls a tool, then gives up on it (Claude Code's MCP timeout) and answers without it. */
const givesUpOnTheCall: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(
      initEvent(SCRIPT_SESSION, ["mark"]),
      ...toolTurn("m1", "u1", "toolu_1", "mark")
    );
    yield* settle;
    yield* io.emit(...textTurn("m2", "u2", "gave up"));

    return yield* Effect.never;
  });

describe("held rounds pi is not in", () => {
  it.effect(
    "kill a held child when a call lands that its turn went to pi without, and answer the call",
    () => {
      const late: Array<ClaudeToolResult> = [];

      const script: FakeScript = (io) =>
        Effect.gen(function* () {
          yield* io.nextPrompt;
          yield* io.emit(
            initEvent(SCRIPT_SESSION, ["mark"]),
            ...fallbackToolBlocks("m1", [blockA])
          );
          yield* settle;
          yield* Effect.forkChild(io.callTool("mark", "toolu_a"));
          yield* settle;
          // The second block only shows up after the first call ended the turn.
          yield* io.emit(...fallbackToolBlocks("m1", [blockB]));
          late.push(yield* io.callTool("mark", "toolu_b"));

          return yield* Effect.never;
        });

      return Effect.gen(function* () {
        const claude = yield* Claude;
        const held = yield* call([system, user("mark both")]);

        yield* until(Effect.sync(() => late.length > 0));

        expect([
          held.content.map((block) =>
            block.type === "toolCall" ? block.id : block.type
          ),
          late.map((result) => result.isError),
          yield* claude.hasChild("conv-1"),
        ]).toStrictEqual([["toolu_a"], [true], false]);
      }).pipe(Effect.provide(bridge([script])));
    }
  );

  it.effect("kill a held child whose query finishes a round without pi", () =>
    Effect.gen(function* () {
      const claude = yield* Claude;
      const held = yield* call([system, user("mark it")]);

      yield* until(Effect.map(claude.hasChild("conv-1"), (alive) => !alive));

      expect(held.stopReason).toBe("toolUse");
    }).pipe(Effect.provide(bridge([givesUpOnTheCall])))
  );

  it.effect("forget a call Claude Code cancels", () => {
    const cancelled: Array<ClaudeToolResult> = [];
    const controller = new AbortController();

    const script: FakeScript = (io) =>
      Effect.gen(function* () {
        yield* io.nextPrompt;
        yield* io.emit(
          initEvent(SCRIPT_SESSION, ["mark"]),
          ...toolTurn("m1", "u1", "toolu_1", "mark")
        );

        const fiber = yield* Effect.forkChild(
          io.callTool("mark", "toolu_1", controller.signal)
        );

        yield* settle;
        controller.abort();
        cancelled.push(yield* Fiber.join(fiber));

        return yield* Effect.never;
      });

    return Effect.gen(function* () {
      yield* call([system, user("mark it")]);
      yield* until(Effect.sync(() => cancelled.length > 0));

      expect(
        cancelled.map((result) => [result.isError, result.content])
      ).toStrictEqual([
        [true, [{ type: "text", text: "Tool call cancelled by Claude Code" }]],
      ]);
    }).pipe(Effect.provide(bridge([script])));
  });
});

describe("aborts", () => {
  it.effect(
    "kill a held tool call on an explicit abort, release its handler, and fork the session next time",
    () => {
      const released: Array<ClaudeToolResult> = [];
      const prompts: Array<string> = [];

      const first: FakeScript = (io) =>
        Effect.gen(function* () {
          yield* io.nextPrompt;
          yield* io.emit(initEvent(SCRIPT_SESSION, ["mark"]));
          yield* io.record(SCRIPT_SESSION, entry("u0", "assistant"));
          yield* io.emit(...textTurn("m0", "u0", "hello"));
          yield* io.nextPrompt;
          yield* io.record(
            SCRIPT_SESSION,
            entry("u1", "assistant", { uses: ["toolu_1"] })
          );
          yield* io.emit(...toolTurn("m1", "u1", "toolu_1", "mark"));
          released.push(yield* io.callTool("mark", "toolu_1"));

          return yield* Effect.never;
        });

      const second: FakeScript = (io) =>
        Effect.gen(function* () {
          prompts.push(textOf(yield* io.nextPrompt));
          yield* io.emit(
            initEvent(FORKED, ["mark"]),
            ...textTurn("m2", "u2", "ok")
          );

          return yield* Effect.never;
        });

      return Effect.gen(function* () {
        const claude = yield* Claude;
        const hello = yield* call([system, user("hi")]);
        const held = yield* call([system, user("hi"), hello, user("mark it")]);

        yield* settle;
        yield* claude.abortConversation("conv-1");
        yield* settle;

        const killed = yield* runs;

        const after = yield* call([
          system,
          user("hi"),
          hello,
          user("mark it"),
          held,
          toolResult("toolu_1", "aborted"),
        ]);

        const all = yield* runs;

        expect([
          killed.length,
          killed[0]?.interrupted,
          (killed[0]?.closed ?? 0) >= 1,
        ]).toStrictEqual([1, 1, true]);
        expect(
          released.map((result) => [result.content, result.isError])
        ).toStrictEqual([
          [[{ type: "text", text: "Operation aborted" }], true],
        ]);
        expect(all[1]?.options.session).toStrictEqual({
          kind: "resume",
          sessionId: SCRIPT_SESSION,
          at: Option.none(),
          fork: true,
        });
        expect([
          prompts.length,
          prompts[0]?.includes(
            '<tool-result id="toolu_1">\naborted\n</tool-result>'
          ),
        ]).toStrictEqual([1, true]);
        expect(
          Option.map(stampOf(after), (stamp) => stamp.ccSessionId)
        ).toStrictEqual(Option.some(FORKED));
      }).pipe(Effect.provide(bridge([first, second])));
    }
  );

  it.effect("end the turn aborted on a real abort during the answer", () => {
    const controller = new AbortController();

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        call([system, user("hi")], { signal: controller.signal })
      );

      yield* settle;
      controller.abort();

      const reply = yield* Fiber.join(fiber);

      yield* settle;

      expect([
        reply.stopReason,
        reply.errorMessage,
        ((yield* runs)[0]?.closed ?? 0) >= 1,
      ]).toStrictEqual(["aborted", "Operation aborted", true]);
    }).pipe(Effect.provide(bridge([goesQuiet])));
  });

  it.effect(
    "leave the session resumable, not forked, when shutdown closes it",
    () => {
      const controller = new AbortController();

      return Effect.gen(function* () {
        const claude = yield* Claude;
        const hello = yield* call([system, user("hi")]);

        const fiber = yield* Effect.forkChild(
          call([system, user("hi"), hello, user("more")], {
            signal: controller.signal,
          })
        );

        yield* settle;
        yield* claude.beginClosing;
        controller.abort();

        const cut = yield* Fiber.join(fiber);

        yield* call([system, user("hi"), hello, user("more")]);

        expect([
          cut.stopReason,
          (yield* runs)[1]?.options.session,
        ]).toStrictEqual([
          "aborted",
          {
            kind: "resume",
            sessionId: SCRIPT_SESSION,
            at: Option.none(),
            fork: false,
          },
        ]);
      }).pipe(Effect.provide(bridge([saysHello, saysAgain])));
    }
  );
});

const goPrior = [user("go")];

const heldReply = () =>
  stamped(
    goPrior,
    assistant(
      [{ type: "toolCall", id: "toolu_1", name: "mark", arguments: {} }],
      "toolUse"
    ),
    "u1"
  );

/** A new process whose one child continues from `sessions`, recording its first prompt. */
const afterRestart = (sessions: ReadonlyArray<SessionEntry>) => {
  const prompts: Array<string> = [];

  const script: FakeScript = (io) =>
    Effect.gen(function* () {
      prompts.push(textOf(yield* io.nextPrompt));
      yield* io.emit(
        initEvent(SCRIPT_SESSION, ["mark"]),
        ...textTurn("m2", "u2", "continued")
      );

      return yield* Effect.never;
    });

  return {
    prompts,
    layer: bridge([script], new Map([[SCRIPT_SESSION, sessions]])),
  };
};

describe("resume", () => {
  it.effect(
    "cuts after Claude Code's own tool result when it holds one, and only asks it to go on",
    () => {
      const { prompts, layer } = afterRestart([
        entry("u0", "assistant"),
        entry("u1", "assistant", { uses: ["toolu_1"] }),
        entry("r1", "user", { results: ["toolu_1"] }),
        entry("p1", "assistant"),
      ]);

      return Effect.gen(function* () {
        const reply = yield* call([
          system,
          ...goPrior,
          heldReply(),
          toolResult("toolu_1", "marked"),
        ]);

        expect([
          reply.stopReason,
          (yield* runs)[0]?.options.session,
          prompts,
        ]).toStrictEqual([
          "stop",
          {
            kind: "resume",
            sessionId: SCRIPT_SESSION,
            at: Option.some("r1"),
            fork: false,
          },
          [CONTINUE_AFTER_RESUME_PROMPT],
        ]);
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "cuts at the held call and carries the result as text when Claude Code never got it",
    () => {
      const { prompts, layer } = afterRestart([
        entry("u0", "assistant"),
        entry("u1", "assistant", { uses: ["toolu_1"] }),
      ]);

      return Effect.gen(function* () {
        yield* call([
          system,
          ...goPrior,
          heldReply(),
          toolResult("toolu_1", "marked"),
        ]);

        expect([
          (yield* runs)[0]?.options.session,
          prompts[0]?.includes(
            '<tool-result id="toolu_1">\nmarked\n</tool-result>'
          ),
        ]).toStrictEqual([
          {
            kind: "resume",
            sessionId: SCRIPT_SESSION,
            at: Option.none(),
            fork: false,
          },
          true,
        ]);
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "launches the resume with an append when the stamped session had one, so Claude Code names the same agent",
    () => {
      const { layer } = afterRestart([
        entry("u0", "assistant"),
        entry("u1", "assistant", { uses: ["toolu_1"] }),
      ]);

      return Effect.gen(function* () {
        yield* call([
          system,
          ...goPrior,
          heldReply(),
          toolResult("toolu_1", "marked"),
        ]);

        expect((yield* runs)[0]?.options.append).toStrictEqual(
          Option.some("You are in a test.\n\n<cairn>test</cairn>")
        );
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "forks the session of the conversation a pi fork came from, then resumes the copy",
    () => {
      const { prompts, layer } = afterRestart([
        entry("u0", "assistant"),
        entry("u1", "assistant", { uses: ["toolu_1"] }),
      ]);

      return Effect.gen(function* () {
        const fake = yield* ClaudeSdkScripts;

        yield* call(
          [system, ...goPrior, heldReply(), toolResult("toolu_1", "marked")],
          {},
          "conv-fork"
        );

        expect([
          yield* Ref.get(fake.forks),
          (yield* runs)[0]?.options.session,
        ]).toStrictEqual([
          [{ sessionId: SCRIPT_SESSION, upTo: Option.some("u1") }],
          {
            kind: "resume",
            sessionId: `fork-1-of-${SCRIPT_SESSION}`,
            at: Option.none(),
            fork: false,
          },
        ]);
        expect(
          prompts[0]?.includes(
            '<tool-result id="toolu_1">\nmarked\n</tool-result>'
          )
        ).toBeTruthy();
      }).pipe(Effect.provide(layer));
    }
  );

  it.effect(
    "opens a fresh session seeded with pi's context when the history diverged, writing no transcript",
    () => {
      const prompts: Array<string> = [];

      const script: FakeScript = (io) =>
        Effect.gen(function* () {
          prompts.push(textOf(yield* io.nextPrompt));
          yield* io.emit(initEvent(FORKED), ...textTurn("m1", "u9", "fresh"));

          return yield* Effect.never;
        });

      return Effect.gen(function* () {
        const fake = yield* ClaudeSdkScripts;

        const hello = stamped(
          [user("hi")],
          assistant([{ type: "text", text: "hello" }], "stop"),
          "u0"
        );

        yield* call([system, user("hi, edited"), hello, user("again")]);

        const [run] = yield* runs;
        const prompt = prompts[0] ?? "";

        expect([
          run?.options.session,
          Option.isSome(run?.options.append ?? Option.none()),
        ]).toStrictEqual([{ kind: "new", sessionId: Option.none() }, true]);
        expect([
          prompt.startsWith("<conversation-history>"),
          prompt.includes("[user]\nhi, edited"),
          prompt.includes("[assistant]\nhello"),
          prompt.endsWith("</conversation-history>\nagain"),
        ]).toStrictEqual([true, true, true, true]);
        expect([
          yield* Ref.get(fake.forks),
          [...(yield* Ref.get(fake.sessions)).keys()],
        ]).toStrictEqual([[], []]);
      }).pipe(Effect.provide(bridge([script])));
    }
  );
});

describe("refusals and failures", () => {
  it.effect(
    "refuse a child that does not start on the subscription login",
    () =>
      Effect.gen(function* () {
        const reply = yield* call([system, user("hi")]);

        expect([
          reply.stopReason,
          reply.errorMessage,
          reply.content,
        ]).toStrictEqual(["error", INIT_REFUSED_TEXT, []]);
      }).pipe(Effect.provide(bridge([paidChild])))
  );

  it.effect(
    "name a spent plan window so pi does not retry it, and report the reading",
    () =>
      Effect.gen(function* () {
        const claude = yield* Claude;

        const readings = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(claude.rateLimits, 1))
        );

        yield* settle;

        const reply = yield* call([system, user("hi")]);
        const seen = yield* Fiber.join(readings);

        expect([
          reply.stopReason,
          reply.errorMessage?.startsWith(PLAN_QUOTA_PREFIX),
        ]).toStrictEqual(["error", true]);
        expect(
          seen.map((info) => [info.status, info.rateLimitType])
        ).toStrictEqual([["rejected", "five_hour"]]);
      }).pipe(Effect.provide(bridge([planSpent])))
  );

  it.effect("fail a turn whose child goes silent, and kill the child", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(call([system, user("hi")]));

      // The child has started once the fake records its run; from there everything runs on the
      // test clock. One jump past the 90 second stall limit wakes the watchdog's 5 second ticks
      // in order and ends the turn.
      yield* until(Effect.map(runs, (started) => started.length === 1));
      yield* settle;
      yield* TestClock.adjust("100 seconds");

      const reply = yield* Fiber.join(fiber);

      yield* settle;

      expect([
        reply.stopReason,
        reply.errorMessage,
        ((yield* runs)[0]?.closed ?? 0) >= 1,
      ]).toStrictEqual(["error", STREAM_STALLED_TEXT, true]);
    }).pipe(Effect.provide(bridge([stalls])))
  );
});

/**
 * One generic script per child, since children start in any order: a parent turn calls `mark` and
 * checks the result is its own; a child turn just answers. `active` counts scripts generating.
 */
const generic =
  (
    active: Ref.Ref<number>,
    peak: Ref.Ref<number>,
    mismatches: Array<string>
  ): FakeScript =>
  (io) =>
    Effect.gen(function* () {
      const prompt = textOf(yield* io.nextPrompt);
      const now = yield* Ref.updateAndGet(active, (n) => n + 1);

      yield* Ref.update(peak, (max) => Math.max(max, now));
      yield* Effect.sleep("20 millis");
      yield* Ref.update(active, (n) => n - 1);

      if (prompt.startsWith("parent")) {
        yield* io.emit(
          initEvent(SCRIPT_SESSION, ["mark"]),
          ...toolTurn("m1", "u1", `toolu-${prompt}`, "mark")
        );

        const result = yield* io.callTool("mark", `toolu-${prompt}`);

        const text = result.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");

        if (text !== `result for ${prompt}`) {
          mismatches.push(`${prompt} got ${text}`);
        }

        yield* io.emit(...textTurn("m2", "u2", `done ${prompt}`));
      } else {
        yield* io.emit(
          initEvent(SCRIPT_SESSION),
          ...textTurn("m1", "u1", `answer ${prompt}`)
        );
      }

      return yield* Effect.never;
    });

describe("generation permits (J8)", () => {
  it.live(
    "let at most four children generate, never deliver across conversations, and never hold a permit across a tool call",
    () =>
      Effect.gen(function* () {
        const active = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const mismatches: Array<string> = [];

        const parents = ["a", "b", "c", "d", "e", "f"].map(
          (name) => `parent ${name}`
        );

        const children = ["w", "x", "y", "z"].map((name) => `child ${name}`);

        const scripts = Array.from(
          { length: parents.length + children.length },
          () => generic(active, peak, mismatches)
        );

        const program = Effect.gen(function* () {
          const claude = yield* Claude;
          const slots = yield* ClaudeSlots;
          const waits = yield* Ref.make<ReadonlyArray<string>>([]);

          const watcher = yield* Effect.forkChild(
            Stream.runForEach(claude.offered, (offer) =>
              offer.waiting
                ? Ref.update(waits, (all) => [...all, offer.sessionId])
                : Effect.void
            )
          );

          yield* Effect.sleep("5 millis");

          const held = yield* Effect.forEach(
            parents,
            (name) =>
              Effect.map(call([system, user(name)], {}, name), (reply) => ({
                name,
                reply,
              })),
            { concurrency: "unbounded" }
          );

          const permitsWhileHeld = yield* slots.generating;

          // Every parent is held on its tool call; children must still get permits.
          const answers = yield* Effect.forEach(
            children,
            (name) => call([system, user(name)], {}, name),
            {
              concurrency: "unbounded",
            }
          ).pipe(Effect.timeout("5 seconds"));

          const finals = yield* Effect.forEach(
            held,
            ({ name, reply }) =>
              call(
                [
                  system,
                  user(name),
                  reply,
                  toolResult(`toolu-${name}`, `result for ${name}`),
                ],
                {},
                name
              ),
            { concurrency: "unbounded" }
          );

          yield* Fiber.interrupt(watcher);

          expect([
            yield* Ref.get(peak),
            permitsWhileHeld,
            mismatches,
          ]).toStrictEqual([4, [], []]);
          expect(held.map(({ reply }) => reply.stopReason)).toStrictEqual(
            parents.map(() => "toolUse")
          );
          expect(answers.map((reply) => reply.stopReason)).toStrictEqual(
            children.map(() => "stop")
          );
          expect(finals.map((reply) => reply.stopReason)).toStrictEqual(
            parents.map(() => "stop")
          );
          expect(new Set(yield* Ref.get(waits)).size).toBeGreaterThanOrEqual(2);
        });

        yield* program.pipe(Effect.provide(bridge(scripts)));
      })
  );

  it.effect(
    "waits for a permit when every one is taken, and reports the wait",
    () =>
      Effect.gen(function* () {
        const slots = yield* ClaudeSlots;
        const waits = yield* Ref.make<ReadonlyArray<boolean>>([]);

        const watcher = yield* Effect.forkChild(
          Stream.runForEach(slots.waits, (wait) =>
            Ref.update(waits, (all) => [...all, wait.waiting])
          )
        );

        yield* settle;
        yield* Effect.forEach(["a", "b", "c", "d"], (id) => slots.acquire(id));

        const fifth = yield* Effect.forkChild(slots.acquire("e"));

        yield* settle;

        const waiting = yield* slots.waiting;

        yield* slots.release("a");
        yield* Fiber.join(fifth);
        yield* settle;
        yield* Fiber.interrupt(watcher);

        expect([
          waiting,
          yield* slots.waiting,
          yield* slots.generating,
          yield* Ref.get(waits),
        ]).toStrictEqual([["e"], [], ["b", "c", "d", "e"], [true, false]]);
      }).pipe(Effect.provide(ClaudeSlots.layer))
  );
});

describe("the live-child cap", () => {
  it.effect(
    "evict the least recently used idle conversation for a new one instead of refusing it",
    () =>
      Effect.gen(function* () {
        const first = yield* call([system, user("one")], {}, "conv-1");
        const second = yield* call([system, user("two")], {}, "conv-2");

        expect([first.stopReason, second.stopReason]).toStrictEqual([
          "stop",
          "stop",
        ]);
        expect(second.errorMessage).toBeUndefined();
        expect(yield* runs).toHaveLength(2);
      }).pipe(
        Effect.provide(bridge([answersHi, answersHi])),
        Effect.provideService(ClaudeSettings, {
          ...ClaudeSettings.defaultValue(),
          liveChildren: 1,
        })
      )
  );
});
