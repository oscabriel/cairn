// The spend ledger (ADR 0036, models note section 3): what each conversation and each call outside
// a conversation spent, in tokens and in labelled list prices, kept in `cairn.sqlite` and rolled up
// by thread, lineage subtree, workflow run or everything.
//
// Rules:
// - `spend_totals` is derived, never accumulated blindly. A conversation's rows are a function of
//   its `pi.usage` document and its own assistant responses at one commit, so replaying a commit,
//   or a `kill -9` anywhere, cannot double count: the boot reconcile rebuilds any conversation
//   whose rows differ from its document, and the same function gives the same rows.
// - Prices per response, never per sum. A price tier is chosen by one request's whole input, so a
//   model whose responses recorded no cost (the Claude bridge, priced as its `anthropic` twin) is
//   priced one response at a time. A model with a recorded cost keeps what pi-ai recorded at
//   response time (already per response); the catalog is read only for the zero-cost ones.
// - Live, a commit is applied as a step: the rows it read plus the responses the commit appended
//   must add up to the new document. When they do not (a compaction attempt, which records usage
//   without a response, or a reading the ledger missed), the conversation is rebuilt from its
//   responses committed at or before that commit.
// - Unknown is never zero. A model with no list price has no `list_micros`, and its tokens count
//   in `unpriced_tokens`; so do tokens of a priced model that no response accounts for (a
//   compaction on the bridge). A figure reads "at least $X, plus N tokens with no price".
// - `spend_events` holds calls outside conversations (`recordCall`), written with
//   `INSERT OR IGNORE` under `(source, key, model_key)`: a call repeated after a crash writes once,
//   and a call whose answer was lost writes nothing (lost, never doubled).
// - Each thread row's `spend` (its own and its lineage subtree's) follows the ledger, at most one
//   commit per thread per 50 ms. Its `budget` word is the `BudgetBook`'s, when the root gives one.
// - `changes` tells the budget guard which threads' rows moved, after they are written, so a
//   roll-up it then reads includes them.

import type { ThreadId } from "@cairn/protocol/Ids";
import { ThreadId as ThreadIdSchema } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import { Micros, PriceBasis, SpendSummary } from "@cairn/protocol/Spend";
import type {
  BudgetState,
  ModelSpend,
  Spend,
  SpendScope,
  Tokens,
} from "@cairn/protocol/Spend";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import { ModelSource } from "../brain/ModelSource.ts";
import { recordedUsageOf, SpendFeed } from "../brain/SpendFeed.ts";
import type {
  RecordedUsage,
  ResponseUsage,
  UsageReading,
  UsageTotals,
} from "../brain/SpendFeed.ts";
import type { ModelPrice } from "../models/ModelPrice.ts";
import {
  basisOf,
  catalogLookupOf,
  listMicrosOf,
  priceOf,
} from "../models/ModelPrice.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
} from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetBook } from "./BudgetBook.ts";
import type { Parents } from "./BudgetBook.ts";

/** At most one spend commit per thread row inside this window. */
export const SPEND_WINDOW = Duration.millis(50);

/** The prefix of a tool bucket's key, beside the `provider/modelId` keys of models. */
const TOOL_KEY = "tool:";

/** One row of a conversation's spend: a model's (or a tool's) tokens and their list price. */
export interface SpendRow {
  /** `provider/modelId`, or `tool:<name>` for a tool result's own usage. */
  readonly modelKey: string;
  readonly tokens: Tokens;
  /** None when no list price covers any of the tokens. */
  readonly listMicros: Option.Option<Micros>;
  readonly basis: PriceBasis;
  /** Tokens no price covers: all of an unpriced model's, or a priced one's no response explains. */
  readonly unpricedTokens: number;
}

/** A call outside any conversation, keyed so a repeat after a crash writes once. */
export interface MeteredCall {
  /** What made the call: `thread-title`, `branch-name`, ... */
  readonly source: string;
  /** Unique within the source, stable across a retry of the same call (a thread id, ...). */
  readonly key: string;
  /** The thread the call was made for, when there is one. */
  readonly threadId: Option.Option<ThreadId>;
}

/** What one boot reconcile did. */
export interface SpendReconcileReport {
  /** Conversations with a `pi.usage` document. */
  readonly conversations: number;
  /** Conversations whose rows differed from their document and were rebuilt. */
  readonly rebuilt: number;
  /** Thread rows whose `spend` changed. */
  readonly threads: number;
}

