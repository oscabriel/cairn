// The spend feed and ledger over a real pi-durable Harness (pi-ai's faux provider, registered as
// the Claude bridge, so every response records zero cost and is priced as its `anthropic` twin):
// each commit's reading carries the response it appended; `responses` cut at a commit leaves out
// later ones; and a fork starts at zero and is not double counted (J-spend). Its parent's
// responses, which the fork's history shows, are the parent's alone.

import { ConversationId, EntryId, ThreadId } from "@cairn/protocol/Ids";
import { SpendScope } from "@cairn/protocol/Spend";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Function, Layer, Option, Stream } from "effect";

import { Database } from "../db/Database.ts";
import { Spend0009 } from "../db/migrations/0009Spend.ts";
import { ShellStoreLayer } from "../shell/ShellLayer.ts";
import { shellMigrations } from "../shell/ShellTestKit.ts";
import { SpendLedger } from "../usage/SpendLedger.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import { ModelSource } from "./ModelSource.ts";
import { piEntryId } from "./PiIds.ts";
import { SpendFeed, workflowChildThreads } from "./SpendFeed.ts";
import type { UsageReading } from "./SpendFeed.ts";
import { BRIDGE_KEY, spendCatalog, twinListMicros } from "./SpendTestKit.ts";
import type { WorkflowItemState, WorkflowsState } from "./WorkflowsDoc.ts";

const context = BACKGROUND_CONTEXT;

const MODEL = { provider: "claude-bridge", modelId: "claude-haiku-5-5" };

/** A Harness whose bridge model answers every request, over memory storage. */
const openHarness = Effect.gen(function* () {
  const models = spendCatalog();

  const faux = fauxProvider({
    provider: MODEL.provider,
    models: [{ id: MODEL.modelId }],
  });

  faux.setResponses(
    Array.from({ length: 20 }, (_, n) =>
      fauxAssistantMessage(`answer ${n} `.repeat(40))
    )
  );
  models.setProvider(faux.provider);

  const storage = new MemoryStorage();

  const harness = yield* Effect.acquireRelease(
    Effect.promise(
      async () =>
        await Harness.open(
          storage,
          {
            models,
            registry: createRegistry(),
            settings: { retry: { enabled: false } },
          },
          context
        )
    ),
    (open) =>
      Effect.promise(async () => {
        await open.close(context);
      })
  );

  return { harness, storage, models };
});

/** `Brain` over one open Harness, as the feed reads it. */
const brainOver = (session: BrainSession) =>
  Layer.mock(Brain)({
    session: Effect.succeed(session),
    subscribeCommits: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          session.harness.observeCommits({
            advance: (publication) => {
              listener(session, publication);
            },
            end: Function.constVoid,
          })
        ),
        (observation) =>
          Effect.sync(() => {
            observation.detach();
          })
      ).pipe(Effect.asVoid),
    now: () => 0,
  });

const ask = (conversation: Conversation, text: string) =>
  Effect.promise(async () => {
    await conversation.submit(
      { type: "input", content: text, requestId: `r-${text}` },
      context
    );
    await conversation.waitForIdle(context);
  });

