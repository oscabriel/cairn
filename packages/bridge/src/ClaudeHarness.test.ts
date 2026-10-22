// The bridge under a bare pi-durable Harness (no server): a reply's stamp commits with the assistant
// entry, survives closing and reopening the store, and drives a native resume in a new process (J4).
// pi-durable is a dev dependency of this package for exactly this judge; it is imported nowhere in
// the bridge's own modules.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
// The bridge is tested against a bare Harness here; only this judge imports pi-durable.
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";

import { Claude } from "./Claude.ts";
import { ClaudeAccount } from "./ClaudeAccount.ts";
import type { ChildSession } from "./ClaudeGuards.ts";
import { ClaudeOneShot } from "./ClaudeOneShot.ts";
import { blocksText } from "./ClaudePrompt.ts";
import { initEvent, SCRIPT_SESSION, textTurn } from "./ClaudeScriptKit.ts";
import type { FakeScript, SessionEntry } from "./ClaudeSdk.ts";
import { ClaudeSdk, ClaudeSdkScripts } from "./ClaudeSdk.ts";
import { ClaudeSlots } from "./ClaudeSlots.ts";
import { stampOf } from "./ClaudeStamp.ts";

const context = BACKGROUND_CONTEXT;

const helloEntry: SessionEntry = {
  uuid: "u0",
  role: "assistant",
  toolUseIds: [],
  toolResultIds: [],
};

const bridge = (
  scripts: ReadonlyArray<FakeScript>,
  sessions: ReadonlyMap<string, ReadonlyArray<SessionEntry>>
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

const lastAssistant = (messages: ReadonlyArray<Message>) =>
  Option.fromNullishOr(
    messages.findLast((message) => message.role === "assistant")
  );

const stampOfReply = (reply: Option.Option<Message>) =>
  Option.flatMap(reply, (message) =>
    Option.map(stampOf(message), (stamp) => [stamp.ccSessionId, stamp.ccUuid])
  );

/** Answers the first turn with "hello", chain entry u0. */
const saysHello: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.record(SCRIPT_SESSION, helloEntry);
    yield* io.emit(initEvent(SCRIPT_SESSION), ...textTurn("m0", "u0", "hello"));

    return yield* Effect.never;
  });

/** Opens the store at `file` with the bridge in context, runs `use` on it, and closes it. */
const withHarness = <A>(
  file: string,
  use: (harness: Awaited<ReturnType<typeof Harness.open>>) => Promise<A>
) =>
  Effect.gen(function* () {
    const claude = yield* Claude;
    const models = createModels();

    models.setProvider(claude.provider);

    const storage = yield* Effect.promise(
      async () => await openNodeSqliteStorage(file)
    );

    return yield* Effect.acquireUseRelease(
      Effect.promise(
        async () =>
          await Harness.open(
            storage,
            { models, registry: createRegistry() },
            context
          )
      ),
      (harness) => Effect.promise(async () => await use(harness)),
      (harness) =>
        Effect.promise(async () => {
          await harness.close(context);
        })
    );
  });

const contextMessages = async (conversation: {
  context: (
    c: typeof context
  ) => Promise<{ readonly messages: ReadonlyArray<Message> }>;
}) => {
  const view = await conversation.context(context);

  return view.messages;
};

describe("the bridge under pi-durable", () => {
  it.live(
    "commits the stamp with the reply, keeps it across a reopen, and resumes from it in a new process",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(path.join(tmpdir(), "cairn-bridge-harness-"));
        const file = path.join(dir, "brain.sqlite");
        const prompts: Array<string> = [];
        const opened: Array<ChildSession> = [];

        const resumes: FakeScript = (io) =>
          Effect.gen(function* () {
            const prompt = yield* io.nextPrompt;

            opened.push(io.options.session);
            prompts.push(
              Option.match(prompt, {
                onNone: () => "",
                onSome: (message) => blocksText(message.blocks),
              })
            );
            yield* io.emit(
              initEvent(SCRIPT_SESSION),
              ...textTurn("m1", "u1", "hello again")
            );

            return yield* Effect.never;
          });

        const conversationId = yield* withHarness(file, async (harness) => {
          const conversation = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: {
                model: {
                  provider: "claude-bridge",
                  modelId: "claude-haiku-5-5",
                },
              },
            },
            context
          );

          await conversation.submit(
            { type: "input", content: "hi", requestId: "r1" },
            context
          );
          await conversation.waitForIdle(context);

          return conversation.id;
        }).pipe(Effect.provide(bridge([saysHello], new Map())));

        // A new process: a new bridge with no memory, and Claude Code's transcript on disk.
        const replies = yield* withHarness(file, async (harness) => {
          const conversation = await harness.conversation(
            conversationId,
            context
          );

          if (conversation === undefined) {
            return {
              before: Option.none<Message>(),
              after: Option.none<Message>(),
            };
          }

          const before = lastAssistant(await contextMessages(conversation));

          await conversation.submit(
            { type: "input", content: "again", requestId: "r2" },
            context
          );
          await conversation.waitForIdle(context);

          return {
            before,
            after: lastAssistant(await contextMessages(conversation)),
          };
        }).pipe(
          Effect.provide(
            bridge([resumes], new Map([[SCRIPT_SESSION, [helloEntry]]]))
          )
        );

        rmSync(dir, { recursive: true, force: true });

        expect(stampOfReply(replies.before)).toStrictEqual(
          Option.some([SCRIPT_SESSION, "u0"])
        );
        expect(stampOfReply(replies.after)).toStrictEqual(
          Option.some([SCRIPT_SESSION, "u1"])
        );
        expect([prompts, opened]).toStrictEqual([
          ["again"],
          [
            {
              kind: "resume",
              sessionId: SCRIPT_SESSION,
              at: Option.none(),
              fork: false,
            },
          ],
        ]);
      })
  );
});
