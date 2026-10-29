// Fixtures for the spend ledger's tests and judges: a model catalog with a priced `anthropic` twin
// for a zero-cost bridge model (its tier starts low, so a long thread crosses it), a priced plan
// model and an unpriced one; and a scripted `SpendFeed` over an in-memory record of commits, which
// keeps the feed's contract: a reading per commit, `current` as the sum of every commit, and
// `responses` cut at a commit sequence.

import type { ThreadId } from "@cairn/protocol/Ids";
import { ConversationId } from "@cairn/protocol/Ids";
import {
  calculateCost,
  createModels,
  fauxProvider,
} from "@earendil-works/pi-ai";
import type { Models, Usage } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Option, Queue, Stream } from "effect";

import { SpendFeed } from "./SpendFeed.ts";
import type {
  RecordedUsage,
  ResponseUsage,
  UsageReading,
  UsageTotals,
} from "./SpendFeed.ts";

/** The bridge model the catalog lists at zero, priced as its `anthropic` twin. */
export const BRIDGE_KEY = "claude-bridge/claude-haiku-5-5";

/** A plan model whose responses record their own cost. */
export const PRICED_KEY = "opencode-go/qwen3.8-flash";

/** A model with no list price. */
export const FREE_KEY = "opencode-go/beam-free";

/** The twin's rates, dollars per million tokens, and its tier above 2,000 input tokens. */
export const TWIN_RATES = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  tier: {
    inputTokensAbove: 2000,
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
  },
} as const;

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** pi-ai's model runtime with the four catalog entries the spend tests price against. */
export const spendCatalog = () => {
  const twin = fauxProvider({
    provider: "anthropic",
    models: [
      {
        id: "claude-haiku-5-5",
        cost: {
          input: TWIN_RATES.input,
          output: TWIN_RATES.output,
          cacheRead: TWIN_RATES.cacheRead,
          cacheWrite: TWIN_RATES.cacheWrite,
        },
      },
    ],
  });

  for (const model of twin.models) {
    model.cost.tiers = [TWIN_RATES.tier];
  }

  const bridge = fauxProvider({
    provider: "claude-bridge",
    models: [{ id: "claude-haiku-5-5", cost: zero }],
  });

  const go = fauxProvider({
    provider: "opencode-go",
    models: [
      {
        id: "qwen3.8-flash",
        cost: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
      },
      { id: "beam-free", cost: zero },
    ],
  });

  const models = createModels();

  models.setProvider(twin.provider);
  models.setProvider(bridge.provider);
  models.setProvider(go.provider);

  return models;
};

/** A recorded usage with the given counts and cost. */
export const usageOf = (
  counts: Partial<Omit<RecordedUsage, "reasoning">> & {
    readonly reasoning?: number;
  }
): RecordedUsage => ({
  input: counts.input ?? 0,
  output: counts.output ?? 0,
  cacheRead: counts.cacheRead ?? 0,
  cacheWrite: counts.cacheWrite ?? 0,
  cacheWrite1h: counts.cacheWrite1h ?? 0,
  reasoning: Option.fromUndefinedOr(counts.reasoning),
  costTotal: counts.costTotal ?? 0,
});

/** The same usage as pi-ai types it, for a message. */
export const piUsageOf = (usage: RecordedUsage): Usage => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  cacheWrite1h: usage.cacheWrite1h,
  totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: usage.costTotal,
  },
});

const add = (a: RecordedUsage, b: RecordedUsage): RecordedUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  reasoning: Option.isNone(a.reasoning)
    ? b.reasoning
    : Option.some(a.reasoning.value + Option.getOrElse(b.reasoning, () => 0)),
  costTotal: a.costTotal + b.costTotal,
});

/** One commit of a scripted conversation. */
export interface ScriptedCommit {
  /** Responses the commit appends, each added to `pi.usage` under its key. */
  readonly responses?: ReadonlyArray<{
    readonly modelKey: string;
    readonly usage: RecordedUsage;
  }>;
  /** Usage added with no response, as a compaction attempt records it. */
  readonly unattributed?: ReadonlyArray<{
    readonly modelKey: string;
    readonly usage: RecordedUsage;
  }>;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly usage: RecordedUsage;
  }>;
}

