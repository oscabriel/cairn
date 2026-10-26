// Live bridge judges that need pi-durable but not the server: J5 (a large tool list is loaded, not
// deferred), a real paste (an image through the bridge), and J4's divergence cases (a compaction,
// a provider switch, a deleted transcript), each opening a fresh Claude session that still answers
// with the earlier context.
//   node judges/claude-live.ts [--case tools,parallel,paste,compaction,switch,deleted,restart]
//                              [--model claude-haiku-5-5]
//
// Each case runs a bare pi-durable Harness on a scratch store, with the real bridge (`Claude` over
// the Agent SDK and the `claude` binary's own login), Cairn's `bridge-cwd` extension and the case's
// tools, so the brain's provider path is the one under test without the HTTP server. A recording
// wrapper over `ClaudeSdk` keeps how each child was opened and its `system:init` tool list.
//
// - tools: 30 synthetic tools plus Cairn's code mode; every one is in `system:init`, there is no
//   `ToolSearch`, and the model calls `synthetic_17` directly and reports its token.
// - parallel: the same 30 tools; the model is asked for two of them in one response. Claude Code's
//   own transcript must show one API message with both tool_use blocks (otherwise the run is
//   inconclusive: the model serialised them), pi must get both calls in one reply, both results
//   must be committed, and the answer must quote both tokens. Seed 1 of the full review: before
//   the fix the second call never ran and the turn hung until stopped.
// - paste: a PNG of a nonce word (ImageMagick) in the user message; the answer is the word.
// - compaction: a fact, another turn, then `compact()` with a tiny kept tail; the summary replaces
//   the stamped reply that held the fact, the next turn opens a new Claude session, and the answer
//   uses the fact.
// - switch: a fact on Claude, a turn on another provider (pi-ai's faux provider, standing in for
//   OpenCode Go: the bridge only sees an assistant entry it did not write), then Claude again; the
//   answer uses both turns.
// - deleted: a fact on Claude, its transcript file deleted, a new bridge (a restart); the next turn
//   opens a new session without error and uses the fact.
// - restart: the 800-line ledger with Cairn's code mode and 30 tools, then a new bridge (a clean
//   restart); the next turn resumes natively with the same tool list and keeps the prompt cache
//   (`cacheRead >= 10 * cacheWrite`), the baseline J2's kills are compared against.
//
// pi-durable and pi-ai are imported here directly (a bare Harness, the faux provider), which the
// import boundaries (S42) allow only under `judges/fixtures/`; each import says so.
//
// Every case runs under a deadline (CASE_DEADLINE, 120 s for parallel): a case that hangs prints a
// failed line with `timedOut`, its scratch folders and transcripts are removed, and the next case
// still runs.
//
// Prints one JSON line per case with its checks, the sessions opened and the cache numbers. Exit 0
// when every check holds. Costs a few cents of plan usage on Haiku.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Claude } from "@cairn/bridge/Claude";
import type { ChildSession } from "@cairn/bridge/ClaudeGuards";
import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { stampOf } from "@cairn/bridge/ClaudeStamp";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { Extension } from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeRuntime } from "@effect/platform-node";
import type { Scope } from "effect";
import {
  Duration,
  Effect,
  Layer,
  Option,
  Random,
  Ref,
  Schema,
  Stream,
} from "effect";

import { BridgeCwd } from "../apps/server/src/brain/BridgeCwdExtension.ts";
import { CodeMode } from "../apps/server/src/brain/CodeMode.ts";
import { BridgeProvider } from "../apps/server/src/models/BridgeProvider.ts";

const CASES = [
  "tools",
  "parallel",
  "paste",
  "compaction",
  "switch",
  "deleted",
  "restart",
] as const;

type CaseName = (typeof CASES)[number];

const isCase = (name: string): name is CaseName =>
  CASES.some((known) => known === name);

const { values } = parseArgs({
  options: {
    case: { type: "string", default: CASES.join(",") },
    model: { type: "string", default: "claude-haiku-5-5" },
  },
});

const chosen = values.case.split(",").filter(isCase);

const CLAUDE = { provider: "claude-bridge", modelId: values.model };

const OTHER = { provider: "other", modelId: "small" };

const context = BACKGROUND_CONTEXT;

/** A case's check did not hold. */
class ClaudeLiveFailed extends Schema.TaggedError<ClaudeLiveFailed>()(
  "ClaudeLiveFailed",
  { message: Schema.String }
) {}

