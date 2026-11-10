// A brief's model and the brain's cap over a real pi-durable brain (the conformance suite's
// composition, with model health in reach so a test can mark a provider limited), ADR 0043:
//
// - a brief that names no model runs its child on the parent's model and level, and its dispatch
//   record names them;
// - a named `provider/modelId:level` is the child's model and level (`pi.agent`), as its dispatch
//   record names;
// - a named model that is not ready is refused at the ask with its reason, and a role name
//   (`@worker`) is refused as no model;
// - a model that was ready at the ask but not at Go starts nothing, and the parent is told once;
// - the brain-wide cap (`maxLivePerBrain`, 32 in production, 2 here) counts every thread's
//   children: a second thread's spawn past it is refused, while its own cap of 8 is far off;
// - a budget covering the parent at its line when the user says Go starts nothing (ADR 0036, the
//   check wave 4 left for Go's start task), and the parent is told once.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApprovalId, ProjectId } from "@cairn/protocol/Ids";
import type { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect";

import { eventuallySome as waitFor, testLimit } from "../EventuallyTestKit.ts";
import { HealthOutcome, ModelHealth } from "../models/ModelHealth.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import type { SubagentToolOptions } from "../subagents/SubagentTools.ts";
import { BudgetBook } from "../usage/BudgetBook.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { brainExtensions } from "./BrainTestKit.ts";
import { Approvals } from "./CairnDocs.ts";
import { conformanceTools } from "./conformance/ConformanceTools.ts";
import { childWorkspacesAt } from "./conformance/Targets.ts";
import { durable } from "./Durable.ts";
import { FauxModels, FAUX_MODEL } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";
import { piConversationId } from "./PiIds.ts";
import { SubagentsDoc } from "./SubagentDocs.ts";
import { NO_SUBAGENT_FAULTS } from "./SubagentFaults.ts";
import { renderBriefAnswer, SubagentToolText } from "./SubagentText.ts";

const PARENT = testThreadId(1);

/** A default budget set in the server settings: a dollar line and a token line. */
const SET_DEFAULT = {
  ...DEFAULT_BUDGET,
  maxListMicros: Micros.make(1_000_000),
  maxTokens: 300_000,
};

const OTHER_PARENT = testThreadId(2);

/** The brain the conformance suite runs, with `ModelHealth` left in reach. */
const brainLayer = (dataDir: string, tuning: SubagentToolOptions) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      brainExtensions({
        extra: [conformanceTools],
        subagents: Subagents.layerWith(NO_SUBAGENT_FAULTS, tuning),
      })
    ),
    // The book the production set's gate and Go's start task read (one, by the memo map).
    Layer.provideMerge(BudgetBook.layer),
    Layer.provideMerge(ModelHealth.layerTest),
    Layer.provideMerge(SettingsStore.layerTest),
    Layer.provideMerge(
      FauxModels.layer({
        tokensPerSecond: 2000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provideMerge(childWorkspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

type Services = Layer.Success<ReturnType<typeof brainLayer>>;

/** What a test body gets: the brain's events so far and the parent's conversation. */
interface Running {
  readonly events: Ref.Ref<ReadonlyArray<HarnessEvent>>;
  readonly parent: ConversationId;
}

/** A spawn of `description` naming `model`, as the faux model calls it. */
const spawnCall = (description: string, model: string | null, id: string) => {
  const brief = `${description}, please.`;

  if (model === null) {
    return fauxToolCall("subagent_spawn", { description, brief }, { id });
  }

  return fauxToolCall("subagent_spawn", { description, brief, model }, { id });
};

/** Ensures `threadId` on the faux model at level `off`. */
const ensure = (threadId: ThreadId) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.ensureThread({
      threadId,
      projectId: ProjectId.make("models"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd: process.cwd(),
      instructions: Option.none(),
      runtimeMode: "full-access",
    })
  );

/** Over a fresh brain: the parent thread on the faux model at level `off`, resumed. */
const withBrain = <A, E>(
  tuning: SubagentToolOptions,
  responses: ReadonlyArray<ReturnType<typeof fauxAssistantMessage>>,
  body: (running: Running) => Effect.Effect<A, E, Services>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-models-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(brainLayer(dataDir, tuning));
          const seam = Context.get(context, HarnessSeam);
          const { faux } = Context.get(context, FauxModels);
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );

          faux.setResponses([...responses]);
          yield* Context.get(context, Brain).resume;

          const ensured = yield* ensure(PARENT).pipe(
            Effect.provideContext(context)
          );

          return yield* body({
            events,
            parent: ensured.conversationId,
          }).pipe(Effect.provideContext(context));
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

const ask = (threadId: ThreadId, requestId: string) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.submit(threadId, {
      requestId,
      content: [{ type: "text", text: "delegate it" }],
      entry: Option.none(),
      whenBusy: "followUp",
    })
  );

/** Waits for the `count`th completed run of `threadId`. */
const runsEnded = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId,
  count: number
) =>
  waitFor(
    Effect.map(Ref.get(events), (all) =>
      all.filter(
        (event) =>
          Predicate.isTagged(event, "RunTerminal") &&
          event.threadId === threadId
      ).length >= count
        ? Option.some(true)
        : Option.none()
    )
  );

/** The pending briefs of `threadId`, from the brain's events. */
const pendingBriefs = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId
) =>
  Effect.map(Ref.get(events), (all) =>
    all.flatMap((event) =>
      Predicate.isTagged(event, "RuntimeRequestUpdated") &&
      event.threadId === threadId &&
      event.kind === "brief" &&
      event.status === "pending"
        ? [event.id]
        : []
    )
  );

/** Reads through the brain's Harness. */
const read = <A>(
  name: string,
  body: (
    harness: Effect.Success<Brain["Service"]["session"]>["harness"],
    context: Parameters<
      Effect.Success<Brain["Service"]["session"]>["harness"]["inspect"]
    >[0]
  ) => Promise<A>
) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.flatMap(Brain, (brain) => brain.session);

    return yield* durable(
      name,
      async (context) => await body(harness, context)
    );
  }).pipe(Effect.orDie);

