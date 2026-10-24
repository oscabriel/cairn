// Spike 8: compaction on a Claude thread that reads the prompt cache the thread already built.
//   node spikes/8-cached-compaction/compaction.ts [model] [trials] [variants]
//   node spikes/8-cached-compaction/compaction.ts claude-haiku-5-5 2 baseline,cached
//
// The idea is nicobailon/pi-cached-compaction (64eb3fa28ae973e54c97676f05443d93386bbe98, MIT):
// instead of pi's summarizer prompt over a flattened copy of the old messages (every tool result cut
// to 2,000 characters, nothing cached), ask for the summary as the next turn of the conversation
// itself, so the provider reads the prefix from the cache and the summarizer sees every tool result
// whole. Its bridge path forks the live Claude Code session for the summary; this spike does the
// same through the bridge's existing `fork-stamped` path, with no bridge change: a summary request
// under a throwaway pi session id makes the bridge fork the stamped Claude Code session at the stamp
// and resume the copy with the instruction as the new user turn. The summary instruction below is
// a port of intent of that repo's `summaryInstruction` (cached-request.ts).
//
// Each trial builds one thread on the real bridge (a bare pi-durable Harness, as
// judges/claude-live.ts does): one turn reads three long logs through a tool, whose facts sit past
// the 2,000-character cut, and replies with one word; a second short turn holds a fact the kept tail
// keeps. Then a manual compaction, either pi-durable's own (`baseline`, a one-shot in a fresh child)
// or through a `beforeCompact` hook that forks the stamped session (`cached`), and a last turn asks
// for the facts. Prints one JSON line per trial and appends it to runs/<model>.ndjson.
//
// pi-durable and pi-ai are imported directly, as in judges/claude-live.ts; spikes are outside the
// lint boundaries.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { Claude } from "@cairn/bridge/Claude";
import type { ChildSession } from "@cairn/bridge/ClaudeGuards";
import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { stampOf } from "@cairn/bridge/ClaudeStamp";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Message,
  Models,
  MutableModels,
} from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import {
  AgentDoc,
  CompactionTask,
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Option, Ref } from "effect";

import { BridgeCwd } from "../../apps/server/src/brain/BridgeCwdExtension.ts";
import { BridgeProvider } from "../../apps/server/src/models/BridgeProvider.ts";

const MODEL = process.argv[2] ?? "claude-haiku-5-5";
const TRIALS = Number(process.argv[3] ?? "1");
const VARIANTS = (process.argv[4] ?? "baseline,cached").split(",");
const MIDTURN_DELAY_MS = Number(process.env.S8_MIDTURN_DELAY_MS ?? "2000");
const MIDTURN_TOOL_MS = MIDTURN_DELAY_MS + 2000;
// "plain" asks for a one-word reply; "strict" also forbids describing the log, which the first
// Sonnet runs carried into the summary itself.
const READ_PROMPT = process.env.S8_READ_PROMPT ?? "plain";
const CLAUDE = { provider: "claude-bridge", modelId: MODEL };
const context = BACKGROUND_CONTEXT;
const RUNS = path.join(import.meta.dirname, "runs");

// Recording: every child the bridge opens, and every completeSimple call (compaction and the hook).

interface Opened {
  readonly session: ChildSession;
  readonly at: number;
}

interface Completed {
  readonly cacheRetention: string;
  readonly sessionId: string;
  readonly ms: number;
  readonly stop: string;
  readonly usage: AssistantMessage["usage"];
  readonly text: string;
}

/** Why a fork the bridge asked for failed; the bridge falls back to a fresh session without a log. */
const forkErrors: Array<string> = [];

/** What each one-shot child was sent, as JSON. */
const oneShotPrompts: Array<string> = [];

const recordingSdk = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Layer.effect(
    ClaudeSdk,
    Effect.gen(function* () {
      const real = yield* ClaudeSdk;

      return ClaudeSdk.of({
        ...real,
        fork: (sessionId, at, cwd) =>
          real.fork(sessionId, at, cwd).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                forkErrors.push(`${String(error)} ${JSON.stringify(error)}`.slice(0, 600));
              })
            )
          ),
        open: (options, onToolCall) =>
          Effect.gen(function* () {
            yield* Ref.update(log, (all) => [
              ...all,
              { session: options.session, at: Date.now() },
            ]);

            const query = yield* real.open(options, onToolCall);

            if (options.persistSession) {
              return query;
            }

            // A one-shot: keep the shape of what it sends, to see what trials share in the cache.
            const input = new Proxy(query.input, {
              get(target, key, receiver) {
                if (key === "push") {
                  return (message: Parameters<typeof target.push>[0]) => {
                    oneShotPrompts.push(JSON.stringify(message));

                    return target.push(message);
                  };
                }

                const value: unknown = Reflect.get(target, key, receiver);

                return typeof value === "function" ? value.bind(target) : value;
              },
            });

            return { ...query, input };
          }),
      });
    })
  ).pipe(Layer.provide(ClaudeSdk.layer));

