// Where budgets come from, read from pi-durable's documents (ADR 0036: the approval document is the
// authority), and the two writes the budget guard makes there.
//
// A scope's base budget is, first, one declared on its thread (`cairn.budget`, written by
// `declare`, for a goal), else its brief's: a subagent's `cairn.child` names the brief's approval
// in its parent's `cairn.approvals`, whose frozen payload carries the budget. Each accepted
// `budget_raise` record in the scope's own `cairn.approvals` replaces it with its `to`, oldest
// first; the count of accepted raises is the scope's epoch. A brief's budget stops (`stop`); a
// declared one keeps its mode. A budget with no enforced limit is no scope.
//
// The guard asks a raise as a pending record of its own (`toolTaskId` 0, tool `budget_raise`, kind
// `tool-call`), keyed `budget-raise-<epoch>`, so asking again after a crash finds it. No run holds
// it, so a stop or the boot repair never cancels it; the user answers it like any approval.
//
// `notice` writes a display-only notice (`cairn.notice`) under a request id, once, in a host commit
// that never starts a run: on an idle thread it lands at once, on a running one it is queued for the
// next boundary (or placed by the stop), as notes are (`NoteAdmission.ts`). It answers whether
// this call wrote it, so the guard pushes at most once per notice.
//
// `halt` is the guard's boot half: before the Harness resumes, it marks the runs of a stopped
// scope aborted and withdraws their queued inputs, neither of which starts scheduling, so a scope
// stopped before a crash does not run again after it.

import {
  ConversationId as StoredConversationId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { Brief, BudgetRaisePayload } from "@cairn/protocol/Policy";
import { Budget } from "@cairn/protocol/Spend";
import { NOTICE_ENTRY_KIND } from "@cairn/protocol/Thread";
import type { NoticeEntryData } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  Cursor,
  Harness,
  JsonObject,
} from "@earendil-works/pi-durable";
import { defineDoc, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";

import { ChildDoc, isLinked, SubagentsDoc } from "../subagents/SubagentDocs.ts";
import { hasLimits } from "../usage/BudgetBook.ts";
import type { BudgetMode, ScopeLimit } from "../usage/BudgetBook.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import {
  Approvals,
  ThreadMeta,
  ThreadReceipt,
  UNDECIDED,
} from "./CairnDocs.ts";
import type { ApprovalRecord, JsonRecord } from "./CairnDocs.ts";
import { RUN_TASK } from "./CommitFeed.ts";
import { durable } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import { placeQueuedWrites, readNote } from "./NoteAdmission.ts";
import { piConversationId } from "./PiIds.ts";

/** The tool name a raise record carries. */
export const RAISE_TOOL = "budget_raise";

/** How long a raise waits before a waiting reader would call it expired: nothing waits on it. */
const RAISE_TTL_MILLIS = 7 * 24 * 3_600_000;

/** The approval id of the raise asked at `epoch`. */
export const raiseIdOf = (epoch: number) => `budget-raise-${epoch}`;

