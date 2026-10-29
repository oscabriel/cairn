// What the spend ledger (`usage/SpendLedger.ts`, ADR 0036) reads from pi-durable, as plain values:
// each conversation's `pi.usage` document (its own spend, keyed `provider/modelId` and by tool, in
// the commit that records each response; a fork starts at zero) and the usage of each assistant
// response it records. The ledger prices responses one at a time, because a price tier is chosen
// by one request's whole input, so it needs both.
//
// - `readings`: one reading per commit that changed a conversation's `pi.usage`, in commit order,
//   with the responses that commit appended. The commit listener is attached while the layer
//   builds, so before boot resumes the Harness, and it only enqueues (pi-durable calls it on its
//   own stack). One consumer: the ledger.
// - `current`: every conversation's thread and `pi.usage` now, for the boot reconcile.
// - `responses`: a conversation's own assistant responses (not a fork parent's), optionally only
//   those committed at or before a commit sequence, so a reading and its responses describe one
//   point in time.
// - `workflowThreads`: the child threads of a workflow run's nodes, from `cairn.workflows`.
//
// `layerOff` is for the scripted brain, which has no pi-durable store and records no spend.

import { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import {
  WORKFLOWS_DOCUMENT,
  WorkflowsDocument,
} from "@cairn/protocol/Workflows";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type {
  CommitPublication,
  ConversationId as PiConversationId,
  Cursor,
  EntryRecord,
  JsonObject,
  UsageState,
} from "@earendil-works/pi-durable";
import { UsageDoc } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";

import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import { ThreadMeta, ThreadReceipt } from "./CairnDocs.ts";
import { durable } from "./Durable.ts";
import { piConversationId } from "./PiIds.ts";

/** How many records one page of a scan reads. */
const SCAN_PAGE = 200;

/** The entry kind pi-durable writes each provider response under, with its usage. */
const ASSISTANT_ENTRY = "pi.assistant";

/** One response's usage, or a sum of them, as recorded. */
export interface RecordedUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Every cache write, the one-hour ones included. */
  readonly cacheWrite: number;
  /** The part of `cacheWrite` written with one-hour retention. */
  readonly cacheWrite1h: number;
  /** None when the provider does not report it. */
  readonly reasoning: Option.Option<number>;
  /** The dollars pi-ai recorded at response time: a list price, zero for the bridge. */
  readonly costTotal: number;
}

/** A conversation's `pi.usage`: per model key (`provider/modelId`) and per tool name. */
export interface UsageTotals {
  readonly models: ReadonlyMap<string, RecordedUsage>;
  readonly tools: ReadonlyMap<string, RecordedUsage>;
}

/** One assistant response a conversation recorded. */
export interface ResponseUsage {
  readonly entryId: number;
  /** `provider/modelId`, the key `pi.usage` adds it under. */
  readonly modelKey: string;
  readonly usage: RecordedUsage;
}

/** A conversation's spend as of one commit. */
export interface UsageReading {
  readonly conversationId: ConversationId;
  /** None for a conversation that is not a thread. */
  readonly threadId: Option.Option<ThreadId>;
  /** The commit's sequence; 0 for a read of the current state. */
  readonly seq: number;
  readonly totals: UsageTotals;
  /** The responses this commit appended; empty for a read of the current state. */
  readonly responses: ReadonlyArray<ResponseUsage>;
}

/** Reading pi-durable for the spend ledger failed; nothing was written. Retry the read. */
export class SpendFeedError extends Schema.TaggedError<SpendFeedError>()(
  "SpendFeedError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "SpendFeed.current",
      "SpendFeed.responses",
      "SpendFeed.workflowThreads",
    ]),
    cause: Schema.Defect(),
  }
) {}

const UsageJson = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  cacheWrite1h: Schema.optionalKey(Schema.Finite),
  reasoning: Schema.optionalKey(Schema.Finite),
  cost: Schema.Struct({ total: Schema.Finite }),
});

const UsageDocJson = Schema.Struct({
  models: Schema.Record(Schema.String, UsageJson),
  tools: Schema.Record(Schema.String, UsageJson),
});

const decodeUsageDoc = Schema.decodeUnknownOption(UsageDocJson);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const decodeWorkflows = Schema.decodeUnknownOption(WorkflowsDocument);

