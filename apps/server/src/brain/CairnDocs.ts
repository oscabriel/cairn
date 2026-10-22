// Cairn's documents and entry kinds inside pi-durable's store. Kinds are protocol: a `cairn.*` name
// never changes, and a shape change is a `version` bump with `migrate`.
//
// - `cairn.thread` (session family keyed by thread id) is the creation receipt: one commit creates
//   the conversation, configures it and records it here, so a raced `ensureThread` lands once.
// - `cairn.thread-meta` (conversation) names the thread and project, so the store describes itself
//   and a lost cairn.sqlite can be re-linked. A fork starts empty: it is another thread.
// - `cairn.approvals` (conversation) holds approval records in spike 4's shape. It is a
//   conversation document so the thread's own view carries its approvals.
//
// The approval ledger is the interface tools use to record an approval and the effect sandwich
// around it (`started` before the effect, `done` after), so callers outside `brain/` never touch
// pi-durable. The shape comes from spikes/4-approvals/brain.ts in this repo.

import type {
  ApprovalDecision,
  ApprovalStatus,
  RuntimeRequestKind,
} from "@cairn/protocol/Policy";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  Session,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineDocFamily,
  defineEntry,
} from "@earendil-works/pi-durable";
import {
  Duration,
  Effect,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";

import { durable, handOff } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";

/** The creation receipt of one thread: the conversation it lives in, 0 until created. */
export interface ThreadReceiptState {
  [key: string]: JsonValue;
  conversationId: number;
}

/** `cairn.thread`: thread id to conversation id, written in the commit that creates it. */
export const ThreadReceipt = defineDocFamily<
  ThreadReceiptState,
  ThreadReceiptState
>({
  kind: "cairn.thread",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ conversationId: seed.conversationId }),
  // One write per thread, ever.
  checkpointWhen: () => false,
});

/** Which thread and project a conversation is. Empty strings before the creating commit sets them. */
export interface ThreadMetaState {
  [key: string]: JsonValue;
  threadId: string;
  projectId: string;
}

/** `cairn.thread-meta`: the thread a conversation is, so the store describes itself. */
export const ThreadMeta = defineDoc<ThreadMetaState>({
  kind: "cairn.thread-meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ threadId: "", projectId: "" }),
  // Written once, in the creating commit.
  checkpointWhen: () => false,
});

/** One approval: a tool call waiting on, or answered by, the user (ADR 0013). */
export interface ApprovalRecord {
  [key: string]: JsonValue;
  id: string;
  /** The pi-durable tool task that asked; a rerun of that task finds its record again. */
  toolTaskId: number;
  tool: string;
  kind: RuntimeRequestKind;
  /** One line for the approval card. */
  summary: string;
  status: ApprovalStatus;
  askedAt: number;
  expiresAt: number;
  answeredAt: number | null;
  /** The effect sandwich: `started` is committed before the effect runs, `done` after it. */
  run: "started" | "done" | null;
  /** Executor's own `apr_` request id, once Executor asked; boot declines unfinished ones. */
  executorRequestId: string | null;
}

/** `cairn.approvals` document state. */
export interface ApprovalsState {
  [key: string]: JsonValue;
  items: { [id: string]: ApprovalRecord };
}

