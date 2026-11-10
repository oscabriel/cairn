// Boot's crash accounting (ADR 0046): which live tasks crashes cut off too often end, and which
// waits Cairn keeps however often the brain dies. The rule is pure (`crashLooped`); the live case
// runs it on a real pi-durable store whose Session fails under its running calls past the limit, as
// `kill -9` would leave it, and the kill judge (`judges/approval-kill.ts`) shows it on the brain.

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Function, Option, Schema } from "effect";
import { Type } from "typebox";

import { KEPT_WAITS } from "../BootRepairs.ts";
import { eventuallyTrue, testLimit } from "../EventuallyTestKit.ts";
import { conversationOf, taskOf } from "../subagents/Delivery.ts";
import { Approvals, approvalIdOf } from "./CairnDocs.ts";
import { conformanceTools } from "./conformance/ConformanceTools.ts";
import {
  CRASH_LIMIT,
  crashLooped,
  endCrashLoopedIn,
  namedWaits,
  TOOL_TASK,
} from "./CrashLimit.ts";
import type { CountedTask } from "./CrashLimit.ts";

const task = (
  id: number,
  kind: string,
  restarts: number,
  abortRequested = false
): CountedTask => ({
  id: taskOf(id),
  kind,
  conversationId: conversationOf(1),
  abortRequested,
  restarts,
  input: null,
});

/** A tool call nested under the tool call `owner` (a code mode script's call). */
const nested = (id: number, restarts: number, owner: number): CountedTask => ({
  ...task(id, TOOL_TASK, restarts),
  owner: taskOf(owner),
});

/** A nested call of `name` under `owner`, cut off the limit's number of times. */
const nestedCall = (id: number, name: string, owner: number): CountedTask => ({
  ...nested(id, CRASH_LIMIT, owner),
  input: { kind: "nested", call: { name, arguments: {} } },
});

const ids = (tasks: ReadonlyArray<CountedTask>) =>
  tasks.map(({ id }) => Number(id));

const KINDS = new Set(["cairn.subagent-reporter"]);

const NO_WAITS: ReadonlySet<number> = new Set();

describe("the crash accounting", () => {
  it("ends work cut off the limit's number of times, and none below it", () => {
    assert.deepStrictEqual(
      ids(
        crashLooped(
          [
            task(1, "pi.generation", CRASH_LIMIT),
            task(2, "pi.compaction", CRASH_LIMIT - 1),
            task(3, "cairn.judge-run", CRASH_LIMIT + 3),
          ],
          { kinds: KINDS, waits: NO_WAITS }
        )
      ),
      [1, 3]
    );
  });

  it("ends a tool call that waits on nothing, and keeps one that waits however often crashes cut it off", () => {
    assert.deepStrictEqual(
      ids(
        crashLooped(
          [
            task(11, TOOL_TASK, CRASH_LIMIT),
            task(12, TOOL_TASK, CRASH_LIMIT * 20),
          ],
          { kinds: KINDS, waits: new Set([12]) }
        )
      ),
      [11]
    );
  });

  it("keeps every tool call above a call that waits, so a script outlives its nested approval", () => {
    assert.deepStrictEqual(
      ids(
        crashLooped(
          [
            task(20, TOOL_TASK, CRASH_LIMIT * 2),
            nested(21, CRASH_LIMIT * 2, 20),
            nested(22, CRASH_LIMIT, 21),
            // A sibling that waits on nothing is still ended.
            nested(23, CRASH_LIMIT, 20),
          ],
          { kinds: KINDS, waits: new Set([22]) }
        )
      ),
      [23]
    );
  });

  it("keeps a workflow node still queued for its slot, which holds no record yet, by its name", () => {
    // Script 30 is a workflow's script call; node 31 reserved and holds its record; nodes 32 and
    // 33 wait for a node slot, so they have not reserved; 34 is a nested read that waits on
    // nothing. The brain keeps what holds a record or a script (30, 31) and what `namedWaits` names.
    const tasks = [
      task(30, TOOL_TASK, CRASH_LIMIT),
      nestedCall(31, "agent", 30),
      nestedCall(32, "agent", 30),
      nestedCall(33, "verify", 30),
      nestedCall(34, "read", 30),
    ];

    const named = namedWaits(tasks, KEPT_WAITS.tools);

    assert.deepStrictEqual(
      ids(
        crashLooped(tasks, {
          kinds: KEPT_WAITS.kinds,
          waits: new Set([30, 31, ...named]),
        })
      ),
      [34]
    );
  });

  it("keeps the kinds it is told to, and leaves a task already marked for abort", () => {
    assert.deepStrictEqual(
      ids(
        crashLooped(
          [
            task(1, "cairn.subagent-reporter", CRASH_LIMIT * 4),
            task(2, "pi.generation", CRASH_LIMIT, true),
          ],
          { kinds: KINDS, waits: NO_WAITS }
        )
      ),
      []
    );
  });
});