/** The ledger's table could not be read or written. Nothing partial was committed; retry. */
export class SpendLedgerError extends Schema.TaggedError<SpendLedgerError>()(
  "SpendLedgerError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "SpendLedger.apply",
      "SpendLedger.reconcile",
      "SpendLedger.recordCall",
      "SpendLedger.rollup",
      "SpendLedger.publish",
    ]),
    cause: Schema.Defect(),
  }
) {}

/** A roll-up named a thread or a workflow run the brain does not hold. */
export class SpendScopeNotFound extends Schema.TaggedError<SpendScopeNotFound>()(
  "SpendScopeNotFound",
  {
    message: Schema.String,
    resource: Schema.Literals(["thread", "workflow"]),
    id: Schema.String,
  }
) {}

// Rows as SQLite returns them.

const StoredRow = Schema.Struct({
  conversation_id: Schema.Int,
  model_key: Schema.String,
  thread_id: Schema.NullOr(Schema.String),
  input: Schema.Int,
  output: Schema.Int,
  cache_read: Schema.Int,
  cache_write: Schema.Int,
  reasoning: Schema.NullOr(Schema.Int),
  list_micros: Schema.NullOr(Schema.Int),
  basis: PriceBasis,
  unpriced_tokens: Schema.Int,
  updated_seq: Schema.Int,
});

const decodeStoredRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

const StoredEvent = Schema.Struct({
  model_key: Schema.String,
  thread_id: Schema.NullOr(Schema.String),
  input: Schema.Int,
  output: Schema.Int,
  cache_read: Schema.Int,
  cache_write: Schema.Int,
  reasoning: Schema.NullOr(Schema.Int),
  list_micros: Schema.NullOr(Schema.Int),
  basis: PriceBasis,
  unpriced_tokens: Schema.Int,
});

const decodeStoredEvents = Schema.decodeUnknownEffect(
  Schema.Array(StoredEvent)
);

const LineageRow = Schema.Struct({
  id: ThreadIdSchema,
  parent: Schema.NullOr(ThreadIdSchema),
});

const decodeLineage = Schema.decodeUnknownEffect(Schema.Array(LineageRow));

const sameSummary = Schema.toEquivalence(Schema.Option(SpendSummary));

// Pure derivation.

const count = (value: number) => Math.max(0, Math.round(value));

const NO_TOKENS: Tokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: Option.none(),
};

const addReasoning = (a: Option.Option<number>, b: Option.Option<number>) =>
  Option.match(a, {
    onNone: () => b,
    onSome: (value) => Option.some(value + Option.getOrElse(b, () => 0)),
  });

/** Two list prices added; none only when neither has one. */
const addMicros = (
  a: Option.Option<Micros>,
  b: Option.Option<Micros>
): Option.Option<Micros> =>
  Option.match(a, {
    onNone: () => b,
    onSome: (value) =>
      Option.some(Micros.make(value + Option.getOrElse(b, () => 0))),
  });

/** Two token counts added; reasoning is reported once either side reports it. */
export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  reasoning: addReasoning(a.reasoning, b.reasoning),
});

/** Every token a count holds: input, output, cache reads and cache writes. */
export const tokenTotal = (tokens: Tokens) =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

const tokensOf = (usage: RecordedUsage): Tokens => ({
  input: count(usage.input),
  output: count(usage.output),
  cacheRead: count(usage.cacheRead),
  cacheWrite: count(usage.cacheWrite),
  reasoning: Option.map(usage.reasoning, count),
});

const sameCounts = (a: Tokens, b: Tokens) =>
  a.input === b.input &&
  a.output === b.output &&
  a.cacheRead === b.cacheRead &&
  a.cacheWrite === b.cacheWrite;

/** `provider/modelId` as a model reference; the provider never holds a `/`. */
export const modelRefOf = (modelKey: string): ModelRef => {
  const slash = modelKey.indexOf("/");

  return slash === -1
    ? { provider: modelKey, modelId: "" }
    : {
        provider: modelKey.slice(0, slash),
        modelId: modelKey.slice(slash + 1),
      };
};

const micros = (dollars: number) => Micros.make(count(dollars * 1_000_000));

/** One response's list price at a priced model's rates; none when the model is unpriced. */
export const responseMicros = (price: ModelPrice, usage: RecordedUsage) =>
  listMicrosOf(price, {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    cacheWrite1h: count(usage.cacheWrite1h),
  });