/** One child the bridge opened: how, and the tools its `system:init` listed. */
interface Opened {
  readonly session: ChildSession;
  readonly initTools: Array<string>;
}

/** The real Agent SDK, recording each child's session and `system:init` tools. */
const recordingSdk = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Layer.effect(
    ClaudeSdk,
    Effect.gen(function* () {
      const real = yield* ClaudeSdk;

      return ClaudeSdk.of({
        ...real,
        open: (options, onToolCall) =>
          Effect.gen(function* () {
            const query = yield* real.open(options, onToolCall);
            const opened: Opened = { session: options.session, initTools: [] };

            yield* Ref.update(log, (all) => [...all, opened]);

            return {
              ...query,
              events: query.events.pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    if (event.type === "system" && "tools" in event) {
                      opened.initTools.push(...event.tools);
                    }
                  })
                )
              ),
            };
          }),
      });
    })
  ).pipe(Layer.provide(ClaudeSdk.layer));

/** The bridge as the brain composes it, over the recording SDK, with Cairn's `bridge-cwd`. */
const bridgeLayer = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  BridgeCwd.layer.pipe(
    Layer.provideMerge(BridgeProvider.layerNoDeps),
    Layer.provideMerge(
      ClaudeUsage.layerBridgeNoDeps.pipe(Layer.provideMerge(recordingSdk(log)))
    )
  );

type OpenHarness = Awaited<ReturnType<typeof Harness.open>>;

type Conversation = Awaited<ReturnType<OpenHarness["createConversation"]>>;

/** A Harness over `file` with the bridge, the faux "other" provider and `extensions`. */
const openHarness = (
  file: string,
  extensions: ReadonlyArray<Extension>,
  keepRecentTokens: Option.Option<number>
) =>
  Effect.gen(function* () {
    const claude = yield* Claude;
    const cwd = yield* BridgeCwd;
    const models = createModels();

    models.setProvider(claude.provider);

    const other = fauxProvider({
      provider: "other",
      models: [{ id: "small" }],
    });

    other.setResponses([fauxAssistantMessage("Noted.")]);
    models.setProvider(other.provider);

    const registry = createRegistry();

    registry.install(cwd.extension.extension);

    for (const extension of extensions) {
      registry.install(extension);
    }

    const storage = yield* Effect.promise(
      async () => await openNodeSqliteStorage(file)
    );

    const settings = Option.match(keepRecentTokens, {
      onNone: () => ({}),
      onSome: (tokens) => ({ compaction: { keepRecentTokens: tokens } }),
    });

    return yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(storage, { models, registry, settings }, context)
      ),
      (harness) =>
        Effect.promise(async () => {
          await harness.close(context);
        })
    );
  });

const messagesOf = async (conversation: Conversation) => {
  const view = await conversation.context(context);

  return view.messages;
};

const lastReply = (
  messages: ReadonlyArray<Message>
): Option.Option<AssistantMessage> =>
  Option.fromUndefinedOr(
    messages.findLast(
      (message): message is AssistantMessage => message.role === "assistant"
    )
  );

let requests = 0;

/** Submits `content` and waits until the conversation is idle; returns the newest assistant reply. */
const send = async (
  conversation: Conversation,
  content: Extract<Message, { role: "user" }>["content"]
): Promise<Option.Option<AssistantMessage>> => {
  requests += 1;

  await conversation.submit(
    { type: "input", content, requestId: `live-${requests}` },
    context
  );
  await conversation.waitForIdle(context);

  return lastReply(await messagesOf(conversation));
};

const textOf = (reply: Option.Option<AssistantMessage>) =>
  Option.match(reply, {
    onNone: () => "",
    onSome: (message) =>
      message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(""),
  });

const usageOf = (reply: Option.Option<AssistantMessage>) =>
  Option.match(reply, {
    onNone: () => ({ stop: "none", error: "", cacheRead: 0, cacheWrite: 0 }),
    onSome: (message) => ({
      stop: message.stopReason,
      error: message.errorMessage ?? "",
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
    }),
  });

const answered = (reply: Option.Option<AssistantMessage>) =>
  Option.exists(reply, (message) => message.stopReason === "stop");

/** Every scratch root made so far; a case's roots are removed after it, even when it timed out. */
const scratchRoots: Array<string> = [];