/** `cairn.approvals`: every approval record of one conversation, by id. */
export const Approvals = defineDoc<ApprovalsState>({
  kind: "cairn.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Data of a `cairn.user` entry: who sent it, and the attachments it carries. */
export type CairnUserData = Readonly<{
  from: string;
  attachments: Array<{ [key: string]: JsonValue }>;
}>;

/** A user input recorded with its sender and attachments; the model still sees its content. */
export const CairnUserEntry = defineEntry<CairnUserData>("cairn.user");

/** A display-only marker where a checkpoint was captured, for the turn's diff. */
export const CairnCheckpointEntry = defineEntry<{
  ref: string;
  turn: number;
}>("cairn.checkpoint");

/** A ledger call failed; the tool that asked should end with an error result. */
export class ApprovalLedgerError extends Schema.TaggedError<ApprovalLedgerError>()(
  "ApprovalLedgerError",
  {
    message: Schema.String,
    approvalId: Schema.String,
    reason: Schema.Literals(["missing_record", "store_failed", "aborted"]),
  }
) {}

/** What a tool asks the user for. */
export interface ApprovalRequest {
  readonly tool: string;
  readonly kind: RuntimeRequestKind;
  readonly summary: string;
  /** How long the record stays answerable. */
  readonly ttlMillis: number;
  /** Full access: record the approval as accepted at once, for the audit trail and the sandwich. */
  readonly autoAccept: boolean;
}

/**
 * The approval records of one tool call. `ask` is idempotent (a rerun finds its record), and
 * `begin` returns what an earlier attempt already marked, so a rerun after `started` never runs
 * the effect twice.
 */
export interface ApprovalLedger {
  /** This call's approval id: one per tool task. */
  readonly approvalId: string;
  ask(
    request: ApprovalRequest
  ): Effect.Effect<ApprovalRecord, ApprovalLedgerError>;
  /** Waits until the record is answered or expires (and records the expiry). */
  readonly awaitAnswer: Effect.Effect<ApprovalStatus, ApprovalLedgerError>;
  /** Marks `started`; returns the mark an earlier attempt left, if any. */
  readonly begin: Effect.Effect<
    Option.Option<"started" | "done">,
    ApprovalLedgerError
  >;
  /** Records Executor's own request id for this call. */
  noteExecutorRequest(
    requestId: string
  ): Effect.Effect<void, ApprovalLedgerError>;
  /** Marks `done` after the effect. */
  readonly finish: Effect.Effect<void, ApprovalLedgerError>;
}

const storeFailed = (approvalId: string) => (error: DurableCallError) =>
  new ApprovalLedgerError({
    message: `Recording approval ${approvalId} failed: ${error.message}. The tool call stops here.`,
    approvalId,
    reason: error.closed ? "aborted" : "store_failed",
  });

const missing = (approvalId: string) =>
  new ApprovalLedgerError({
    message: `Approval ${approvalId} has no record. Ask for it before using it.`,
    approvalId,
    reason: "missing_record",
  });

const copy = (record: ApprovalRecord): ApprovalRecord => ({ ...record });

/** The approval id of a tool task. Stable across reruns of that task. */
export const approvalIdOf = (taskId: number) => `call-${taskId}`;

/** The ledger of one tool invocation, committing through that invocation's own `commit`. */
export const approvalLedger = (api: ToolExecutionApi): ApprovalLedger => {
  const approvalId = approvalIdOf(api.taskId);
  const { conversationId } = api;
  const fail = storeFailed(approvalId);

  // Applies `change` to this call's record in one transaction; none when it has no record.
  const change = <A>(
    operation: string,
    apply: (items: ApprovalsState["items"]) => A
  ) =>
    durable(
      operation,
      async (context) =>
        await api.commit(async (tx) => {
          const doc = await tx.doc(Approvals, conversationId);

          return apply(doc.items);
        }, context)
    ).pipe(Effect.mapError(fail));

  const ask = (request: ApprovalRequest) =>
    change("approvals.ask", (items) => {
      const existing = items[approvalId];

      if (existing !== undefined) {
        return copy(existing);
      }

      const askedAt = api.now();

      const record: ApprovalRecord = {
        id: approvalId,
        toolTaskId: api.taskId,
        tool: request.tool,
        kind: request.kind,
        summary: request.summary,
        status: request.autoAccept ? "accepted" : "pending",
        askedAt,
        expiresAt: askedAt + request.ttlMillis,
        answeredAt: request.autoAccept ? askedAt : null,
        run: null,
        executorRequestId: null,
      };

      items[approvalId] = record;

      return copy(record);
    });

  const expire = change("approvals.expire", (items) => {
    const current = items[approvalId];

    if (current === undefined) {
      return Option.none<ApprovalStatus>();
    }

    if (current.status === "pending") {
      current.status = "expired";
      current.answeredAt = api.now();
    }

    return Option.some(current.status);
  });

  // The first status other than `pending` this record takes, from a watch on the conversation's
  // approvals. The listener only hands values on; the stream's scope stops the watch.
  const answered = Stream.callback<ApprovalStatus, ApprovalLedgerError>(
    (queue) => {
      const offer = (value: Readonly<ApprovalsState> | null) => {
        const status = value?.items[approvalId]?.status;

        if (status !== undefined && status !== "pending") {
          Queue.offerUnsafe(queue, status);
        }
      };

      return Effect.gen(function* () {
        const watch = yield* Effect.acquireRelease(
          durable(
            "approvals.watch",
            async (context) =>
              await api.watchDoc(Approvals, conversationId, context)
          ).pipe(
            Effect.mapError(fail),
            Effect.filterOrFail(Predicate.isNotUndefined, () =>
              missing(approvalId)
            )
          ),
          (handle) => Effect.promise(async () => await handle.stop())
        );

        offer(watch.value);
        watch.start(handOff(offer));
      });
    },
    { bufferSize: 1, strategy: "sliding" }
  );

  const read = durable(
    "approvals.read",
    async (context) => await api.snapshot(Approvals, conversationId, context)
  ).pipe(
    Effect.mapError(fail),
    Effect.map((doc) => Option.fromUndefinedOr(doc?.items[approvalId]))
  );

  const awaitAnswer = Effect.gen(function* () {
    const record = yield* read;

    if (Option.isNone(record)) {
      return yield* missing(approvalId);
    }

    if (record.value.status !== "pending") {
      return record.value.status;
    }

    const remaining = Math.max(0, record.value.expiresAt - api.now());

    const answer = yield* answered.pipe(
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(remaining)),
      Effect.map(Option.flatten)
    );

    if (Option.isSome(answer)) {
      return answer.value;
    }

    const expired = yield* expire;

    return yield* Effect.fromOption(expired).pipe(
      Effect.mapError(() => missing(approvalId))
    );
  });

  // Applies `apply` to this call's record; fails when it has no record.
  const update = <A>(operation: string, apply: (record: ApprovalRecord) => A) =>
    change(operation, (items) => {
      const record = items[approvalId];

      return record === undefined
        ? Option.none<A>()
        : Option.some(apply(record));
    }).pipe(
      Effect.flatMap((result) =>
        Effect.fromOption(result).pipe(
          Effect.mapError(() => missing(approvalId))
        )
      )
    );

  const begin = update("approvals.begin", (record) => {
    const before = record.run;

    record.run ??= "started";

    return Option.fromNullOr(before);
  });

  const noteExecutorRequest = (requestId: string) =>
    update("approvals.note-request", (record) => {
      record.executorRequestId = requestId;
    });

  const finish = update("approvals.finish", (record) => {
    record.run = "done";
  });

  return { approvalId, ask, awaitAnswer, begin, noteExecutorRequest, finish };
};

/** How an answer landed: it changed a pending record, the record was already settled, or none. */
export type AnswerOutcome = "answered" | "already_settled" | "not_found";

/**
 * Answers one approval from the host side, in one transaction. A record that is no longer pending
 * stays as it was, so a late or repeated answer cannot run a declined call.
 */
export const answerApproval = (
  session: Pick<Session, "commit">,
  conversationId: ConversationId,
  approvalId: string,
  decision: ApprovalDecision,
  now: number
): Effect.Effect<AnswerOutcome, DurableCallError> =>
  durable(
    "approvals.answer",
    async (context) =>
      await session.commit(async (tx): Promise<AnswerOutcome> => {
        const { items } = await tx.doc(Approvals, conversationId);
        const record = items[approvalId];

        if (record === undefined) {
          return "not_found";
        }

        if (record.status !== "pending") {
          return "already_settled";
        }

        record.status = decision === "accept" ? "accepted" : "declined";
        record.answeredAt = now;

        return "answered";
      }, context)
  );