const recorded = (usage: typeof UsageJson.Type): RecordedUsage => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  cacheWrite1h: usage.cacheWrite1h ?? 0,
  reasoning: Option.fromUndefinedOr(usage.reasoning),
  costTotal: usage.cost.total,
});

/** A response's usage as pi-ai typed it. */
export const recordedUsageOf = (usage: Usage): RecordedUsage => ({
  input: usage.input,
  output: usage.output,
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  cacheWrite1h: usage.cacheWrite1h ?? 0,
  reasoning: Option.fromUndefinedOr(usage.reasoning),
  costTotal: usage.cost.total,
});

/** A `pi.usage` value, decoded; none when it does not have the document's shape. */
const totalsOf = (
  value: Readonly<JsonObject> | Readonly<UsageState>
): Option.Option<UsageTotals> =>
  Option.map(decodeUsageDoc(value), (doc) => ({
    models: new Map(
      Object.entries(doc.models).map(([key, usage]) => [key, recorded(usage)])
    ),
    tools: new Map(
      Object.entries(doc.tools).map(([key, usage]) => [key, recorded(usage)])
    ),
  }));

const isAssistant = (
  message: Message | undefined
): message is AssistantMessage =>
  message !== undefined && message.role === "assistant";

/** The response an assistant entry records; none for any other entry. */
const responseOf = (entry: EntryRecord): Option.Option<ResponseUsage> => {
  if (entry.kind !== ASSISTANT_ENTRY) {
    return Option.none();
  }

  const message = entry.model?.[0];

  if (!isAssistant(message)) {
    return Option.none();
  }

  return Option.some({
    entryId: entry.id,
    modelKey: `${message.provider}/${message.model}`,
    usage: recordedUsageOf(message.usage),
  });
};

const usageKind = UsageDoc.definition.kind;

/** What `readings` reads off one publication before naming each conversation's thread. */
interface Pending {
  readonly conversationId: PiConversationId;
  readonly seq: number;
  readonly totals: UsageTotals;
  readonly responses: ReadonlyArray<ResponseUsage>;
}

/** Each conversation whose `pi.usage` this publication changed, with the responses it appended. */
const pendingOf = (publication: CommitPublication): Array<Pending> => {
  const responses = new Map<PiConversationId, Array<ResponseUsage>>();

  for (const change of publication.changes) {
    if (change.type === "entry") {
      const response = responseOf(change.value);

      if (Option.isSome(response)) {
        const list = responses.get(change.value.conversationId) ?? [];

        list.push(response.value);
        responses.set(change.value.conversationId, list);
      }
    }
  }

  const pending: Array<Pending> = [];

  for (const change of publication.changes) {
    if (
      change.type === "document" &&
      change.record.kind === usageKind &&
      change.conversationId !== undefined &&
      change.value !== null
    ) {
      const totals = totalsOf(change.value);

      if (Option.isSome(totals)) {
        pending.push({
          conversationId: change.conversationId,
          seq: Number(publication.seq),
          totals: totals.value,
          responses: responses.get(change.conversationId) ?? [],
        });
      }
    }
  }

  return pending;
};

/** Thread ids named in this publication's `cairn.thread-meta` writes. */
const threadsNamedIn = (publication: CommitPublication) => {
  const named = new Map<PiConversationId, ThreadId>();

  for (const change of publication.changes) {
    if (
      change.type === "document" &&
      change.record.kind === ThreadMeta.definition.kind &&
      change.conversationId !== undefined
    ) {
      const threadId = decodeThreadId(change.value?.threadId);

      if (Option.isSome(threadId)) {
        named.set(change.conversationId, threadId.value);
      }
    }
  }

  return named;
};

const threadOfMeta = (meta: Readonly<JsonObject> | undefined) =>
  Option.flatMap(Option.fromUndefinedOr(meta), (found) =>
    decodeThreadId(found.threadId)
  );