/** A fresh scratch directory (the thread's cwd) with a store beside it. */
const scratch = (name: CaseName) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `cairn-${name}-`)));

  scratchRoots.push(root);

  return { root, file: path.join(root, "brain.sqlite") };
};

/** Claude Code's project folder for `cwd`: every `/` and `.` of the realpath becomes `-`. */
const projectFolder = (cwd: string) =>
  path.join(homedir(), ".claude", "projects", cwd.replaceAll(/[/.]/gu, "-"));

const newConversation = (harness: OpenHarness, cwd: string) =>
  Effect.promise(
    async () =>
      await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { model: CLAUDE, cwd } },
        context
      )
  );

const randomNumber = Random.nextIntBetween(1000, 9999);

// The cases.

const SYNTHETIC = 30;

const syntheticName = (index: number) =>
  `synthetic_${String(index).padStart(2, "0")}`;

const syntheticTools = defineExtension({
  name: "cairn.judge.synthetic",
  tools: Array.from({ length: SYNTHETIC }, (_, index) =>
    defineTool({
      name: syntheticName(index),
      description: `Synthetic tool number ${index}. Returns a token proving it ran.`,
      parameters: Type.Object({ note: Type.String() }),
      replay: "safe",
      execute: async () =>
        await Promise.resolve({
          output: [{ type: "text" as const, text: `token-${index}-ok` }],
        }),
    })
  ),
});

const toolsCase = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Effect.gen(function* () {
    const { root, file } = scratch("tools");
    const codemode = yield* CodeMode;

    const harness = yield* openHarness(
      file,
      [syntheticTools, codemode.extension.extension],
      Option.none()
    );

    const conversation = yield* newConversation(harness, root);

    const reply = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          "Call the tool synthetic_17 directly (not through code mode) with note 'j5', once. Then reply with the token it returned and nothing else."
        )
    );

    const messages = yield* Effect.promise(
      async () => await messagesOf(conversation)
    );

    const calls = messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) =>
            block.type === "toolCall" ? [block.name] : []
          )
        : []
    );

    const initTools = (yield* Ref.get(log)).flatMap(
      (opened) => opened.initTools
    );

    const listed = (name: string) =>
      initTools.some((tool) => tool.endsWith(`__${name}`));

    const checks = {
      everySyntheticListed: Array.from({ length: SYNTHETIC }, (_, index) =>
        syntheticName(index)
      ).every(listed),
      codemodeListed: listed("codemode"),
      noToolSearch: !initTools.some((tool) => tool.includes("ToolSearch")),
      noToolSearchCall: !calls.some((name) => name.includes("ToolSearch")),
      calledDirectly: calls.includes(syntheticName(17)),
      answered: answered(reply) && textOf(reply).includes("token-17-ok"),
    };

    return {
      checks,
      initTools: initTools.length,
      calls,
      reply: textOf(reply),
      usage: usageOf(reply),
      root,
    };
  });

const TranscriptLine = Schema.Struct({
  type: Schema.String,
  message: Schema.Struct({
    id: Schema.String,
    content: Schema.Array(Schema.Struct({ type: Schema.String })),
  }),
});

const decodeTranscriptLine = Schema.decodeOption(
  Schema.fromJsonString(TranscriptLine)
);

/** The tool_use count of each API message in the Claude Code transcripts written for `cwd`. */
const toolUsesPerMessage = (cwd: string): ReadonlyArray<number> => {
  const folder = projectFolder(cwd);

  if (!existsSync(folder)) {
    return [];
  }

  const perMessage = new Map<string, number>();

  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }

    for (const line of readFileSync(path.join(folder, name), "utf-8").split(
      "\n"
    )) {
      const entry = decodeTranscriptLine(line);

      if (Option.isNone(entry) || entry.value.type !== "assistant") {
        continue;
      }

      const { id, content } = entry.value.message;
      const uses = content.filter((block) => block.type === "tool_use").length;

      perMessage.set(id, (perMessage.get(id) ?? 0) + uses);
    }
  }

  return [...perMessage.values()];
};