/** How a model key's rows are priced. */
type Pricing =
  /** pi-ai recorded a cost: kept as recorded. */
  | { readonly kind: "recorded"; readonly basis: PriceBasis }
  /** No cost recorded but a list price exists: each response priced alone. */
  | {
      readonly kind: "per-response";
      readonly price: ModelPrice;
      readonly basis: PriceBasis;
    }
  | { readonly kind: "unpriced" };

const pricingOf = (
  modelKey: string,
  usage: RecordedUsage,
  priceFor: (model: ModelRef) => ModelPrice
): Pricing => {
  const ref = modelRefOf(modelKey);

  if (usage.costTotal > 0) {
    return { kind: "recorded", basis: basisOf(ref.provider) };
  }

  const price = priceFor(ref);

  return Predicate.isTagged(price, "Priced")
    ? { kind: "per-response", price, basis: price.basis }
    : { kind: "unpriced" };
};

/** What a derivation starts from. */
export type DeriveFrom =
  /** Every response the conversation recorded up to the document's commit. */
  | {
      readonly kind: "full";
      readonly responses: ReadonlyArray<ResponseUsage>;
    }
  /** The rows before this commit and the responses this commit appended. */
  | {
      readonly kind: "step";
      readonly previous: ReadonlyMap<string, SpendRow>;
      readonly responses: ReadonlyArray<ResponseUsage>;
    };

/** True when some model of `totals` is priced response by response, so responses are needed. */
export const needsResponses = (
  totals: UsageTotals,
  priceFor: (model: ModelRef) => ModelPrice
) =>
  [...totals.models].some(
    ([key, usage]) => pricingOf(key, usage, priceFor).kind === "per-response"
  );

/**
 * A conversation's rows from its `pi.usage` totals. A step whose rows and responses do not add up
 * to the totals is none: rebuild from every response instead.
 */
export const deriveRows = (
  totals: UsageTotals,
  from: DeriveFrom,
  priceFor: (model: ModelRef) => ModelPrice
): Option.Option<ReadonlyArray<SpendRow>> => {
  const rows: Array<SpendRow> = [];

  for (const [modelKey, usage] of totals.models) {
    const tokens = tokensOf(usage);
    const pricing = pricingOf(modelKey, usage, priceFor);

    if (pricing.kind === "recorded") {
      rows.push({
        modelKey,
        tokens,
        listMicros: Option.some(micros(usage.costTotal)),
        basis: pricing.basis,
        unpricedTokens: 0,
      });
      continue;
    }

    if (pricing.kind === "unpriced") {
      rows.push({
        modelKey,
        tokens,
        listMicros: Option.none(),
        basis: "unpriced",
        unpricedTokens: tokenTotal(tokens),
      });
      continue;
    }

    let covered = NO_TOKENS;
    let listed = 0;

    for (const response of from.responses) {
      if (response.modelKey === modelKey) {
        covered = addTokens(covered, tokensOf(response.usage));
        listed += Option.getOrElse(
          responseMicros(pricing.price, response.usage),
          () => 0
        );
      }
    }

    if (from.kind === "full") {
      rows.push({
        modelKey,
        tokens,
        listMicros: Option.some(Micros.make(listed)),
        basis: pricing.basis,
        unpricedTokens: Math.max(0, tokenTotal(tokens) - tokenTotal(covered)),
      });
      continue;
    }

    const before = Option.fromUndefinedOr(from.previous.get(modelKey));

    const base = Option.getOrElse(before, (): SpendRow => ({
      modelKey,
      tokens: NO_TOKENS,
      listMicros: Option.some(Micros.make(0)),
      basis: pricing.basis,
      unpricedTokens: 0,
    }));

    if (
      base.basis !== pricing.basis ||
      Option.isNone(base.listMicros) ||
      !sameCounts(addTokens(base.tokens, covered), tokens)
    ) {
      return Option.none();
    }

    rows.push({
      modelKey,
      tokens,
      listMicros: Option.some(Micros.make(base.listMicros.value + listed)),
      basis: pricing.basis,
      unpricedTokens: base.unpricedTokens,
    });
  }

  for (const [name, usage] of totals.tools) {
    const tokens = tokensOf(usage);
    // A tool's own usage names no model; a recorded cost is kept as a list price estimate.
    const priced = usage.costTotal > 0;

    rows.push({
      modelKey: `${TOOL_KEY}${name}`,
      tokens,
      listMicros: priced ? Option.some(micros(usage.costTotal)) : Option.none(),
      basis: priced ? "list_on_plan" : "unpriced",
      unpricedTokens: priced ? 0 : tokenTotal(tokens),
    });
  }

  return Option.some(rows);
};