/** The spend ledger's view of pi-durable. */
export class SpendFeed extends Context.Service<
  SpendFeed,
  {
    /**
     * Each commit that changed a conversation's `pi.usage`, from the first commit after the layer
     * built, in commit order. Read by one consumer only.
     */
    readonly readings: Stream.Stream<UsageReading>;
    /** Every conversation's thread and `pi.usage` now (sequence 0, no responses). */
    readonly current: Stream.Stream<UsageReading, SpendFeedError>;
    /**
     * The conversation's own assistant responses in entry order: a fork's parent's are left out.
     * With `atSeq`, only those committed at or before that commit.
     */
    responses(
      conversationId: ConversationId,
      atSeq: Option.Option<number>
    ): Effect.Effect<ReadonlyArray<ResponseUsage>, SpendFeedError>;
    /**
     * The child threads of the nodes of workflow `workflowId` launched in `threadId`; none when
     * that thread holds no such workflow.
     */
    workflowThreads(
      threadId: ThreadId,
      workflowId: string
    ): Effect.Effect<Option.Option<ReadonlyArray<ThreadId>>, SpendFeedError>;
  }
>()("cairn/server/brain/SpendFeed") {
  /** Over the brain's Harness and store; attaches its commit listener while it builds. */
  static readonly layer = Layer.effect(
    SpendFeed,
    Effect.gen(function* () {
      const brain = yield* Brain;

      const inbox = yield* Queue.unbounded<{
        readonly session: BrainSession;
        readonly publication: CommitPublication;
      }>();

      // Conversation to thread; only a thread's id is final, so other conversations are asked
      // again (a conversation can be seen before its metadata is written).
      const threads = new Map<PiConversationId, ThreadId>();

      const threadOf = Effect.fnUntraced(function* (
        session: BrainSession,
        conversationId: PiConversationId
      ) {
        const known = threads.get(conversationId);

        if (known !== undefined) {
          return Option.some(known);
        }

        const threadId = yield* durable(
          "thread-meta.read",
          async (context) =>
            await session.harness.snapshot(ThreadMeta, conversationId, context)
        ).pipe(
          Effect.map(threadOfMeta),
          Effect.catchTag("DurableCallError", (error) =>
            Effect.logWarning("spend feed could not read thread metadata").pipe(
              Effect.annotateLogs({
                event: "spend_feed_meta_failed",
                conversationId: String(conversationId),
                error: error.message,
              }),
              Effect.as(Option.none<ThreadId>())
            )
          )
        );

        if (Option.isSome(threadId)) {
          threads.set(conversationId, threadId.value);
        }

        return threadId;
      });

      const readingsOf = Effect.fnUntraced(function* (
        session: BrainSession,
        publication: CommitPublication
      ) {
        for (const [id, threadId] of threadsNamedIn(publication)) {
          threads.set(id, threadId);
        }

        const readings: Array<UsageReading> = [];

        for (const pending of pendingOf(publication)) {
          readings.push({
            conversationId: ConversationId.make(pending.conversationId),
            threadId: yield* threadOf(session, pending.conversationId),
            seq: pending.seq,
            totals: pending.totals,
            responses: pending.responses,
          });
        }

        return readings;
      });

      const readings = Stream.fromQueue(inbox).pipe(
        Stream.mapEffect(({ session, publication }) =>
          readingsOf(session, publication)
        ),
        Stream.flattenIterable
      );

      const { session } = brain;

      const current = Stream.paginate(
        Option.none<Cursor>(),
        Effect.fnUntraced(function* (cursor: Option.Option<Cursor>) {
          const open = yield* session;

          const page = yield* durable(
            "conversations.scan",
            async (context) =>
              await open.storage.scanConversations(
                {},
                SCAN_PAGE,
                Option.getOrUndefined(cursor),
                context
              )
          );

          const found: Array<UsageReading> = [];

          for (const conversation of page.items) {
            const usage = yield* durable(
              "usage.read",
              async (context) =>
                await open.harness.snapshot(UsageDoc, conversation.id, context)
            );

            const totals = Option.flatMap(
              Option.fromUndefinedOr(usage),
              totalsOf
            );

            if (Option.isSome(totals)) {
              const meta = yield* durable(
                "thread-meta.read",
                async (context) =>
                  await open.harness.snapshot(
                    ThreadMeta,
                    conversation.id,
                    context
                  )
              );

              found.push({
                conversationId: ConversationId.make(conversation.id),
                threadId: threadOfMeta(meta),
                seq: 0,
                totals: totals.value,
                responses: [],
              });
            }
          }

          const next = Option.fromUndefinedOr(page.next);

          return [found, Option.map(next, Option.some)] as const;
        })
      ).pipe(
        Stream.mapError(
          (cause) =>
            new SpendFeedError({
              message: `SpendFeed.current could not read the brain's conversations: ${cause.message}. Nothing was changed; run the reconcile again.`,
              operation: "SpendFeed.current",
              cause,
            })
        )
      );

      const responses = Effect.fn("SpendFeed.responses")(
        function* (
          conversationId: ConversationId,
          atSeq: Option.Option<number>
        ) {
          const open = yield* session;
          const id = piConversationId(conversationId);
          const found: Array<ResponseUsage> = [];
          let cursor: Option.Option<Cursor> = Option.none();
          // Entry ids grow with commit order, so once one entry is at or before `atSeq`, every
          // older one is too and needs no lookup.
          let settled = Option.isNone(atSeq);

          do {
            const after = Option.getOrUndefined(cursor);

            const page = yield* durable(
              "entries.scan",
              async (context) =>
                await open.storage.scanEntries(
                  { conversationId: id, order: "descending" },
                  SCAN_PAGE,
                  after,
                  context
                )
            );

            for (const entry of page.items) {
              const response = Option.filter(
                responseOf(entry),
                () => entry.conversationId === id
              );

              if (Option.isSome(response)) {
                if (!settled && Option.isSome(atSeq)) {
                  const stored = yield* durable(
                    "entry.read",
                    async (context) =>
                      await open.storage.entry(entry.id, context)
                  );

                  if (
                    stored === undefined ||
                    Number(stored.commitSeq) > atSeq.value
                  ) {
                    continue;
                  }

                  settled = true;
                }

                found.push(response.value);
              }
            }

            cursor = Option.fromUndefinedOr(page.next);
          } while (Option.isSome(cursor));

          return found.toReversed();
        },
        (effect, conversationId) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new SpendFeedError({
                  message: `SpendFeed.responses could not read the responses of conversation ${conversationId}: ${cause.message}. Nothing was changed; read again.`,
                  operation: "SpendFeed.responses",
                  cause,
                })
            )
          )
      );

      const workflowThreads = Effect.fn("SpendFeed.workflowThreads")(
        function* (threadId: ThreadId, workflowId: string) {
          const open = yield* session;

          const receipt = yield* durable(
            "receipt.read",
            async (context) =>
              await open.harness.snapshot(ThreadReceipt, threadId, context)
          );

          if (receipt === undefined || receipt.conversationId < 1) {
            return Option.none<ReadonlyArray<ThreadId>>();
          }

          const conversationId = piConversationId(
            ConversationId.make(receipt.conversationId)
          );

          const record = yield* durable(
            "workflows.find",
            async (context) =>
              await open.storage.findDocument(
                {
                  kind: WORKFLOWS_DOCUMENT,
                  scope: { kind: "conversation", conversationId },
                },
                "current",
                context
              )
          );

          if (record === undefined) {
            return Option.none<ReadonlyArray<ThreadId>>();
          }

          const stored = yield* durable(
            "workflows.read",
            async (context) =>
              await open.storage.document(record.id, "current", context)
          );

          const workflow = Option.flatMap(
            decodeWorkflows(stored?.value),
            (doc) => Option.fromUndefinedOr(doc.items[workflowId])
          );

          return Option.map(workflow, (found) =>
            Object.values(found.nodes).flatMap((node) =>
              node.childThreadId === null ? [] : [node.childThreadId]
            )
          );
        },
        (effect, threadId) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new SpendFeedError({
                  message: `SpendFeed.workflowThreads could not read the workflows of thread ${threadId}: ${cause.message}. Nothing was changed; read again.`,
                  operation: "SpendFeed.workflowThreads",
                  cause,
                })
            )
          )
      );

      // Attached now, and to each reopened Session before it resumes.
      yield* brain.subscribeCommits((open, publication) => {
        Queue.offerUnsafe(inbox, { session: open, publication });
      });

      return SpendFeed.of({
        readings,
        current,
        responses,
        workflowThreads,
      });
    })
  );

  /** No store and no readings: for the scripted brain, which records no spend. */
  static readonly layerOff = Layer.succeed(
    SpendFeed,
    SpendFeed.of({
      readings: Stream.never,
      current: Stream.empty,
      responses: () => Effect.succeed([]),
      workflowThreads: () => Effect.succeedNone,
    })
  );
}