const parallelCase = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Effect.gen(function* () {
    const { root, file } = scratch("parallel");

    const harness = yield* openHarness(file, [syntheticTools], Option.none());
    const conversation = yield* newConversation(harness, root);

    const reply = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          "Call synthetic_03 with note 'a' and synthetic_21 with note 'b' in the same response, as two parallel tool calls in one message, not one after the other. Then reply with both tokens they returned and nothing else."
        )
    );

    const messages = yield* Effect.promise(
      async () => await messagesOf(conversation)
    );

    const callsPerReply = messages.flatMap((message) =>
      message.role === "assistant"
        ? [
            message.content.flatMap((block) =>
              block.type === "toolCall" ? [block.id] : []
            ),
          ]
        : []
    );

    const delivered = callsPerReply.find((ids) => ids.length >= 2) ?? [];

    const committed = new Set(
      messages.flatMap((message) =>
        message.role === "toolResult" ? [message.toolCallId] : []
      )
    );

    const parallelInOneMessage = toolUsesPerMessage(root).some(
      (uses) => uses >= 2
    );

    const checks = {
      parallelInOneMessage,
      bothCallsInOneReply: delivered.length >= 2,
      bothResultsCommitted:
        delivered.length >= 2 && delivered.every((id) => committed.has(id)),
      answered:
        answered(reply) &&
        textOf(reply).includes("token-3-ok") &&
        textOf(reply).includes("token-21-ok"),
    };

    return {
      checks,
      inconclusive: !parallelInOneMessage,
      callsPerReply: callsPerReply.map((ids) => ids.length),
      sessions: (yield* Ref.get(log)).map((opened) => opened.session),
      reply: textOf(reply),
      usage: usageOf(reply),
      root,
    };
  });

const pasteCase = Effect.gen(function* () {
  const { root, file } = scratch("paste");
  const harness = yield* openHarness(file, [], Option.none());
  const conversation = yield* newConversation(harness, root);
  const words = ["KESTREL", "MARLIN", "BISON", "OTTER", "HERON", "LYNX"];
  const index = yield* Random.nextIntBetween(0, words.length - 1);
  const nonce = `${words[index] ?? "HERON"}${yield* randomNumber}`;

  const png = execFileSync("magick", [
    "-size",
    "900x220",
    "xc:white",
    "-fill",
    "black",
    "-pointsize",
    "96",
    "-annotate",
    "+40+150",
    nonce,
    "png:-",
  ]);

  const reply = yield* Effect.promise(
    async () =>
      await send(conversation, [
        {
          type: "text",
          text: "What word is written in this screenshot? Reply with the word only.",
        },
        {
          type: "image",
          data: png.toString("base64"),
          mimeType: "image/png",
        },
      ])
  );

  return {
    checks: {
      answered: answered(reply),
      readTheWord: textOf(reply).toUpperCase().includes(nonce),
    },
    nonce,
    bytes: png.length,
    reply: textOf(reply),
    usage: usageOf(reply),
    root,
  };
});

const compactionCase = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Effect.gen(function* () {
    const { root, file } = scratch("compaction");
    const harness = yield* openHarness(file, [], Option.some(1));
    const conversation = yield* newConversation(harness, root);
    const code = yield* randomNumber;

    const first = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          `Remember this for later: the vault code is ${code}. Reply with OK only.`
        )
    );

    const second = yield* Effect.promise(
      async () =>
        await send(conversation, "Name one colour of the rainbow, one word.")
    );

    const compacted = yield* Effect.promise(async () => {
      const task = await conversation.compact(undefined, context);
      const settled = await harness.waitForTask(task, context);

      await conversation.waitForIdle(context);

      return settled;
    });

    const after = yield* Effect.promise(
      async () => await messagesOf(conversation)
    );

    const opensBefore = (yield* Ref.get(log)).length;

    const third = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          "What is the vault code? Reply with the number only."
        )
    );

    const opened = (yield* Ref.get(log)).slice(opensBefore);

    return {
      checks: {
        firstTurns: answered(first) && answered(second),
        compacted: compacted.state.outcome.status === "completed",
        // The stamped reply that held the fact is summarized away; the kept tail may keep a later one.
        factReplyGone: Option.exists(
          Option.flatMap(first, stampOf),
          (stamp) =>
            !after.some((message) =>
              Option.exists(
                stampOf(message),
                (kept) => kept.ccUuid === stamp.ccUuid
              )
            )
        ),
        freshSession: opened.some((child) => child.session.kind === "new"),
        answered: answered(third),
        usedTheFact: textOf(third).includes(String(code)),
      },
      compaction: compacted.state.outcome.status,
      contextAfterCompaction: after.map((message) => message.role),
      sessions: opened.map((child) => child.session.kind),
      reply: textOf(third),
      usage: usageOf(third),
      root,
    };
  });