interface Stored {
  readonly threadId: Option.Option<ThreadId>;
  models: Map<string, RecordedUsage>;
  tools: Map<string, RecordedUsage>;
  responses: Array<ResponseUsage & { readonly seq: number }>;
}

/** Drives the scripted feed: commits, deliveries and what the store holds. */
export class SpendScript extends Context.Service<
  SpendScript,
  {
    /**
     * Commits to conversation `conversationId` (a thread's, when `threadId` is some) and returns
     * the reading. `deliver: false` commits without a reading, as a crash after the commit would.
     */
    commit(
      conversationId: number,
      threadId: Option.Option<ThreadId>,
      commit: ScriptedCommit,
      options?: { readonly deliver?: boolean }
    ): Effect.Effect<UsageReading>;
    /** Delivers a reading again, as a doubled publication would. */
    deliver(reading: UsageReading): Effect.Effect<void>;
  }
>()("cairn/server/brain/SpendTestKit/SpendScript") {}

const totalsOf = (stored: Stored): UsageTotals => ({
  models: new Map(stored.models),
  tools: new Map(stored.tools),
});

/** A `SpendFeed` over scripted commits, and its `SpendScript`. */
export const SpendFeedScripted = Layer.effectContext(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<UsageReading>();
    const store = new Map<number, Stored>();
    let seq = 0;
    let entryId = 0;

    const commit: SpendScript["Service"]["commit"] = (
      conversationId,
      threadId,
      change,
      options
    ) =>
      Effect.gen(function* () {
        seq += 1;

        const stored = store.get(conversationId) ?? {
          threadId,
          models: new Map<string, RecordedUsage>(),
          tools: new Map<string, RecordedUsage>(),
          responses: [],
        };

        store.set(conversationId, stored);

        const responses: Array<ResponseUsage> = [];

        for (const response of change.responses ?? []) {
          entryId += 1;

          const recorded = { entryId, ...response };

          responses.push(recorded);
          stored.responses.push({ ...recorded, seq });
        }

        const appended = change.responses ?? [];
        const unattributed = change.unattributed ?? [];
        const added = [...appended, ...unattributed];

        for (const { modelKey, usage } of added) {
          const before = stored.models.get(modelKey);

          stored.models.set(
            modelKey,
            before === undefined ? usage : add(before, usage)
          );
        }

        for (const { name, usage } of change.tools ?? []) {
          const before = stored.tools.get(name);

          stored.tools.set(
            name,
            before === undefined ? usage : add(before, usage)
          );
        }

        const reading: UsageReading = {
          conversationId: ConversationId.make(conversationId),
          threadId: stored.threadId,
          seq,
          totals: totalsOf(stored),
          responses,
        };

        if (options?.deliver !== false) {
          yield* Queue.offer(queue, reading);
        }

        return reading;
      });

    const feed = SpendFeed.of({
      readings: Stream.fromQueue(queue),
      current: Stream.suspend(() =>
        Stream.fromIterable(
          [...store].map(([id, stored]): UsageReading => ({
            conversationId: ConversationId.make(id),
            threadId: stored.threadId,
            seq: 0,
            totals: totalsOf(stored),
            responses: [],
          }))
        )
      ),
      responses: (conversationId, atSeq) =>
        Effect.sync(() =>
          (store.get(conversationId)?.responses ?? [])
            .filter((response) =>
              Option.match(atSeq, {
                onNone: () => true,
                onSome: (cut) => response.seq <= cut,
              })
            )
            .map(({ seq: _seq, ...response }) => response)
        ),
      workflowThreads: () => Effect.succeedNone,
    });

    return Context.make(SpendFeed, feed).pipe(
      Context.add(
        SpendScript,
        SpendScript.of({
          commit,
          deliver: (reading) => Queue.offer(queue, reading).pipe(Effect.asVoid),
        })
      )
    );
  })
);

/**
 * pi-ai's own figure for one bridge response at its `anthropic` twin's list price, in micros: the
 * outside judge of the ledger's arithmetic.
 */
export const twinListMicros = (models: Models, usage: RecordedUsage) => {
  const twin = models.getModel("anthropic", "claude-haiku-5-5");

  if (twin === undefined) {
    return Number.NaN;
  }

  return Math.round(calculateCost(twin, piUsageOf(usage)).total * 1_000_000);
};