/** A brain read or write for budgets failed. Nothing partial was committed; it runs again. */
export class BudgetSourceError extends Schema.TaggedError<BudgetSourceError>()(
  "BudgetSourceError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** A completed child and the role it was dispatched as, for estimates. */
export interface ChildSample {
  readonly role: string;
  readonly threadId: ThreadId;
}

/** `cairn.budget` state: a budget declared on a thread's subtree, null until one is. */
interface DeclaredState {
  [key: string]: JsonValue;
  budget: JsonRecord | null;
  mode: BudgetMode;
}

/** `cairn.budget`: a budget declared on a thread (a goal's), never on the wire. */
const BudgetDoc = defineDoc<DeclaredState>({
  kind: "cairn.budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, with no budget of its own.
  fork: "initial",
  initial: () => ({ budget: null, mode: "drain" }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

const decodeBudget = Schema.decodeUnknownOption(Budget);

const decodeBrief = Schema.decodeUnknownOption(Brief);

const decodeRaise = Schema.decodeUnknownOption(BudgetRaisePayload);

const encodeBudget = Schema.encodeSync(Budget);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** How many conversations one page of the scan reads. */
const SCAN_PAGE = 200;

/** A budget as a document holds it: plain JSON. */
export const budgetJson = (budget: Budget): JsonRecord => ({
  ...encodeBudget(budget),
});

/** The accepted raises of one conversation's records, oldest first. */
const acceptedRaises = (records: ReadonlyArray<ApprovalRecord>) =>
  records
    .filter(
      (record) => record.tool === RAISE_TOOL && record.status === "accepted"
    )
    .toSorted((a, b) => a.askedAt - b.askedAt)
    .flatMap((record) => Option.toArray(decodeRaise(record.payload)));

/** A brain call for budgets failed, naming the operation. */
const failed = (operation: string) => (failure: DurableCallError) =>
  new BudgetSourceError({
    message: `${operation} could not reach the brain's store (${failure.message}). Nothing partial was committed; it runs again.`,
    operation,
    cause: failure,
  });

/** The conversation a thread lives in, from its receipt. */
const conversationOf = (open: BrainSession, threadId: ThreadId) =>
  durable(
    "receipt.read",
    async (context) =>
      await open.harness.snapshot(ThreadReceipt, threadId, context)
  ).pipe(
    Effect.map((receipt) =>
      receipt === undefined || receipt.conversationId < 1
        ? Option.none<ConversationId>()
        : Option.some(
            piConversationId(StoredConversationId.make(receipt.conversationId))
          )
    )
  );

/** One conversation's scope, read from its documents. */
const scopeIn = (harness: Harness, conversationId: ConversationId) =>
  durable("budget.read", async (context) => {
    const meta = await harness.snapshot(ThreadMeta, conversationId, context);
    const threadId = decodeThreadId(meta?.threadId);

    if (Option.isNone(threadId)) {
      return Option.none<ScopeLimit>();
    }

    const declared = await harness.snapshot(BudgetDoc, conversationId, context);

    let base: Option.Option<{ budget: Budget; mode: BudgetMode }> = Option.map(
      decodeBudget(declared?.budget ?? null),
      (budget) => ({
        budget,
        mode: declared?.mode ?? "drain",
      })
    );

    if (Option.isNone(base)) {
      const child = await harness.snapshot(ChildDoc, conversationId, context);

      if (isLinked(child)) {
        const parent = await harness.snapshot(
          Approvals,
          piConversationId(
            StoredConversationId.make(child.parentConversationId)
          ),
          context
        );

        const record = parent?.items[child.briefApprovalId];

        base = Option.map(decodeBrief(record?.payload ?? null), (brief) => ({
          budget: brief.budget,
          mode: "stop" as const,
        }));
      }
    }

    const own = await harness.snapshot(Approvals, conversationId, context);
    const raises = acceptedRaises(Object.values(own?.items ?? {}));
    const last = raises.at(-1);

    return Option.flatMap(base, ({ budget, mode }) => {
      const raised = last === undefined ? budget : last.to;

      return hasLimits(raised)
        ? Option.some<ScopeLimit>({
            threadId: threadId.value,
            budget: raised,
            mode,
            epoch: raises.length,
          })
        : Option.none();
    });
  });

/** Every conversation id, page by page. */
const everyConversation = (open: BrainSession) =>
  Effect.gen(function* () {
    const ids: Array<ConversationId> = [];
    let cursor: Option.Option<Cursor> = Option.none();

    do {
      const after = Option.getOrUndefined(cursor);

      const page = yield* durable(
        "conversations.scan",
        async (context) =>
          await open.storage.scanConversations({}, SCAN_PAGE, after, context)
      );

      for (const conversation of page.items) {
        ids.push(conversation.id);
      }

      cursor = Option.fromUndefinedOr(page.next);
    } while (Option.isSome(cursor));

    return ids;
  });

/** Where budgets come from, and the guard's writes beside them. */
export class BudgetSources extends Context.Service<
  BudgetSources,
  {
    /** Every scope the documents name, as raised. */
    readonly scopes: Effect.Effect<
      ReadonlyArray<ScopeLimit>,
      BudgetSourceError
    >;
    /** The scope `threadId` heads, as raised; none when it has no enforced budget. */
    scopeOf(
      threadId: ThreadId
    ): Effect.Effect<Option.Option<ScopeLimit>, BudgetSourceError>;
    /** Declares a budget on `threadId`'s subtree, replacing one declared before. */
    declare(
      threadId: ThreadId,
      budget: Budget,
      mode: BudgetMode
    ): Effect.Effect<void, BudgetSourceError>;
    /**
     * Asks the user to raise `limit`'s budget to `to`, once per epoch: true when this call asked,
     * false when the raise for this epoch was asked before.
     */
    askRaise(
      limit: ScopeLimit,
      to: Budget,
      summary: string
    ): Effect.Effect<boolean, BudgetSourceError>;
    /**
     * Writes a notice into `threadId`'s transcript under `requestId`, once: true when this call
     * wrote it. Never starts a run.
     */
    notice(
      threadId: ThreadId,
      requestId: string,
      data: NoticeEntryData
    ): Effect.Effect<boolean, BudgetSourceError>;
    /** Every settled child with the role spec it was dispatched as. */
    readonly samples: Effect.Effect<
      ReadonlyArray<ChildSample>,
      BudgetSourceError
    >;
    /**
     * Before the Harness resumes: marks every run of these threads aborted and withdraws their
     * queued inputs, without starting scheduling. Returns how many runs it marked.
     */
    halt(
      threads: ReadonlyArray<ThreadId>
    ): Effect.Effect<number, BudgetSourceError>;
  }
>()("cairn/server/brain/BudgetSources") {
  /** Over the brain's Harness. */
  static readonly layer = Layer.effect(
    BudgetSources,
    Effect.gen(function* () {
      const brain = yield* Brain;

      const session = brain.session.pipe(
        Effect.mapError(
          (unavailable) =>
            new BudgetSourceError({
              message: `Budgets could not open the brain (${unavailable.message}). Nothing was read; try again once the brain is up.`,
              operation: "BudgetSources.session",
              cause: unavailable,
            })
        )
      );

      const scopes = Effect.gen(function* () {
        const open = yield* session;
        const found: Array<ScopeLimit> = [];

        for (const id of yield* everyConversation(open).pipe(
          Effect.mapError(failed("BudgetSources.scopes"))
        )) {
          const scope = yield* scopeIn(open.harness, id).pipe(
            Effect.mapError(failed("BudgetSources.scopes"))
          );

          found.push(...Option.toArray(scope));
        }

        return found;
      }).pipe(Effect.withSpan("BudgetSources.scopes"));

      const scopeOf = Effect.fn("BudgetSources.scopeOf")(function* (
        threadId: ThreadId
      ) {
        const open = yield* session;

        const conversation = yield* conversationOf(open, threadId).pipe(
          Effect.mapError(failed("BudgetSources.scopeOf"))
        );

        if (Option.isNone(conversation)) {
          return Option.none<ScopeLimit>();
        }

        return yield* scopeIn(open.harness, conversation.value).pipe(
          Effect.mapError(failed("BudgetSources.scopeOf"))
        );
      });

      const declare = Effect.fn("BudgetSources.declare")(function* (
        threadId: ThreadId,
        budget: Budget,
        mode: BudgetMode
      ) {
        const open = yield* session;

        const conversation = yield* conversationOf(open, threadId).pipe(
          Effect.mapError(failed("BudgetSources.declare"))
        );

        if (Option.isNone(conversation)) {
          return yield* new BudgetSourceError({
            message: `Thread ${threadId} does not exist in the brain, so no budget was declared. Launch it first.`,
            operation: "BudgetSources.declare",
            cause: null,
          });
        }

        const id = conversation.value;

        return yield* durable("budget.declare", async (context) => {
          await open.harness.commit(async (tx) => {
            const doc = await tx.doc(BudgetDoc, id);

            doc.budget = budgetJson(budget);
            doc.mode = mode;
          }, context);
        }).pipe(Effect.mapError(failed("BudgetSources.declare")));
      });

      const askRaise = Effect.fn("BudgetSources.askRaise")(function* (
        limit: ScopeLimit,
        to: Budget,
        summary: string
      ) {
        const open = yield* session;

        const conversation = yield* conversationOf(open, limit.threadId).pipe(
          Effect.mapError(failed("BudgetSources.askRaise"))
        );

        if (Option.isNone(conversation)) {
          return false;
        }

        const id = conversation.value;
        const approvalId = raiseIdOf(limit.epoch);
        const now = brain.now();

        const payload: JsonObject = {
          type: "budget-raise",
          scope: limit.threadId,
          from: budgetJson(limit.budget),
          to: budgetJson(to),
        };

        return yield* durable(
          "budget.ask-raise",
          async (context) =>
            await open.harness.commit(async (tx) => {
              const { items } = await tx.doc(Approvals, id);

              if (items[approvalId] !== undefined) {
                return false;
              }

              items[approvalId] = {
                id: approvalId,
                toolTaskId: 0,
                tool: RAISE_TOOL,
                kind: "tool-call",
                summary,
                status: "pending",
                askedAt: now,
                expiresAt: now + RAISE_TTL_MILLIS,
                answeredAt: null,
                run: null,
                executorRequestId: null,
                ...UNDECIDED,
                payload,
              };

              return true;
            }, context)
        ).pipe(Effect.mapError(failed("BudgetSources.askRaise")));
      });

      const notice = Effect.fn("BudgetSources.notice")(function* (
        threadId: ThreadId,
        requestId: string,
        data: NoticeEntryData
      ) {
        const open = yield* session;

        const conversation = yield* conversationOf(open, threadId).pipe(
          Effect.mapError(failed("BudgetSources.notice"))
        );

        if (Option.isNone(conversation)) {
          return false;
        }

        const id = conversation.value;
        const draft = { kind: NOTICE_ENTRY_KIND, data: { ...data } };

        return yield* durable(
          "budget.notice",
          async (context) =>
            await open.harness.commit(async (tx) => {
              const reads = await readNote(tx, id, requestId);

              if (reads.existing !== undefined) {
                return false;
              }

              const live = await tx.doc(LiveDoc, id);
              const inbox = await tx.doc(InboxDoc, id);

              if (live.run === undefined) {
                await placeQueuedWrites(tx, id, inbox, reads.head);

                const appended = await tx.appendEntry(id, draft);

                await tx.createSubmission({
                  conversationId: id,
                  requestId,
                  type: "write",
                  status: "done",
                  entry: appended.id,
                });

                return true;
              }

              const queued = await tx.createSubmission({
                conversationId: id,
                requestId,
                type: "write",
                status: "queued",
              });

              inbox.items.push({ id: queued.id, mode: "write", entry: draft });

              return true;
            }, context)
        ).pipe(Effect.mapError(failed("BudgetSources.notice")));
      });

      const samples = Effect.gen(function* () {
        const open = yield* session;
        const found: Array<ChildSample> = [];

        for (const id of yield* everyConversation(open)) {
          const registry = yield* durable(
            "subagents.read",
            async (context) =>
              await open.harness.snapshot(SubagentsDoc, id, context)
          );

          for (const item of Object.values(registry?.items ?? {})) {
            const { spec } = item.dispatch;
            const threadId = decodeThreadId(item.threadId);

            if (
              item.status === "settled" &&
              Predicate.isString(spec) &&
              Option.isSome(threadId)
            ) {
              found.push({ role: spec, threadId: threadId.value });
            }
          }
        }

        return found;
      }).pipe(
        Effect.catchTag("DurableCallError", (failure) =>
          Effect.fail(failed("BudgetSources.samples")(failure))
        ),
        Effect.withSpan("BudgetSources.samples")
      );

      const halt = Effect.fn("BudgetSources.halt")(function* (
        threads: ReadonlyArray<ThreadId>
      ) {
        const open = yield* session;
        const conversations = new Set<number>();

        for (const threadId of threads) {
          const found = yield* conversationOf(open, threadId).pipe(
            Effect.mapError(failed("BudgetSources.halt"))
          );

          for (const id of Option.toArray(found)) {
            conversations.add(Number(id));
          }
        }

        const inspection = yield* durable(
          "inspect",
          async (context) => await open.harness.inspect(context)
        ).pipe(Effect.mapError(failed("BudgetSources.halt")));

        let marked = 0;

        for (const task of inspection.tasks) {
          if (
            task.record.kind === RUN_TASK &&
            conversations.has(Number(task.record.conversationId))
          ) {
            yield* durable(
              "abort-task",
              async (context) =>
                await open.harness.abortTask(task.record.id, context)
            ).pipe(Effect.mapError(failed("BudgetSources.halt")));
            marked += 1;
          }
        }

        for (const submission of inspection.submissions) {
          if (
            submission.type === "input" &&
            submission.status === "queued" &&
            conversations.has(Number(submission.conversationId))
          ) {
            yield* durable(
              "abort-submission",
              async (context) =>
                await open.harness.abortSubmission(
                  submission.id,
                  context,
                  submission.conversationId
                )
            ).pipe(Effect.mapError(failed("BudgetSources.halt")));
          }
        }

        return marked;
      });

      return BudgetSources.of({
        scopes,
        scopeOf,
        declare,
        askRaise,
        notice,
        samples,
        halt,
      });
    })
  );

  /** No brain (the scripted harness): no scopes from documents; writes do nothing. */
  static readonly layerNone = Layer.succeed(
    BudgetSources,
    BudgetSources.of({
      scopes: Effect.succeed([]),
      scopeOf: () => Effect.succeedNone,
      declare: () => Effect.void,
      askRaise: () => Effect.succeed(false),
      notice: () => Effect.succeed(false),
      samples: Effect.succeed([]),
      halt: () => Effect.succeed(0),
    })
  );
}