/** Every entry of `conversation`, as one JSON text, to search for what the model read. */
const transcriptOf = (conversation: ConversationId) =>
  read("test.entries", async (harness, context) => {
    const page = await harness.commit(
      async (tx) =>
        await tx.scanEntries(
          {
            conversationId: piConversationId(conversation),
            order: "ascending",
          },
          200
        ),
      context
    );

    return JSON.stringify(page.items);
  });

/** Marks the faux provider limited, as a plan's usage limit would. */
const limitFaux = Effect.gen(function* () {
  const health = yield* ModelHealth;

  yield* health.record(
    FAUX_MODEL.provider,
    HealthOutcome.Failed({
      at: yield* DateTime.now,
      message:
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.",
    })
  );
}).pipe(Effect.orDie);

/** The first pending brief of `threadId`, once there is one. */
const firstBrief = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId
) =>
  waitFor(
    Effect.map(pendingBriefs(events, threadId), (ids) =>
      Option.fromUndefinedOr(ids[0])
    )
  );

/** The first child the brain ensured, once there is one. */
const firstChild = (events: Ref.Ref<ReadonlyArray<HarnessEvent>>) =>
  waitFor(
    Effect.map(Ref.get(events), (all) =>
      Option.firstSomeOf(
        all.map((event) =>
          Predicate.isTagged(event, "ThreadEnsured") &&
          Option.isSome(event.parent)
            ? Option.some(event.conversationId)
            : Option.none()
        )
      )
    )
  );

/** The child's `pi.agent` and the parent's registry item for it. */
const dispatchOf = (parent: ConversationId, child: ConversationId) =>
  read("test.child", async (harness, context) => {
    const agent = await harness.snapshot(
      AgentDoc,
      piConversationId(child),
      context
    );

    const registry = await harness.snapshot(
      SubagentsDoc,
      piConversationId(parent),
      context
    );

    return {
      model: {
        provider: agent?.model?.provider,
        modelId: agent?.model?.modelId,
      },
      thinkingLevel: agent?.thinkingLevel,
      dispatch: Object.values(registry?.items ?? {})[0]?.dispatch,
    };
  });

