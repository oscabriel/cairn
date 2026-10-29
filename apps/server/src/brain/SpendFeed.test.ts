// The spend feed and ledger over a real pi-durable Harness (pi-ai's faux provider, registered as
// the Claude bridge, so every response records zero cost and is priced as its `anthropic` twin):
// each commit's reading carries the response it appended; `responses` cut at a commit leaves out
// later ones; and a fork starts at zero and is not double counted (J-spend). Its parent's
// responses, which the fork's history shows, are the parent's alone.

import { ConversationId, EntryId } from "@cairn/protocol/Ids";
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
import { Context, Effect, Layer, Option, Stream } from "effect";

import { Database } from "../db/Database.ts";
import { Spend0009 } from "../db/migrations/0009Spend.ts";
import { ShellStoreLayer } from "../shell/ShellLayer.ts";
import { shellMigrations } from "../shell/ShellTestKit.ts";
import { SpendLedger } from "../usage/SpendLedger.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import { ModelSource } from "./ModelSource.ts";
import { piEntryId } from "./PiIds.ts";
import { SpendFeed } from "./SpendFeed.ts";
import type { UsageReading } from "./SpendFeed.ts";
import { BRIDGE_KEY, spendCatalog, twinListMicros } from "./SpendTestKit.ts";

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
          session.harness.subscribeCommits((publication) => {
            listener(session, publication);
          })
        ),
        (detach) => Effect.sync(detach)
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