/** True when stored rows still describe `totals`: the same keys with the same token counts. */
export const rowsMatch = (
  rows: ReadonlyArray<SpendRow>,
  totals: UsageTotals
) => {
  const expected = new Map<string, Tokens>();

  for (const [key, usage] of totals.models) {
    expected.set(key, tokensOf(usage));
  }

  for (const [name, usage] of totals.tools) {
    expected.set(`${TOOL_KEY}${name}`, tokensOf(usage));
  }

  return (
    rows.length === expected.size &&
    rows.every((row) => {
      const tokens = expected.get(row.modelKey);

      return tokens !== undefined && sameCounts(row.tokens, tokens);
    })
  );
};

/** Rows of any number of conversations and calls, summed into one `Spend`. */
export const spendOf = (rows: ReadonlyArray<SpendRow>): Spend => {
  const byModel = new Map<string, ModelSpend>();
  let tokens = NO_TOKENS;
  let listMicros = 0;
  let unpricedTokens = 0;
  const unpricedModels = new Set<string>();

  for (const row of rows) {
    tokens = addTokens(tokens, row.tokens);
    listMicros += Option.getOrElse(row.listMicros, () => 0);
    unpricedTokens += row.unpricedTokens;

    if (row.unpricedTokens > 0) {
      unpricedModels.add(row.modelKey);
    }

    const current = byModel.get(row.modelKey);

    byModel.set(row.modelKey, {
      tokens:
        current === undefined
          ? row.tokens
          : addTokens(current.tokens, row.tokens),
      listMicros:
        current === undefined
          ? row.listMicros
          : addMicros(current.listMicros, row.listMicros),
      basis:
        current === undefined || current.basis === "unpriced"
          ? row.basis
          : current.basis,
    });
  }

  return {
    tokens,
    listMicros: Micros.make(listMicros),
    unpricedTokens,
    unpricedModels: [...unpricedModels].toSorted(),
    byModel: Object.fromEntries(
      [...byModel].toSorted(([a], [b]) => a.localeCompare(b))
    ),
    compute: Option.none(),
  };
};

/** The coarse figure a thread row carries; none when nothing was spent. */
export const summaryOf = (
  rows: ReadonlyArray<SpendRow>
): Option.Option<SpendSummary> => {
  if (rows.length === 0) {
    return Option.none();
  }

  const spend = spendOf(rows);

  return Option.some({
    totalTokens: tokenTotal(spend.tokens),
    listMicros: spend.listMicros,
    unpricedTokens: spend.unpricedTokens,
    budget: "none",
  });
};

/** Every thread under `root` by lineage, `root` included; a cycle is cut where it closes. */
export const subtreeOf = (
  root: ThreadId,
  children: ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>>
): ReadonlyArray<ThreadId> => {
  const seen = new Set<ThreadId>([root]);
  const order = [root];

  // The loop reaches what it appends: an array iterator reads the length at each step.
  for (const node of order) {
    for (const child of children.get(node) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        order.push(child);
      }
    }
  }

  return order;
};

const rowOfStored = (
  stored: typeof StoredRow.Type | typeof StoredEvent.Type
): SpendRow => ({
  modelKey: stored.model_key,
  tokens: {
    input: stored.input,
    output: stored.output,
    cacheRead: stored.cache_read,
    cacheWrite: stored.cache_write,
    reasoning: Option.fromNullOr(stored.reasoning),
  },
  listMicros: Option.map(Option.fromNullOr(stored.list_micros), (value) =>
    Micros.make(value)
  ),
  basis: stored.basis,
  unpricedTokens: stored.unpriced_tokens,
});

/** A ledger failure naming its operation. */
const failed =
  (operation: SpendLedgerError["operation"], what: string) =>
  (cause: unknown) =>
    new SpendLedgerError({
      message: `${operation} could not ${what} in cairn.sqlite. Nothing partial was committed; it runs again on the next change or at boot.`,
      operation,
      cause,
    });

/** Each thread's children, from the lineage rows. */
const childrenOf = (
  rows: ReadonlyArray<typeof LineageRow.Type>
): ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>> => {
  const children = new Map<ThreadId, Array<ThreadId>>();

  for (const row of rows) {
    if (row.parent !== null) {
      const list = children.get(row.parent) ?? [];

      list.push(row.id);
      children.set(row.parent, list);
    }
  }

  return children;
};