const bridgeLayer = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  BridgeCwd.layer.pipe(
    Layer.provideMerge(BridgeProvider.layerNoDeps),
    Layer.provideMerge(
      ClaudeUsage.layerBridgeNoDeps.pipe(Layer.provideMerge(recordingSdk(log)))
    )
  );

const textOf = (message: Message | undefined): string => {
  if (message === undefined) {
    return "";
  }

  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
  }

  if (message.role === "assistant") {
    return message.content
      .map((block) => {
        if (block.type === "text") {
          return block.text;
        }

        return block.type === "toolCall"
          ? `[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`
          : "";
      })
      .join("");
  }

  if (message.role === "toolResult") {
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }

  return "";
};

const recordingModels = (log: Array<Completed>): MutableModels => {
  const models = createModels();

  return new Proxy(models, {
    get(target, key, receiver) {
      if (key === "completeSimple") {
        return async (
          ...args: Parameters<Models["completeSimple"]>
        ): Promise<AssistantMessage> => {
          const started = Date.now();
          const message = await target.completeSimple(...args);

          log.push({
            cacheRetention: args[2]?.cacheRetention ?? "default",
            sessionId: args[2]?.sessionId ?? "",
            ms: Date.now() - started,
            stop: message.stopReason,
            usage: message.usage,
            text: textOf(message),
          });

          return message;
        };
      }

      const value: unknown = Reflect.get(target, key, receiver);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

// The thread's content: three logs whose facts sit past the 2,000-character cut.

const randomInt = (low: number, high: number) =>
  low + Math.floor(Math.random() * (high - low + 1));

interface Facts {
  readonly expected: number;
  readonly actual: number;
  readonly line: number;
  readonly retention: number;
  readonly bird: string;
}

const newFacts = (): Facts => {
  const expected = randomInt(5000, 9999);
  const birds = ["kestrel", "avocet", "dunlin", "shrike", "wryneck", "bittern"];

  return {
    expected,
    actual: expected - randomInt(11, 89),
    line: randomInt(120, 980),
    retention: randomInt(31, 365),
    bird: birds[randomInt(0, birds.length - 1)] ?? "kestrel",
  };
};

const logs = (facts: Facts): Record<string, string> => ({
  tests: [
    ...Array.from(
      { length: 600 },
      (_, index) =>
        `ok ${index + 1} - ledger case ${index + 1} (${(index * 7) % 90}ms)`
    ),
    `not ok 601 - ledger_rollover: expected balance ${facts.expected}, got ${facts.actual}`,
    "# tests 601, pass 600, fail 1",
  ].join("\n"),
  build: [
    ...Array.from(
      { length: 480 },
      (_, index) =>
        `[build] compiled packages/mod${index}/index.ts in ${(index * 13) % 400}ms`
    ),
    `warning: deprecated flag --legacy-ids used at packages/vault/build.ts:${facts.line}`,
    ...Array.from(
      { length: 20 },
      (_, index) => `[build] linked bundle ${index}`
    ),
    "[build] done",
  ].join("\n"),
  config: [
    ...Array.from(
      { length: 400 },
      (_, index) => `key_${index} = value_${(index * 31) % 1000}`
    ),
    `retention_days = ${facts.retention}`,
    ...Array.from({ length: 10 }, (_, index) => `tail_${index} = on`),
  ].join("\n"),
});

const logTools = (
  facts: Facts,
  calls: Array<string>,
  onRead: (name: string) => Promise<void>
) => {
  const all = logs(facts);

  return defineExtension({
    name: "spike8.logs",
    tools: [
      defineTool({
        name: "read_log",
        description:
          "Returns one of the project's logs in full: tests, build or config.",
        parameters: Type.Object({ name: Type.String() }),
        replay: "safe",
        execute: async ({ name }) => {
          calls.push(name);
          await onRead(name);

          return await Promise.resolve({
            output: [
              { type: "text" as const, text: all[name] ?? "no such log" },
            ],
          });
        },
      }),
    ],
  });
};

// The cached path: a beforeCompact hook that forks the stamped Claude Code session.

interface HookTrace {
  outcome: "cached" | "fallback" | "not-run";
  reason: string;
  keptCount: number;
  keptStart: string;
  forkSession: string;
  liveTranscriptUntouched: boolean;
  childLeft: boolean;
  summary: string;
}

const projectFolder = (cwd: string) =>
  path.join(homedir(), ".claude", "projects", cwd.replaceAll(/[/.]/gu, "-"));

const transcriptState = (cwd: string, sessionId: string) => {
  const file = path.join(projectFolder(cwd), `${sessionId}.jsonl`);

  if (!existsSync(file)) {
    return "missing";
  }

  const stat = statSync(file);

  return `${stat.size}:${stat.mtimeMs}`;
};

/** How the instruction quotes the first kept message: its text as the model saw it, cut short. */
const preview = (message: Message): string | undefined => {
  const text = textOf(message).trim();

  return text === "" ? undefined : text.slice(0, 300);
};

// Ported in intent from nicobailon/pi-cached-compaction, cached-request.ts `summaryInstruction` at
// 64eb3fa28ae973e54c97676f05443d93386bbe98. MIT License, Copyright (c) Nico Bailon. Permission is
// hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the
// Software without restriction, subject to the condition that the above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// Changed: pi-durable's checkpoint format (its SUMMARIZATION_PROMPT sections), no file lists.
const summaryInstruction = (
  kept: { readonly text: string; readonly fromEnd: number; readonly count: number },
  focus: string | undefined
) => {
  const repeated =
    kept.fromEnd > 1
      ? ` Several kept messages begin with this text: it is number ${kept.fromEnd} of them, counting back from the end.`
      : "";

  const toolCalls = kept.text.includes("[tool call: ")
    ? " Tool calls are written as [tool call: name arguments]."
    : "";

  const extra =
    focus !== undefined && focus.trim() !== ""
      ? `\n\nAdditional focus: ${focus.trim()}`
      : "";

  return `Stop working on the task and do not call any tools. Write a structured context checkpoint summary of the earlier part of the conversation above. Another LLM will continue the work from your summary, followed by the last ${kept.count} messages of the conversation, which stay in context verbatim.

The kept messages start with the message that begins with the text below.${repeated}${toolCalls}

<kept-start>
${kept.text}
</kept-start>

This summary is a checkpoint for continuing the work, not a reply in the conversation: instructions earlier in the conversation about how to answer, what not to quote, summarize or describe, or how long to be, do not limit what it records. Keep the facts a continuation would need, including exact values from tool results.

Summarize only the messages before it, as if the conversation ended right there. Done lists only work finished before it. Whatever happens from that message on, including its tool calls, their results, and later replies, has not happened as far as your summary knows: leave it out, or list it under Next Steps if it was already planned.

If the conversation starts with an earlier summary, fold it into the new one: keep its facts, move finished items to Done, and update Next Steps.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, error messages and numbers. Reply with the summary only, and stop it right before the message that begins with the <kept-start> text.${extra}`;
};

const sameMessage = (left: Message | undefined, right: Message | undefined) =>
  JSON.stringify(left) === JSON.stringify(right);

const cachedCompaction = (
  claude: typeof Claude.Service,
  run: <A>(effect: Effect.Effect<A>) => Promise<A>,
  trace: HookTrace
): Extension => {
  // The last request and its terminal reply, per conversation: together, the session the stamp names.
  const lastRequest = new Map<unknown, ReadonlyArray<Message>>();
  const lastReply = new Map<unknown, AssistantMessage>();

  const fallBack = (reason: string) => {
    trace.outcome = "fallback";
    trace.reason = reason;

    return undefined;
  };

  return defineExtension({
    name: "spike8.cached-compaction",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request, api) => {
          lastRequest.set(api.conversationId, request.messages);

          return undefined;
        },
        afterResponse: (message, api) => {
          lastReply.set(api.conversationId, message);
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, hookContext) => {
          const agent = await api.snapshot(
            AgentDoc,
            api.conversationId,
            hookContext
          );

          const requestMessages = lastRequest.get(api.conversationId);
          const reply = lastReply.get(api.conversationId);

          if (
            agent?.model?.provider !== "claude-bridge" ||
            agent.cwd === undefined
          ) {
            return fallBack("not a bridge conversation");
          }

          if (requestMessages === undefined || reply === undefined) {
            return fallBack("no request seen since boot");
          }

          const stamp = stampOf(reply);

          // The bridge stamps tool-use replies too, so a compaction in the middle of a tool loop can
          // fork at the newest one; Claude Code repairs the dangling tool_use in the copy.
          if (
            (reply.stopReason !== "stop" && reply.stopReason !== "toolUse") ||
            Option.isNone(stamp)
          ) {
            return fallBack(`the last reply is not stamped (${reply.stopReason})`);
          }

          const sent: ReadonlyArray<Message> = [...requestMessages, reply];

          // The request hoists system messages (instructions, tool declarations) to the front while
          // the compacted range keeps entry order, so compare conversation messages only, as the
          // bridge's history digest does.
          const said = (messages: ReadonlyArray<Message>) =>
            messages.filter((message) => message.role !== "system");

          const summarized = said(compaction.messages);
          const conversation = said(sent);
          const cut = summarized.length;

          // The summarized messages must be the start of what the stamped session holds.
          const differs = summarized.findIndex(
            (message, index) => !sameMessage(message, conversation[index])
          );

          if (differs !== -1) {
            const left = JSON.stringify(summarized[differs]);
            const right = JSON.stringify(conversation[differs]);
            let at = 0;

            while (at < left.length && left[at] === right[at]) {
              at += 1;
            }

            return fallBack(
              `the compacted range is not a prefix of the last request: message ${differs} of ${cut} (sent ${conversation.length}); compacted …${left.slice(Math.max(0, at - 80), at + 120)} sent …${right.slice(Math.max(0, at - 80), at + 120)}`
            );
          }

          const previews = conversation
            .slice(cut)
            .flatMap((message) => Option.toArray(Option.fromUndefinedOr(preview(message))));

          const first = previews[0];

          if (first === undefined) {
            return fallBack("no kept message has text to mark where the summary ends");
          }

          const kept = {
            text: first,
            fromEnd: previews.filter((text) => text === first).length,
            count: previews.length,
          };

          trace.keptCount = kept.count;
          trace.keptStart = first.slice(0, 80);

          const model = api.models.getModel(agent.model.provider, agent.model.modelId);

          if (model === undefined) {
            return fallBack("no model");
          }

          // A throwaway pi session id: the stamp's piSessionId differs, so the bridge takes its
          // fork-stamped path and leaves the live session as it is.
          const forkId = randomUUID();
          const liveBefore = transcriptState(realpathSync(agent.cwd), stamp.value.ccSessionId);

          trace.forkSession = forkId;
          await run(
            claude.noteConversation(forkId, {
              cwd: agent.cwd,
              threadId: Option.none(),
            })
          );

          const instruction: Message = {
            role: "user",
            content: [
              {
                type: "text",
                text: summaryInstruction(kept, compaction.instructions),
              },
            ],
            timestamp: Date.now(),
          };

          const response = await api.models.completeSimple(
            model,
            { messages: [...sent, instruction] },
            {
              sessionId: forkId,
              ...(agent.thinkingLevel === undefined || agent.thinkingLevel === "off"
                ? {}
                : { reasoning: agent.thinkingLevel }),
            }
          );

          // The fork's child stays idle in the bridge until its time to live; end it now.
          await run(claude.abortConversation(forkId));
          trace.childLeft = await run(claude.hasChild(forkId));
          trace.liveTranscriptUntouched =
            transcriptState(realpathSync(agent.cwd), stamp.value.ccSessionId) === liveBefore;

          const summary = textOf(response).trim();

          trace.summary = summary;

          if (response.stopReason !== "stop") {
            return fallBack(`summary request ended ${response.stopReason}: ${response.errorMessage ?? ""}`);
          }

          if (summary === "") {
            return fallBack("no summary text");
          }

          trace.outcome = "cached";
          trace.reason = "";

          return { summary };
        },
      }),
    ],
  });
};