const go = (threadId: ThreadId, approvalId: string) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.respond(threadId, ApprovalId.make(approvalId), {
      decision: "accept",
      reason: Option.none(),
      answers: Option.none(),
      launch: Option.none(),
    })
  );

describe("brief models and the brain's cap over a pi-durable brain", () => {
  it.live(
    "a brief that names no model runs on the parent's model and level",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(spawnCall("Count the files", null, "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage("There are 3 files."),
          fauxAssistantMessage("Noted."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");
            yield* go(PARENT, yield* firstBrief(events, PARENT));

            const child = yield* firstChild(events);
            const found = yield* dispatchOf(parent, child);

            assert.deepStrictEqual(found.model, FAUX_MODEL);
            // The parent runs at `off`, and so does its child.
            assert.strictEqual(found.thinkingLevel, "off");
            assert.strictEqual(found.dispatch?.spec, null);
            // The fields roles had are gone from new records.
            assert.deepStrictEqual(
              Object.keys(found.dispatch?.resolved ?? {}),
              ["spec", "model", "thinkingLevel", "priced"]
            );
            assert.deepInclude(found.dispatch?.resolved ?? {}, {
              spec: "faux/scripted",
              model: FAUX_MODEL,
              thinkingLevel: "off",
            });
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a named provider/modelId:level is the child's model and level",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(
            spawnCall("Count the files", "faux/scripted:high", "c1"),
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage("There are 3 files."),
          fauxAssistantMessage("Noted."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");
            yield* go(PARENT, yield* firstBrief(events, PARENT));

            const child = yield* firstChild(events);
            const found = yield* dispatchOf(parent, child);

            assert.deepStrictEqual(found.model, FAUX_MODEL);
            // The parent runs at `off`; the spec's `high` is the child's.
            assert.strictEqual(found.thinkingLevel, "high");
            assert.strictEqual(found.dispatch?.spec, "faux/scripted:high");
            assert.deepInclude(found.dispatch?.resolved ?? {}, {
              spec: "faux/scripted:high",
              model: FAUX_MODEL,
              thinkingLevel: "high",
            });
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a spawn's brief freezes the server's default budget, and each limit the call asks over it",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(
            [
              fauxToolCall(
                "subagent_spawn",
                { description: "Count the files", brief: "Count them." },
                { id: "c1" }
              ),
              fauxToolCall(
                "subagent_spawn",
                {
                  description: "Count the lines",
                  brief: "Count them.",
                  max_usd: 0.25,
                },
                { id: "c2" }
              ),
            ],
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("Waiting for Go."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            const settings = yield* SettingsStore;

            yield* settings.update({
              autoSettleDays: Option.none(),
              titleModel: Option.none(),
              bridgeEnabled: Option.none(),
              bridgeGenerationCap: Option.none(),
              defaultBudget: Option.some(SET_DEFAULT),
            });
            yield* ask(PARENT, "r1");
            yield* runsEnded(events, PARENT, 1);

            const budgets = yield* read("test.briefs", async (harness, at) => {
              const approvals = await harness.snapshot(
                Approvals,
                piConversationId(parent),
                at
              );

              return Object.values(approvals?.items ?? {})
                .filter((record) => record.tool === "subagent_spawn")
                .map((record) => [
                  record.summary,
                  record.payload?.type === "brief"
                    ? record.payload.budget
                    : undefined,
                ]);
            });

            assert.deepStrictEqual(Object.fromEntries(budgets), {
              "Count the files": { ...SET_DEFAULT },
              "Count the lines": { ...SET_DEFAULT, maxListMicros: 250_000 },
            });
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a named model that is not ready, or a role name, which is no model, is refused at the ask with its reason",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(
            [
              spawnCall("Count the files", "faux/gone", "c1"),
              spawnCall("Read the readme", "@worker", "c2"),
            ],
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("Both were refused."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");
            yield* runsEnded(events, PARENT, 1);

            const transcript = yield* transcriptOf(parent);

            assert.include(
              transcript,
              JSON.stringify(
                "subagent_spawn's model cannot take a child now."
              ).slice(1, -1)
            );
            assert.include(transcript, "it is not in the model catalog");
            assert.include(
              transcript,
              JSON.stringify(SubagentToolText.modelInvalid("@worker")).slice(
                1,
                -1
              )
            );
            assert.deepStrictEqual(yield* pendingBriefs(events, PARENT), []);
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a model ready at the ask but not at Go starts nothing, and the parent is told once",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(
            spawnCall("Count the files", "faux/scripted", "c1"),
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage("Understood."),
          fauxAssistantMessage("Understood again."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");

            const brief = yield* firstBrief(events, PARENT);

            yield* runsEnded(events, PARENT, 1);

            // The provider reaches its plan's limit while the brief waits.
            yield* limitFaux;
            yield* go(PARENT, brief);
            yield* runsEnded(events, PARENT, 2);
            yield* Effect.sleep(Duration.millis(300));

            const told = renderBriefAnswer("Count the files", {
              kind: "noModel",
              why: "",
            });

            const transcript = yield* transcriptOf(parent);
            const head = JSON.stringify(told).slice(1, -1);

            assert.strictEqual(transcript.split(head).length - 1, 1);
            assert.include(transcript, "its plan limit is reached");

            const record = yield* read(
              "test.record",
              async (harness, context) => {
                const ledger = await harness.snapshot(
                  Approvals,
                  piConversationId(parent),
                  context
                );

                return ledger?.items[brief];
              }
            );

            assert.strictEqual(record?.status, "accepted");
            assert.strictEqual(record?.started, null);
            assert.isTrue(
              (yield* Ref.get(events)).every(
                (event) =>
                  !Predicate.isTagged(event, "ThreadEnsured") ||
                  Option.isNone(event.parent)
              )
            );
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a spawn past the brain's cap is refused, counting another thread's children",
    () =>
      withBrain(
        { ...DEFAULT_TOOL_OPTIONS, maxLivePerBrain: 2 },
        [
          fauxAssistantMessage(spawnCall("Count the files", null, "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage(
            [
              spawnCall("Read the readme", null, "c2"),
              spawnCall("Read the license", null, "c3"),
            ],
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("One was refused."),
        ],
        ({ events }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");
            yield* runsEnded(events, PARENT, 1);

            const other = yield* ensure(OTHER_PARENT);

            yield* ask(OTHER_PARENT, "r2");
            yield* runsEnded(events, OTHER_PARENT, 1);

            assert.lengthOf(yield* pendingBriefs(events, PARENT), 1);
            assert.lengthOf(yield* pendingBriefs(events, OTHER_PARENT), 1);

            const transcript = yield* transcriptOf(other.conversationId);

            assert.include(
              transcript,
              JSON.stringify(SubagentToolText.brainCapReached(2)).slice(1, -1)
            );
          })
      ),
    testLimit(30_000)
  );
  it.live(
    "a budget at its line when the user says Go starts nothing, and the parent is told once",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(spawnCall("Count the files", null, "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage("Understood."),
          fauxAssistantMessage("Understood again."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");

            const brief = yield* firstBrief(events, PARENT);

            yield* runsEnded(events, PARENT, 1);

            // The parent's scope reaches its line while the brief waits for Go.
            const book = yield* BudgetBook;

            yield* book.set({
              threadId: PARENT,
              budget: { ...DEFAULT_BUDGET, maxTokens: 1000 },
              mode: "drain",
              epoch: 0,
            });
            yield* book.stand(PARENT, {
              state: "exhausted",
              spent: { listMicros: 0, tokens: 1200, unpricedTokens: 1200 },
              reached: Option.some("tokens"),
            });

            yield* go(PARENT, brief);
            yield* runsEnded(events, PARENT, 2);
            yield* Effect.sleep(Duration.millis(300));

            const told = renderBriefAnswer("Count the files", {
              kind: "noBudget",
              why: "",
            });

            const transcript = yield* transcriptOf(parent);
            const head = JSON.stringify(told).slice(1, -1);

            assert.strictEqual(transcript.split(head).length - 1, 1);
            assert.include(transcript, "Budget reached for thread");
            assert.isTrue(
              (yield* Ref.get(events)).every(
                (event) =>
                  !Predicate.isTagged(event, "ThreadEnsured") ||
                  Option.isNone(event.parent)
              )
            );
          })
      ),
    testLimit(30_000)
  );
});