describe("SpendFeed over a real Harness", () => {
  it.live(
    "reads each response, cuts responses at a commit, and starts a fork at zero",
    () =>
      Effect.gen(function* () {
        const { harness, storage, models } = yield* openHarness;
        const session: BrainSession = { harness, storage, generation: 1 };

        const services = yield* Layer.build(
          SpendLedger.layerNoDeps.pipe(
            Layer.provideMerge(SpendFeed.layer),
            Layer.provide(brainOver(session)),
            Layer.provideMerge(ShellStoreLayer),
            Layer.provide(
              Layer.mock(ModelSource)({
                models: () => models,
                settings: () => ({}),
              })
            ),
            Layer.provideMerge(
              Database.layerTest({
                ...shellMigrations,
                "0009_Spend": Spend0009,
              })
            )
          )
        );

        const feed = Context.get(services, SpendFeed);

        const parent = yield* Effect.promise(
          async () =>
            await harness.createConversation(
              { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
              context
            )
        );

        yield* ask(parent, "one");
        yield* ask(parent, "two");

        const newest = yield* Effect.promise(
          async () => await parent.entries({}, 1, undefined, context)
        );

        const [last] = newest.items;

        assert.isDefined(last);

        const fork = yield* Effect.promise(
          async () =>
            await parent.fork(
              last.id,
              { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
              context
            )
        );

        yield* ask(fork, "three");

        const current = new Map(
          [...(yield* Stream.runCollect(feed.current))].map(
            (reading: UsageReading) => [reading.conversationId, reading]
          )
        );

        const parentId = ConversationId.make(parent.id);
        const forkId = ConversationId.make(fork.id);

        const parentResponses = yield* feed.responses(parentId, Option.none());
        const forkResponses = yield* feed.responses(forkId, Option.none());

        assert.strictEqual(parentResponses.length, 2);
        assert.strictEqual(forkResponses.length, 1);
        assert.isTrue(
          forkResponses.every((response) => response.modelKey === BRIDGE_KEY)
        );

        // A fork's `pi.usage` holds its own response only.
        const forkTotals = current.get(forkId)?.totals.models.get(BRIDGE_KEY);

        assert.strictEqual(forkTotals?.input, forkResponses[0]?.usage.input);

        // Cut at the first response's commit, the second is left out.
        const [first] = parentResponses;

        assert.isDefined(first);

        const stored = yield* Effect.promise(
          async () =>
            await storage.entry(piEntryId(EntryId.make(first.entryId)), context)
        );

        assert.isDefined(stored);

        const cut = yield* feed.responses(
          parentId,
          Option.some(Number(stored.commitSeq))
        );

        assert.deepStrictEqual(
          cut.map((response) => response.entryId),
          [first.entryId]
        );

        // The ledger: every response priced once, the fork's parent's not again.
        const ledger = Context.get(services, SpendLedger);

        yield* Effect.sleep("30 millis");
        yield* ledger.flush;

        const spend = yield* ledger.rollup(SpendScope.members[3].make({}));

        const expected = [...parentResponses, ...forkResponses].reduce(
          (sum, response) => sum + twinListMicros(models, response.usage),
          0
        );

        assert.strictEqual(spend.listMicros, expected);
        assert.strictEqual(
          spend.tokens.input,
          [...parentResponses, ...forkResponses].reduce(
            (sum, response) => sum + response.usage.input,
            0
          )
        );
        assert.strictEqual(spend.byModel[BRIDGE_KEY]?.basis, "list_on_plan");

        // A reconcile over the same store changes nothing.
        assert.strictEqual((yield* ledger.reconcile).rebuilt, 0);
      }).pipe(Effect.scoped)
  );
});

/** A ledger node with a child thread, as the brain writes it; `model` is what it asked for. */
const ledgerNode = (
  id: string,
  model: string,
  childThreadId: string
): WorkflowItemState["nodes"][string] => ({
  id,
  workflowId: "wf-1",
  key: null,
  label: id,
  phase: null,
  index: 0,
  requestId: `wf-wf-1-${id}`,
  briefId: "launch-wf-1",
  model,
  provider: null,
  modelId: null,
  effort: null,
  readonly: false,
  arms: "host",
  state: "running",
  stage: "submitted",
  childThreadId,
  conversationId: 2,
  submissionId: null,
  nestedTaskId: 9,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: null,
  endedAt: null,
  error: null,
});

/** A `cairn.workflows` ledger with one running workflow over `nodes`. */
const ledgerOf = (
  nodes: ReadonlyArray<WorkflowItemState["nodes"][string]>
): WorkflowsState => ({
  items: {
    "wf-1": {
      id: "wf-1",
      name: "probe-wf",
      description: "Run the probe",
      phases: [],
      scriptHash: "hash",
      scriptRef: "script-wf-1",
      args: {},
      state: "running",
      outcome: null,
      approvalId: "launch-wf-1",
      decidedBy: { kind: "user" },
      decidedAt: 1,
      sample: null,
      budget: {
        maxListMicros: null,
        maxTokens: null,
        maxTurns: null,
        maxMinutes: null,
        planGuard: null,
        warnAt: 0.8,
      },
      estimate: null,
      codemodeTaskId: 7,
      startedAt: 2,
      endedAt: null,
      result: null,
      nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      log: {},
      spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
      softAt: null,
      spentAt: null,
    },
  },
});

describe(workflowChildThreads, () => {
  it("names every node's child thread, whatever model a node asked for", () => {
    const first = "019a0000-0000-7000-8000-000000000001";
    const second = "019a0000-0000-7000-8000-000000000002";

    // The brain writes the launching thread's model unchecked, and a catalog refreshed from a
    // provider can hold an id the spec pattern does not take (here with a space).
    const ledger = ledgerOf([
      ledgerNode("n-1", "faux/scripted", first),
      ledgerNode("n-2", "lmstudio/qwen 2.5:high", second),
    ]);

    assert.deepStrictEqual(
      workflowChildThreads(ledger, "wf-1"),
      Option.some([ThreadId.make(first), ThreadId.make(second)])
    );
    assert.deepStrictEqual(workflowChildThreads(ledger, "wf-2"), Option.none());
  });
});