const switchCase = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Effect.gen(function* () {
    const { root, file } = scratch("switch");
    const harness = yield* openHarness(file, [], Option.none());
    const conversation = yield* newConversation(harness, root);
    const code = yield* randomNumber;

    const first = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          `My locker code is ${code}. Reply with OK only.`
        )
    );

    const other = yield* Effect.promise(async () => {
      await conversation.configure({ model: OTHER }, context);

      const reply = await send(conversation, "My bike is teal. Reply OK.");

      await conversation.configure({ model: CLAUDE }, context);

      return reply;
    });

    const opensBefore = (yield* Ref.get(log)).length;

    const third = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          "What is my locker code, and what colour is my bike? Answer in one short line."
        )
    );

    const opened = (yield* Ref.get(log)).slice(opensBefore);
    const text = textOf(third).toLowerCase();

    return {
      checks: {
        firstTurn: answered(first),
        otherProviderAnswered: Option.exists(
          other,
          (message) => message.provider === "other"
        ),
        answered: answered(third),
        usedClaudeTurn: text.includes(String(code)),
        usedOtherTurn: text.includes("teal"),
      },
      sessions: opened.map((child) => child.session),
      reply: textOf(third),
      usage: usageOf(third),
      root,
    };
  });

const deletedCase = Effect.gen(function* () {
  const { root, file } = scratch("deleted");
  const code = yield* randomNumber;
  const firstLog = yield* Ref.make<ReadonlyArray<Opened>>([]);
  const secondLog = yield* Ref.make<ReadonlyArray<Opened>>([]);

  const [conversationId, first] = yield* Effect.gen(function* () {
    const harness = yield* openHarness(file, [], Option.none());
    const conversation = yield* newConversation(harness, root);

    const reply = yield* Effect.promise(
      async () =>
        await send(
          conversation,
          `Remember: my parcel number is ${code}. Reply with OK only.`
        )
    );

    return [conversation.id, reply] as const;
  }).pipe(Effect.scoped, Effect.provide(bridgeLayer(firstLog)));

  const stamp = Option.flatMap(first, stampOf);

  const transcript = Option.map(stamp, (found) =>
    path.join(projectFolder(root), `${found.ccSessionId}.jsonl`)
  );

  const deleted = Option.match(transcript, {
    onNone: () => false,
    onSome: (found) => {
      try {
        unlinkSync(found);

        return true;
      } catch {
        return false;
      }
    },
  });

  // A new bridge over the same store: the restart.
  const second = yield* Effect.gen(function* () {
    const harness = yield* openHarness(file, [], Option.none());

    return yield* Effect.promise(async () => {
      const conversation = await harness.conversation(conversationId, context);

      return conversation === undefined
        ? Option.none<AssistantMessage>()
        : await send(
            conversation,
            "What is my parcel number? Reply with the number only."
          );
    });
  }).pipe(Effect.scoped, Effect.provide(bridgeLayer(secondLog)));

  const opened = yield* Ref.get(secondLog);

  return {
    checks: {
      firstTurn: answered(first) && Option.isSome(stamp),
      transcriptDeleted: deleted,
      answered: answered(second),
      noError: Option.exists(
        second,
        (message) => message.errorMessage === undefined
      ),
      usedTheFact: textOf(second).includes(String(code)),
    },
    sessions: opened.map((child) => child.session),
    reply: textOf(second),
    usage: usageOf(second),
    root,
  };
});

/**
 * An 800-line ledger, as `durability.ts`'s bridge windows send: about 22K tokens a lost prompt cache
 * rewrites.
 */
const LEDGER = Array.from(
  { length: 800 },
  (_, index) =>
    `Ledger line ${index}: account ${(index * 7919) % 10_007} moved ${(index * 104_729) % 9973} units to bin ${index % 97}.`
).join("\n");