// The live case: one model turn calls three tools at once. `gate` waits on its approval record;
// `linger` waits with no record, a tool the caller names; `hang` waits on nothing, as a read or a
// script the brain keeps dying in would. Each life resumes the Harness until the three run, then
// fails its Session with a commit the storage rejects, so nothing more is written: the next open
// counts a restart for each, as after `kill -9` (a clean close counts none).

const MODEL = { provider: "faux", modelId: "crash" } as const;

/** A replay-safe tool that runs until its call is aborted. */
const runsUntilAborted = (name: string) =>
  defineTool({
    name,
    description: `Runs until it is stopped (${name}).`,
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, _api, context) => {
      const { abortSignal } = context;

      if (abortSignal !== undefined && !abortSignal.aborted) {
        await once(abortSignal, "abort");
      }

      return { output: [{ type: "text", text: `${name} stopped` }] };
    },
  });

const waitTools = defineExtension({
  name: "crash-limit-test",
  tools: [runsUntilAborted("hang"), runsUntilAborted("linger")],
});

const context = BACKGROUND_CONTEXT;

/** A document the test writes only to have a commit the storage rejects. */
const Poke = defineDoc<{ [key: string]: JsonValue; n: number }>({
  kind: "crash-limit-test.poke",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ n: 0 }),
  checkpointWhen: () => false,
});

/** One life of the store: a Harness over it, with the turn's tools and the faux model. */
const openLife = async (store: string) => {
  const faux = fauxProvider({
    provider: MODEL.provider,
    models: [{ id: MODEL.modelId }],
  });

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("gate", {}, { id: "g" }),
        fauxToolCall("hang", {}, { id: "h" }),
        fauxToolCall("linger", {}, { id: "l" }),
      ],
      { stopReason: "toolUse" }
    ),
    ...Array.from({ length: 5 }, () => fauxAssistantMessage("done")),
  ]);

  const models = createModels();

  models.setProvider(faux.provider);

  const registry = createRegistry();

  registry.install(conformanceTools.extension);
  registry.install(waitTools);

  const storage = await openNodeSqliteStorage(store);
  const commit = storage.commit.bind(storage);
  const crashing = { value: false };

  storage.commit = async (batches, receive, commitContext) => {
    if (crashing.value) {
      throw new Error("the brain died (test)");
    }

    return await commit(batches, receive, commitContext);
  };

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        retry: { enabled: false },
        restartLimit: Number.POSITIVE_INFINITY,
      },
    },
    context
  );

  /** Ends this life as a crash does: the Session fails, and nothing more reaches the store. */
  const crash = async (conversationId: ConversationId) => {
    crashing.value = true;

    await harness
      .commit(async (tx) => {
        const poke = await tx.doc(Poke, conversationId);

        poke.n += 1;
      }, context)
      .catch(Function.constVoid);

    const end = await harness.closed;

    assert.strictEqual(end.kind, "failed");
  };

  return { harness, crash };
};

/** The live tool call tasks of a Harness, with their scheduling state. */
const toolTasks = async (harness: Harness) => {
  const inspection = await harness.inspect(context);

  return inspection.tasks
    .map(({ record, state }) => ({ record, state: state.kind }))
    .filter(({ record }) => record.kind === TOOL_TASK);
};

/** The tool each call id of the turn calls. */
const CALL_OF = new Map([
  ["g", "gate"],
  ["h", "hang"],
  ["l", "linger"],
]);

const decodeCallId = Schema.decodeUnknownOption(
  Schema.Struct({ callId: Schema.String })
);

/** The tool a tool task calls, read from its input's call id. */
const toolOf = (input: JsonValue): string =>
  Option.match(decodeCallId(input), {
    onNone: () => "",
    onSome: ({ callId }) => CALL_OF.get(callId) ?? callId,
  });

/** Polls `done` until it holds, or dies naming `what` once `eventually`'s deadline passes. */
const until = async (what: string, done: () => Promise<boolean>) => {
  await Effect.runPromise(eventuallyTrue(Effect.promise(done), what));
};