/** Logs a failed step; the next change or the boot reconcile runs it again. */
const logFailure = (event: string) => (error: { readonly message: string }) =>
  Effect.logWarning("spend ledger step failed").pipe(
    Effect.annotateLogs({ event, error: error.message })
  );

/** The spend of every conversation and call, rolled up by scope, with each thread row's figure. */
export class SpendLedger extends Context.Service<
  SpendLedger,
  {
    /**
     * Rebuilds every conversation whose rows differ from its `pi.usage` document, then brings
     * every thread row's `spend` up to date: the boot repair. Run before the Harness resumes.
     */
    readonly reconcile: Effect.Effect<SpendReconcileReport, SpendLedgerError>;
    /** Records one call outside any conversation; a repeat under the same key writes nothing. */
    recordCall(
      call: MeteredCall,
      message: AssistantMessage
    ): Effect.Effect<void, SpendLedgerError>;
    /** What `scope` spent, by model. */
    rollup(
      scope: SpendScope
    ): Effect.Effect<Spend, SpendLedgerError | SpendScopeNotFound>;
    /** Applies every reading taken so far and commits pending thread figures now (tests, judges). */
    readonly flush: Effect.Effect<void>;
    /**
     * The threads whose rows changed, after each change is written: a reading applied, a call
     * recorded, a reconcile. Each subscriber sees changes after it joined.
     */
    readonly changes: Stream.Stream<ReadonlyArray<ThreadId>>;
    /** Brings these threads' row figures up to date again, as after a change (a budget moved). */
    touch(threads: ReadonlyArray<ThreadId>): Effect.Effect<void>;
    /** Every live thread's parent, from the thread rows' lineage. */
    readonly parents: Effect.Effect<Parents, SpendLedgerError>;
  }