const restartCase = Effect.gen(function* () {
  const { root, file } = scratch("restart");
  const firstLog = yield* Ref.make<ReadonlyArray<Opened>>([]);
  const secondLog = yield* Ref.make<ReadonlyArray<Opened>>([]);

  const turn = <A>(
    log: Ref.Ref<ReadonlyArray<Opened>>,
    use: (harness: OpenHarness) => Promise<A>
  ) =>
    Effect.gen(function* () {
      const codemode = yield* CodeMode;

      const harness = yield* openHarness(
        file,
        [syntheticTools, codemode.extension.extension],
        Option.none()
      );

      return yield* Effect.promise(async () => await use(harness));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(bridgeLayer(log), CodeMode.layer))
    );

  const [id, first] = yield* turn(firstLog, async (harness) => {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: CLAUDE, cwd: root } },
      context
    );

    const reply = await send(
      conversation,
      `<ledger>\n${LEDGER}\n</ledger>\n\nIgnore the ledger. Reply with OK only.`
    );

    return [conversation.id, reply] as const;
  });

  const second = yield* turn(secondLog, async (harness) => {
    const conversation = await harness.conversation(id, context);

    return conversation === undefined
      ? Option.none<AssistantMessage>()
      : await send(conversation, "Reply with OK again.");
  });

  const tools = (log: ReadonlyArray<Opened>) =>
    log.flatMap((opened) => opened.initTools).join(",");

  const before = yield* Ref.get(firstLog);
  const after = yield* Ref.get(secondLog);
  const usage = usageOf(second);

  return {
    checks: {
      firstTurn: answered(first),
      resumed: after.some((opened) => opened.session.kind === "resume"),
      sameTools: tools(before) === tools(after),
      answered: answered(second),
      cacheKept:
        usage.cacheRead > 0 && usage.cacheRead >= 10 * usage.cacheWrite,
    },
    sessions: after.map((opened) => opened.session),
    firstUsage: usageOf(first),
    usage,
    root,
  };
});

/** How long a killed child gets to exit before its transcript folder is removed again. */
const CHILD_EXIT_GRACE = Duration.seconds(3);

/** How long one case may take before it is reported as failed. */
const CASE_DEADLINE = Duration.minutes(5);

const deadlineOf = (name: CaseName) =>
  name === "parallel" ? Duration.minutes(2) : CASE_DEADLINE;

/**
 * Removes the scratch roots made since `from`, and the transcripts Claude Code wrote for them. A
 * killed child is closed on another fiber and writes its transcript once more as it exits, so the
 * folders are removed again after it has had time to.
 */
const removeScratch = (from: number) =>
  Effect.gen(function* () {
    const roots = scratchRoots.splice(from);

    const remove = Effect.sync(() => {
      for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
        rmSync(projectFolder(root), { recursive: true, force: true });
      }
    });

    yield* remove;
    yield* Effect.sleep(CHILD_EXIT_GRACE);
    yield* remove;
  });

/** Runs one case with its own bridge (except `deleted`, which makes two), and prints its line. */
const runCase = (name: CaseName) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<Opened>>([]);
    const firstRoot = scratchRoots.length;

    const withBridge = <A, E>(
      effect: Effect.Effect<A, E, Claude | BridgeCwd | CodeMode | Scope.Scope>
    ) =>
      effect.pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(bridgeLayer(log), CodeMode.layer))
      );

    const cases: Record<
      CaseName,
      Effect.Effect<{ readonly checks: object; readonly root: string }>
    > = {
      tools: withBridge(toolsCase(log)),
      parallel: withBridge(parallelCase(log)),
      paste: withBridge(pasteCase),
      compaction: withBridge(compactionCase(log)),
      switch: withBridge(switchCase(log)),
      deleted: deletedCase,
      restart: restartCase,
    };

    const result = yield* cases[name].pipe(
      Effect.timeoutOption(deadlineOf(name)),
      Effect.ensuring(removeScratch(firstRoot))
    );

    const line = Option.match(result, {
      onNone: () => ({
        case: name,
        pass: false,
        timedOut: true,
        deadlineMs: Duration.toMillis(deadlineOf(name)),
      }),
      onSome: (value) => ({
        case: name,
        pass: Object.values(value.checks).every(Boolean),
        ...value,
      }),
    });

    yield* Effect.sync(() => {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    });

    return line.pass;
  });

const program = Effect.gen(function* () {
  const passes = yield* Effect.forEach(chosen, runCase);
  const failed = chosen.filter((_, index) => passes[index] !== true);

  if (failed.length > 0) {
    return yield* new ClaudeLiveFailed({
      message: `claude-live failed: ${failed.join(", ")}`,
    });
  }

  return chosen.length;
});

NodeRuntime.runMain(program);