// One trial.

const ASK =
  `Without calling any tools, answer from what you remember of this conversation, in four short lines: (1) which test failed, and its expected and actual balance; (2) the file and line of the deprecated flag warning; (3) the value of retention_days; (4) my favourite bird. Write "unknown" for anything you do not know.`;

const trial = (variant: string, index: number) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<Opened>>([]);
    const completed: Array<Completed> = [];
    const calls: Array<string> = [];
    const facts = newFacts();
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-s8-")));

    const trace: HookTrace = {
      outcome: "not-run",
      reason: "",
      keptCount: 0,
      keptStart: "",
      forkSession: "",
      liveTranscriptUntouched: false,
      childLeft: false,
      summary: "",
    };

    const result = yield* Effect.gen(function* () {
      const claude = yield* Claude;
      const cwd = yield* BridgeCwd;
      const services = yield* Effect.context<Claude>();
      const run = <A>(effect: Effect.Effect<A>) =>
        Effect.runPromiseWith(services)(effect);

      const models = recordingModels(completed);

      models.setProvider(claude.provider);

      const registry = createRegistry();

      registry.install(cwd.extension.extension);
      // A mid-turn compaction starts while the config read runs, as a background one would.
      const holder: {
        conversation?: Awaited<ReturnType<typeof harness.createConversation>>;
        mid?: ReturnType<Awaited<ReturnType<typeof harness.createConversation>>["compact"]>;
      } = {};

      const marks = { completed: 0, opens: 0, started: 0 };

      const mark = () => {
        marks.completed = completed.length;
        marks.opens = Effect.runSync(Ref.get(log)).length;
        marks.started = Date.now();
      };

      registry.install(
        logTools(facts, calls, async (name) => {
          const conversation = holder.conversation;

          if (
            variant !== "midturn" ||
            name !== "config" ||
            holder.mid !== undefined ||
            conversation === undefined
          ) {
            return;
          }

          // The read takes MIDTURN_TOOL_MS; the compaction starts MIDTURN_DELAY_MS into it, so the
          // live child is still held on the call when the summary forks its session.
          const sleep = async (ms: number) =>
            await new Promise((resolve) => setTimeout(resolve, ms));

          await sleep(MIDTURN_DELAY_MS);
          mark();
          holder.mid = conversation.compact(undefined, context);
          await sleep(MIDTURN_TOOL_MS - MIDTURN_DELAY_MS);
        })
      );

      if (variant === "cached" || variant === "midturn") {
        registry.install(cachedCompaction(claude, run, trace));
      }

      const storage = yield* Effect.promise(
        async () => await openNodeSqliteStorage(path.join(root, "brain.sqlite"))
      );

      const harness = yield* Effect.acquireRelease(
        Effect.promise(
          async () =>
            await Harness.open(
              storage,
              {
                models,
                registry,
                settings: { compaction: { keepRecentTokens: 10 } },
              },
              context
            )
        ),
        (opened) =>
          Effect.promise(async () => {
            await opened.close(context);
          })
      );

      return yield* Effect.promise(async () => {
        const conversation = await harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: { model: CLAUDE, cwd: root } },
          context
        );

        holder.conversation = conversation;

        let requests = 0;

        const send = async (text: string) => {
          requests += 1;
          await conversation.submit(
            { type: "input", content: text, requestId: `s8-${requests}` },
            context
          );
          // A turn that has not settled in four minutes is a hang (one was the bridge's parallel-call
          // gap, see NOTES.md); fail the trial instead of waiting for the tool timeout.
          await Promise.race([
            conversation.waitForIdle(context),
            new Promise((_, reject) =>
              setTimeout(() => {
                reject(new Error(`turn ${requests} did not settle in 240 s`));
              }, 240_000).unref()
            ),
          ]);

          const view = await conversation.context(context);

          return view.messages.findLast(
            (message): message is AssistantMessage => message.role === "assistant"
          );
        };

        // One log per turn: three calls in one turn come as parallel tool_use blocks, which the
        // bridge drops (NOTES.md, "A bridge bug found on the way").
        let read: AssistantMessage | undefined;
        let readTexts = "";

        // A nonce up front makes each trial's flattened history unique, so pi-durable's one-shot
        // cannot read the previous trial's cache, as no real thread could.
        const nonce = randomUUID().slice(0, 8);

        for (const name of ["tests", "build", "config"]) {
          const lead = name === "tests" ? `Session ${nonce}. ` : "";

          read = await send(
            lead +
              (READ_PROMPT === "strict"
                ? `Call read_log once with name ${name}. Do not quote, summarize or describe the log: once it is read, reply with the single word read.`
                : `Call read_log once with name ${name}. Once it is read, reply with the single word read and nothing else.`)
          );
          readTexts += textOf(read);
        }

        const context0 = read?.usage;

        if (variant === "midturn" && holder.mid === undefined) {
          throw new Error("the mid-turn compaction did not start");
        }

        const midTask = holder.mid === undefined ? undefined : await holder.mid;

        // The kept tail: with keepRecentTokens 10, an idle compaction keeps this turn verbatim.
        await send(
          `Unrelated: my favourite bird is the ${facts.bird}. Reply with OK only.`
        );

        let task = midTask;

        if (task === undefined) {
          mark();
          task = await conversation.compact(undefined, context);
        }

        const settled = await harness.waitForTask(task, context);

        await conversation.waitForIdle(context);

        const compactMs = Date.now() - marks.started;
        const summaryCalls = completed.slice(marks.completed);
        const compactOpens = Effect.runSync(Ref.get(log)).slice(marks.opens);
        const after = await conversation.context(context);
        const placed = after.messages
          .map(textOf)
          .find((text) => text.includes("<summary>"));

        const callsBefore = calls.length;
        const answer = await send(ASK);
        const answerText = textOf(answer);
        const summaryText = placed ?? "";

        const has = (text: string) => ({
          failedTest:
            text.includes(String(facts.expected)) && text.includes(String(facts.actual)),
          warningLine: text.includes(`build.ts:${facts.line}`) || text.includes(`line ${facts.line}`) || new RegExp(`\\b${facts.line}\\b`, "u").test(text),
          retention: new RegExp(`\\b${facts.retention}\\b`, "u").test(text),
          bird: text.toLowerCase().includes(facts.bird),
        });

        const summaryCall = summaryCalls.at(-1);

        return {
          variant,
          trial: index,
          model: MODEL,
          readPrompt: READ_PROMPT,
          compaction: settled.state.outcome.status,
          hook: { ...trace, summary: undefined },
          contextBefore: context0 && {
            input: context0.input,
            cacheRead: context0.cacheRead,
            cacheWrite: context0.cacheWrite,
          },
          summaryRequest: summaryCall && {
            cacheRetention: summaryCall.cacheRetention,
            ms: summaryCall.ms,
            stop: summaryCall.stop,
            input: summaryCall.usage.input,
            cacheRead: summaryCall.usage.cacheRead,
            cacheWrite: summaryCall.usage.cacheWrite,
            output: summaryCall.usage.output,
            cacheWrite1h: summaryCall.usage.cacheWrite1h,
          },
          compactMs,
          forkErrors: forkErrors.splice(0),
          oneShotPrompts: oneShotPrompts.splice(0).map((prompt) => ({
            chars: prompt.length,
            hasNonce: prompt.includes(nonce),
            head: prompt.slice(0, 600),
          })),
          compactSessions: compactOpens.map((opened) => opened.session.kind === "resume" ? `resume${opened.session.fork ? "+fork" : ""}` : "new"),
          summaryChars: summaryText.length,
          summaryHas: has(summaryText),
          answerHas: has(answerText),
          toolCallsAfterCompaction: calls.length - callsBefore,
          readTurn: read?.stopReason,
          readRepliesHadFacts: has(readTexts),
          answerUsage: answer && {
            cacheRead: answer.usage.cacheRead,
            cacheWrite: answer.usage.cacheWrite,
          },
          projectFiles: readdirSync(projectFolder(root)).filter((name) => name.endsWith(".jsonl")).length,
          answer: answerText,
          summary: summaryText,
        };
      });
    }).pipe(Effect.scoped, Effect.provide(bridgeLayer(log)));

    yield* Effect.sync(() => {
      mkdirSync(RUNS, { recursive: true });
      appendFileSync(path.join(RUNS, `${MODEL}.ndjson`), `${JSON.stringify(result)}\n`);

      const { summary: _s, answer: _a, ...short } = result;

      process.stdout.write(`${JSON.stringify(short)}\n`);
      rmSync(root, { recursive: true, force: true });
      rmSync(projectFolder(root), { recursive: true, force: true });
    });
  });

const program = Effect.forEach(
  Array.from({ length: TRIALS }, (_, index) => index).flatMap((index) =>
    VARIANTS.map((variant) => [variant, index] as const)
  ),
  ([variant, index]) => trial(variant, index),
  { discard: true }
);

NodeRuntime.runMain(program);