>()("cairn/server/usage/SpendLedger") {
  /**
   * Consumes the feed's readings for the layer's lifetime. Needs `SpendFeed`, `ModelSource` (the
   * catalog), the shell store (`EventSink`, `ThreadRows`) and the migrated `SqlClient`.
   */
  static readonly layerNoDeps = Layer.effect(
    SpendLedger,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const feed = yield* SpendFeed;
      const models = yield* ModelSource;
      const sink = yield* EventSink;
      const threadRows = yield* ThreadRows;
      // The budget word of each row; `none` everywhere when the root has no budgets.
      const book = yield* Effect.serviceOption(BudgetBook);
      const changeHub = yield* PubSub.unbounded<ReadonlyArray<ThreadId>>();

      const announce = (threads: ReadonlyArray<ThreadId>) =>
        threads.length === 0
          ? Effect.void
          : PubSub.publish(changeHub, threads).pipe(Effect.asVoid);

      const budgetWord = (threadId: ThreadId) =>
        Option.match(book, {
          onNone: () => Effect.succeed<BudgetState>("none"),
          onSome: (found) => found.rowState(threadId),
        });

      const lock = yield* Semaphore.make(1);
      const dirty = new Set<ThreadId>();
      const wake = yield* Queue.dropping<true>(1);
      // Readings taken from the feed and not yet applied, for `flush`.
      let inFlight = 0;
      const busy = () => inFlight > 0;

      const priceFor = (model: ModelRef) =>
        priceOf(model, catalogLookupOf(models.models()));

      const storedRows = (conversationId: number) =>
        sql`SELECT * FROM spend_totals WHERE conversation_id = ${conversationId}`.pipe(
          Effect.flatMap(decodeStoredRows)
        );

      const replaceRows = (
        reading: UsageReading,
        threadId: Option.Option<ThreadId>,
        rows: ReadonlyArray<SpendRow>,
        seq: number
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM spend_totals WHERE conversation_id = ${reading.conversationId}`;

            for (const row of rows) {
              yield* sql`
                INSERT INTO spend_totals (
                  conversation_id, model_key, thread_id, input, output, cache_read, cache_write,
                  reasoning, list_micros, basis, unpriced_tokens, updated_seq
                ) VALUES (
                  ${reading.conversationId},
                  ${row.modelKey},
                  ${Option.getOrNull(threadId)},
                  ${row.tokens.input},
                  ${row.tokens.output},
                  ${row.tokens.cacheRead},
                  ${row.tokens.cacheWrite},
                  ${Option.getOrNull(row.tokens.reasoning)},
                  ${Option.getOrNull(row.listMicros)},
                  ${row.basis},
                  ${row.unpricedTokens},
                  ${seq}
                )
              `;
            }
          })
        );

      const markDirty = (threadId: Option.Option<ThreadId>) =>
        Effect.gen(function* () {
          if (Option.isSome(threadId)) {
            dirty.add(threadId.value);
            yield* Queue.offer(wake, true);
          }
        });

      /** Rows from every response up to `atSeq` (all, when none). */
      const rebuild = Effect.fnUntraced(function* (
        reading: UsageReading,
        atSeq: Option.Option<number>
      ) {
        const responses = needsResponses(reading.totals, priceFor)
          ? yield* feed.responses(reading.conversationId, atSeq)
          : [];

        return Option.getOrElse(
          deriveRows(reading.totals, { kind: "full", responses }, priceFor),
          (): ReadonlyArray<SpendRow> => []
        );
      });

      const apply = Effect.fn("SpendLedger.apply")(
        function* (reading: UsageReading) {
          const stored = yield* storedRows(reading.conversationId);
          const seen = Math.max(0, ...stored.map((row) => row.updated_seq));

          // A commit applied already (a doubled delivery): its rows are written.
          if (stored.length > 0 && reading.seq <= seen) {
            return;
          }

          const previous = new Map(
            stored.map((row) => [row.model_key, rowOfStored(row)] as const)
          );

          const stepped = deriveRows(
            reading.totals,
            { kind: "step", previous, responses: reading.responses },
            priceFor
          );

          const rows = Option.isSome(stepped)
            ? stepped.value
            : yield* rebuild(reading, Option.some(reading.seq));

          const threadId = Option.orElse(reading.threadId, () =>
            Option.flatMap(Option.fromUndefinedOr(stored[0]), (row) =>
              Option.map(Option.fromNullOr(row.thread_id), (id) =>
                ThreadIdSchema.make(id)
              )
            )
          );

          yield* replaceRows(reading, threadId, rows, reading.seq);
          yield* markDirty(threadId);
          yield* announce(Option.toArray(threadId));
        },
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              failed("SpendLedger.apply", "write a conversation's spend")(cause)
            ),
          SchemaError: (cause) =>
            Effect.fail(
              failed("SpendLedger.apply", "read a conversation's spend")(cause)
            ),
        })
      );

      // Lineage from the thread rows: each thread's parent, from its stored `lineage`.
      const lineage = sql`
        SELECT id, json_extract(shell_json, '$.lineage.parentThreadId') AS parent
        FROM threads WHERE deleted_at IS NULL
      `.pipe(Effect.flatMap(decodeLineage));

      const rowsOfThreads = (threads: ReadonlyArray<ThreadId>) =>
        Effect.gen(function* () {
          if (threads.length === 0) {
            return [];
          }

          const totals = yield* sql`
            SELECT * FROM spend_totals WHERE ${sql.in("thread_id", threads)}
          `.pipe(Effect.flatMap(decodeStoredRows));

          const events = yield* sql`
            SELECT * FROM spend_events WHERE ${sql.in("thread_id", threads)}
          `.pipe(Effect.flatMap(decodeStoredEvents));

          return [...totals, ...events].map(rowOfStored);
        });

      /** Brings the `spend` of these threads and their ancestors up to date. */
      const publish = Effect.fn("SpendLedger.publish")(
        function* (threads: ReadonlyArray<ThreadId>) {
          const lineageRows = yield* lineage;
          const children = childrenOf(lineageRows);

          const parents = new Map(
            lineageRows.map((row) => [row.id, row.parent] as const)
          );

          const targets = new Set<ThreadId>();

          for (const threadId of threads) {
            let current: ThreadId | null = threadId;

            while (current !== null && !targets.has(current)) {
              targets.add(current);
              current = parents.get(current) ?? null;
            }
          }

          let changed = 0;

          for (const threadId of targets) {
            const row = yield* threadRows.get(threadId);

            if (Option.isNone(row) || Option.isSome(row.value.deletedAt)) {
              continue;
            }

            const word = yield* budgetWord(threadId);

            const summary = Option.map(
              summaryOf(yield* rowsOfThreads(subtreeOf(threadId, children))),
              (figure): SpendSummary => ({ ...figure, budget: word })
            );

            if (sameSummary(summary, row.value.shell.spend)) {
              continue;
            }

            const committed = yield* sink
              .commitCommand(
                ThreadActivityUpdate.make({
                  commandId: yield* sink.mintCommandId,
                  threadId,
                  patch: { ...emptyActivityPatch, spend: Option.some(summary) },
                })
              )
              .pipe(
                Effect.as(true),
                Effect.catchTags({
                  // An archived or deleted thread keeps the figure it had.
                  ShellTargetNotFound: () => Effect.succeed(false),
                  ShellCommandInvalid: () => Effect.succeed(false),
                  ShellCommandConflict: () => Effect.succeed(false),
                  ProjectWorkspaceConflictError: () => Effect.succeed(false),
                })
              );

            changed += committed ? 1 : 0;
          }

          return changed;
        },
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              failed("SpendLedger.publish", "read the spend of a thread")(cause)
            ),
          SchemaError: (cause) =>
            Effect.fail(
              failed("SpendLedger.publish", "read the thread lineage")(cause)
            ),
          ShellStoreError: (cause) =>
            Effect.fail(
              failed("SpendLedger.publish", "write a thread row's spend")(cause)
            ),
        })
      );

      const flushThreads = Effect.gen(function* () {
        const threads = [...dirty];

        dirty.clear();

        if (threads.length > 0) {
          yield* publish(threads).pipe(
            Effect.catchTag("SpendLedgerError", (error) =>
              Effect.gen(function* () {
                for (const threadId of threads) {
                  dirty.add(threadId);
                }

                yield* logFailure("spend_publish_failed")(error);

                return 0;
              })
            )
          );
        }
      });

      yield* feed.readings.pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            inFlight += 1;
          })
        ),
        Stream.runForEach((reading) =>
          lock.withPermits(1)(
            apply(reading).pipe(
              Effect.catchTags({
                SpendLedgerError: logFailure("spend_apply_failed"),
                SpendFeedError: logFailure("spend_apply_failed"),
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  inFlight -= 1;
                })
              )
            )
          )
        ),
        Effect.forkScoped
      );

      yield* Queue.take(wake).pipe(
        Effect.andThen(Effect.sleep(SPEND_WINDOW)),
        Effect.andThen(lock.withPermits(1)(flushThreads)),
        Effect.forever,
        Effect.forkScoped
      );

      const reconcile = Effect.gen(function* () {
        const readings = yield* Stream.runCollect(feed.current);
        let rebuilt = 0;

        for (const reading of readings) {
          const stored = (yield* storedRows(reading.conversationId)).map(
            rowOfStored
          );

          if (rowsMatch(stored, reading.totals)) {
            continue;
          }

          const rows = yield* rebuild(reading, Option.none());

          yield* replaceRows(reading, reading.threadId, rows, 0);
          rebuilt += 1;
        }

        // Every thread row, so one whose figure was lost or never written catches up.
        const threads = (yield* lineage).map((row) => row.id);

        dirty.clear();

        const published = yield* publish(threads);

        yield* announce(threads);

        const report: SpendReconcileReport = {
          conversations: readings.length,
          rebuilt,
          threads: published,
        };

        yield* Effect.logInfo("spend ledger reconciled").pipe(
          Effect.annotateLogs({ event: "spend_reconciled", ...report })
        );

        return report;
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              failed("SpendLedger.reconcile", "rebuild the spend rows")(cause)
            ),
          SchemaError: (cause) =>
            Effect.fail(
              failed("SpendLedger.reconcile", "read the spend rows")(cause)
            ),
          SpendFeedError: (cause) =>
            Effect.fail(
              failed("SpendLedger.reconcile", "read the brain's usage")(cause)
            ),
        }),
        lock.withPermits(1),
        Effect.withSpan("SpendLedger.reconcile")
      );

      const recordCall = Effect.fn("SpendLedger.recordCall")(
        function* (call: MeteredCall, message: AssistantMessage) {
          const modelKey = `${message.provider}/${message.model}`;
          const usage = recordedUsageOf(message.usage);

          const rows = Option.getOrElse(
            deriveRows(
              {
                models: new Map([[modelKey, usage]]),
                tools: new Map(),
              },
              {
                kind: "full",
                responses: [{ entryId: 0, modelKey, usage }],
              },
              priceFor
            ),
            (): ReadonlyArray<SpendRow> => []
          );

          const at = yield* Clock.currentTimeMillis;

          for (const row of rows) {
            yield* sql`
              INSERT OR IGNORE INTO spend_events (
                source, key, model_key, thread_id, input, output, cache_read, cache_write,
                reasoning, list_micros, basis, unpriced_tokens, at
              ) VALUES (
                ${call.source},
                ${call.key},
                ${row.modelKey},
                ${Option.getOrNull(call.threadId)},
                ${row.tokens.input},
                ${row.tokens.output},
                ${row.tokens.cacheRead},
                ${row.tokens.cacheWrite},
                ${Option.getOrNull(row.tokens.reasoning)},
                ${Option.getOrNull(row.listMicros)},
                ${row.basis},
                ${row.unpricedTokens},
                ${at}
              )
            `;
          }

          yield* markDirty(call.threadId);
          yield* announce(Option.toArray(call.threadId));
        },
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            failed("SpendLedger.recordCall", "record a model call")(cause)
          )
        )
      );

      const threadScope = Effect.fnUntraced(function* (threadId: ThreadId) {
        const row = yield* threadRows
          .get(threadId)
          .pipe(
            Effect.mapError(failed("SpendLedger.rollup", "read the thread row"))
          );

        if (Option.isNone(row) || Option.isSome(row.value.deletedAt)) {
          return yield* new SpendScopeNotFound({
            message: `Thread ${threadId} does not exist. Pick a thread from the sidebar and ask again.`,
            resource: "thread",
            id: threadId,
          });
        }

        return subtreeOf(threadId, childrenOf(yield* lineage));
      });

      const allRows = Effect.gen(function* () {
        const totals = yield* sql`SELECT * FROM spend_totals`.pipe(
          Effect.flatMap(decodeStoredRows)
        );

        const events = yield* sql`SELECT * FROM spend_events`.pipe(
          Effect.flatMap(decodeStoredEvents)
        );

        return [...totals, ...events].map(rowOfStored);
      });

      const workflowRows = Effect.fnUntraced(function* (
        threadId: ThreadId,
        workflowId: string
      ) {
        const nodes = yield* feed.workflowThreads(threadId, workflowId);

        if (Option.isNone(nodes)) {
          return yield* new SpendScopeNotFound({
            message: `Thread ${threadId} has no workflow ${workflowId}. Open the thread's work panel and pick a run.`,
            resource: "workflow",
            id: workflowId,
          });
        }

        const children = childrenOf(yield* lineage);
        const threads = new Set<ThreadId>();

        for (const node of nodes.value) {
          for (const member of subtreeOf(node, children)) {
            threads.add(member);
          }
        }

        return yield* rowsOfThreads([...threads]);
      });

      const subtreeRows = Effect.fnUntraced(function* (threadId: ThreadId) {
        return yield* rowsOfThreads(yield* threadScope(threadId));
      });

      const rollup = Effect.fn("SpendLedger.rollup")(
        function* (scope: SpendScope) {
          const rows = yield* Match.value(scope).pipe(
            Match.tagsExhaustive({
              All: () => allRows,
              WorkflowRun: (run) => workflowRows(run.threadId, run.workflowId),
              Thread: (thread) => subtreeRows(thread.threadId),
              // A goal is a thread whose subagents are its lineage subtree.
              Goal: (goal) => subtreeRows(goal.threadId),
            })
          );

          return spendOf(rows);
        },
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              failed("SpendLedger.rollup", "read the spend rows")(cause)
            ),
          SchemaError: (cause) =>
            Effect.fail(
              failed("SpendLedger.rollup", "read the spend rows")(cause)
            ),
          SpendFeedError: (cause) =>
            Effect.fail(
              failed("SpendLedger.rollup", "read the workflow ledger")(cause)
            ),
        })
      );

      const flush = Effect.gen(function* () {
        while (busy()) {
          yield* Effect.sleep(Duration.millis(5));
        }

        yield* lock.withPermits(1)(flushThreads);
      });

      const touch = Effect.fn("SpendLedger.touch")(function* (
        threads: ReadonlyArray<ThreadId>
      ) {
        for (const threadId of threads) {
          yield* markDirty(Option.some(threadId));
        }
      });

      const parents = lineage.pipe(
        Effect.map(
          (rows): Parents =>
            new Map(
              rows.flatMap((row) =>
                row.parent === null ? [] : [[row.id, row.parent] as const]
              )
            )
        ),
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              failed("SpendLedger.rollup", "read the thread lineage")(cause)
            ),
          SchemaError: (cause) =>
            Effect.fail(
              failed("SpendLedger.rollup", "read the thread lineage")(cause)
            ),
        })
      );

      return SpendLedger.of({
        reconcile,
        recordCall,
        rollup,
        flush,
        changes: Stream.fromPubSub(changeHub),
        touch,
        parents,
      });
    })
  );
}

/** The boot repair: rebuild what the store says before the Harness resumes. */
export const reconcileSpendAtBoot = SpendLedger.use((ledger) =>
  ledger.reconcile.pipe(Effect.asVoid)
);