/** The names of the running tool calls, sorted. */
const runningTools = async (harness: Harness) => {
  const live = await toolTasks(harness);

  return live
    .filter(({ state }) => state === "running")
    .map(({ record }) => toolOf(record.input))
    .toSorted();
};

/** Whether the three calls run, and `gate` has asked for its approval. */
const allRun = async (harness: Harness, conversationId: ConversationId) => {
  const running = await runningTools(harness);
  const approvals = await harness.snapshot(Approvals, conversationId, context);

  return (
    running.join(",") === "gate,hang,linger" &&
    Object.values(approvals?.items ?? {}).some(
      (record) => record.status === "pending"
    )
  );
};

/** The text of each tool result in the conversation, by tool name, as `harness` reads it. */
const resultsOf = async (harness: Harness, conversationId: ConversationId) => {
  const current = await harness.conversation(conversationId, context);
  const page = await current?.entries({}, 50, undefined, context);

  if (page === undefined) {
    throw new Error("the conversation is gone");
  }

  return new Map(
    page.items
      .filter((entry) => entry.kind === "pi.tool-result")
      .flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.role === "toolResult"
            ? [
                [
                  message.toolName,
                  message.content
                    .map((part) => (part.type === "text" ? part.text : ""))
                    .join(""),
                ] as const,
              ]
            : []
        )
      )
  );
};

/** Starts the turn in a first life. */
const startTurn = async (
  harness: Harness,
  cwd: string
): Promise<Conversation> => {
  harness.resume();

  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: { ...MODEL }, cwd } },
    context
  );

  await conversation.submit(
    { type: "input", content: "Go.", requestId: "r-1" },
    context
  );

  return conversation;
};

/** Lives two to the limit: each runs the three again and crashes under them. */
const crashAgain = async (
  store: string,
  conversationId: ConversationId,
  lives: number
): Promise<void> => {
  if (lives === 0) {
    return;
  }

  const life = await openLife(store);

  life.harness.resume();
  await until(
    "the three calls never ran again",
    async () => await allRun(life.harness, conversationId)
  );
  await life.crash(conversationId);
  await crashAgain(store, conversationId, lives - 1);
};

describe("the crash accounting on a real store", () => {
  it.live(
    "ends a call that waits on nothing at the limit, and keeps an approval and a named wait",
    () =>
      Effect.promise(async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "cairn-crash-limit-"));
        const store = path.join(dir, "brain.sqlite");

        try {
          const first = await openLife(store);
          const { id } = await startTurn(first.harness, dir);

          await until(
            "the three calls never ran",
            async () => await allRun(first.harness, id)
          );
          await first.crash(id);
          await crashAgain(store, id, CRASH_LIMIT - 1);

          // The boot after the last crash: every call cut off `CRASH_LIMIT` times.
          const { harness: boot } = await openLife(store);
          const before = await toolTasks(boot);

          assert.deepStrictEqual(
            before.map(({ record }) => record.restarts),
            [CRASH_LIMIT, CRASH_LIMIT, CRASH_LIMIT]
          );

          const count = await endCrashLoopedIn(
            boot,
            { kinds: new Set(), tools: new Set(["linger"]) },
            context
          );

          assert.strictEqual(count.cutOff, 3);
          assert.deepStrictEqual(
            count.ended.map((ended) => toolOf(ended.input)),
            ["hang"]
          );

          boot.resume();

          await until("hang never ended", async () => {
            const results = await resultsOf(boot, id);

            return results.has("hang");
          });

          const results = await resultsOf(boot, id);

          // `hang` ended through its abort handler, with a result the model reads.
          assert.include(results.get("hang") ?? "", "Tool hang was aborted");
          assert.isFalse(results.has("gate"));
          assert.isFalse(results.has("linger"));

          // The approval and the named wait run on, and the approval can still be answered.
          await until("gate and linger did not run again", async () => {
            const running = await runningTools(boot);
            const live = await toolTasks(boot);

            return live.length === 2 && running.join(",") === "gate,linger";
          });

          const approvals = await boot.snapshot(Approvals, id, context);
          const live = await toolTasks(boot);

          const gate = live.find(
            ({ record }) => toolOf(record.input) === "gate"
          );

          assert.isDefined(gate);
          assert.strictEqual(
            approvals?.items[approvalIdOf(Number(gate?.record.id))]?.status,
            "pending"
          );

          await boot.close(context);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
    testLimit(30_000)
  );
});
