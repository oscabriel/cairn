// Cairn's documents and entry kinds inside pi-durable's store. Kinds are protocol: a `cairn.*` name
// never changes, and a shape change is a `version` bump with `migrate`.
//
// - `cairn.thread` (session family keyed by thread id) is the creation receipt: one commit creates
//   the conversation, configures it and records it here, so a raced `ensureThread` lands once.
// - `cairn.thread-meta` (conversation) names the thread and project, so the store describes itself
//   and a lost cairn.sqlite can be re-linked. A fork starts empty: it is another thread.
// - `cairn.permissions` (conversation) holds the thread's permission mode and the tools "Allow for
//   this thread" added (ADR 0031); gated tools read it at call time (Permissions.ts).
// - `cairn.approvals` (conversation) holds decision records, version 2 (ADR 0029): spike 4's
//   shape plus who decided (`decidedBy`), why (`reason`), the `answer` and a `payload` frozen at
//   ask time. Version 1 records migrate on first access. It is a conversation document so the
//   thread's own view carries its approvals.
//
// The approval ledger is the interface tools use to record an approval and the effect sandwich
// around it (`started` before the effect, `done` after), so callers outside `brain/` never touch
// pi-durable. The shape comes from spikes/4-approvals/brain.ts in this repo. The host side answers
// a record (`answerApproval`) and cancels the records a stopped run held (`cancelStoppedApprovals`);
// a boot repair cancels those a stop cut off by a crash left behind (`cancelAbandonedApprovals`).

import { answersProblem } from "@cairn/client-logic/PendingRequests";
import { TaskId } from "@cairn/protocol/Ids";
import {
  APPROVALS_DOCUMENT,
  APPROVALS_VERSION,
  ApprovalStatus,
  DEFAULT_RUNTIME_MODE,
  PERMISSIONS_DOCUMENT,
  QuestionsPayload,
  RuntimeRequestKind,
} from "@cairn/protocol/Policy";
import type {
  ApprovalDecision,
  ApprovalRoute,
  Decider,
  QuestionAnswer,
  RuntimeMode,
} from "@cairn/protocol/Policy";
import { copyJson } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  Cursor,
  Session,
  TaskId as PiTaskId,
  ToolExecutionApi,
  Tx,
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

import { Brain } from "./Brain.ts";
import { durable, handOff } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import { piTaskId } from "./PiIds.ts";

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

/** A JSON object as a document holds it. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/** A question's answer as a record keeps it: the option labels picked and any custom text. */
export interface QuestionAnswerState {
  [key: string]: JsonValue;
  index: number;
  picks: Array<string>;
  custom: string | null;
}

/** What the decider answered: the protocol's `ApprovalAnswer` as plain JSON. */
export interface ApprovalAnswerState {
  [key: string]: JsonValue;
  decision: ApprovalDecision;
  answers: Array<QuestionAnswerState> | null;
  note: string | null;
  /** A workflow launch's edited budget and roles (package 5A); null runs the payload as proposed. */
  launch: JsonRecord | null;
}

/** The child a brief started, set once by its start task. */
export interface StartedState {
  [key: string]: JsonValue;
  childThreadId: string;
}

/** The child's escalated question a parent's record mirrors. */
export interface MirrorState {
  [key: string]: JsonValue;
  threadId: string;
  approvalId: string;
}

/**
 * One decision record (ADR 0013, ADR 0029): a gated tool call, a question, a brief or proposed
 * criteria, and who decided it and why. The protocol's `ApprovalRecord` schema describes the same
 * JSON. `payload` never changes after the ask; `status` leaves `pending` once, and every status
 * past `pending` has `decidedBy` set.
 */
export interface ApprovalRecord {
  [key: string]: JsonValue;
  id: string;
  /** The pi-durable tool task that asked; a rerun of it finds its record again. 0 for a mirror. */
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
  /** Frozen at ask time: a brief, questions or criteria. A plain tool call keeps `summary`. */
  payload: JsonRecord | null;
  answer: ApprovalAnswerState | null;
  /** Null only while `pending`. */
  decidedBy: Decider | null;
  /** The user's words on Decline or Send back, a parent's reason, or a rule's text. */
  reason: string | null;
  /** Questions only; every other kind is `user`. */
  route: ApprovalRoute;
  escalatedAt: number | null;
  /** Briefs: the revision this one replaces. */
  supersedes: string | null;
  /** Briefs: set once, by the start task. */
  started: StartedState | null;
  /** Briefs: the hash of the rendered input the child received. */
  briefHash: string | null;
  /** In a parent's document: the child's escalated question this record mirrors. */
  mirrorOf: MirrorState | null;
}

/** `cairn.approvals` document state. */
export interface ApprovalsState {
  [key: string]: JsonValue;
  items: { [id: string]: ApprovalRecord };
}

const isJsonRecord = (value: JsonValue | undefined): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value);

/** A record as version 1 of `cairn.approvals` stored it. */
const ApprovalRecordV1 = Schema.Struct({
  id: Schema.String,
  toolTaskId: Schema.Finite,
  tool: Schema.String,
  kind: RuntimeRequestKind,
  summary: Schema.String,
  status: ApprovalStatus,
  askedAt: Schema.Finite,
  expiresAt: Schema.Finite,
  answeredAt: Schema.NullOr(Schema.Finite),
  run: Schema.NullOr(Schema.Literals(["started", "done"])),
  executorRequestId: Schema.NullOr(Schema.String),
});

type ApprovalRecordV1 = typeof ApprovalRecordV1.Type;

const decodeRecordV1 = Schema.decodeUnknownOption(ApprovalRecordV1);

/**
 * Who decided a version 1 record, read from what it kept. Phase 1 wrote `accepted` at ask time
 * only for full access, with `answeredAt` equal to `askedAt`; the user's answers and the expiry
 * came later. No phase 1 brain wrote `cancelled`, so one comes from a scripted store's stop.
 */
const v1Decider = (record: ApprovalRecordV1): Decider | null => {
  const deciders: Record<ApprovalStatus, Decider | null> = {
    pending: null,
    accepted:
      record.answeredAt === record.askedAt
        ? { kind: "mode", mode: "full-access" }
        : { kind: "user" },
    declined: { kind: "user" },
    revised: { kind: "user" },
    expired: { kind: "expiry" },
    cancelled: { kind: "system", why: "run-stopped" },
  };

  return deciders[record.status];
};

/** The answer a version 1 status implies: accept or decline, with nothing else recorded. */
const v1Answer = (record: ApprovalRecordV1): ApprovalAnswerState | null =>
  record.status === "accepted" || record.status === "declined"
    ? {
        decision: record.status === "accepted" ? "accept" : "decline",
        answers: null,
        note: null,
        launch: null,
      }
    : null;

/** The version 2 fields a version 1 record gains: nothing it never kept. */
const V1_GAINS = {
  payload: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
} as const satisfies Partial<ApprovalRecord>;

/** A version 1 record as version 2 keeps it: every field kept, the decider read from the status. */
const fromV1 = (record: ApprovalRecordV1): ApprovalRecord => ({
  ...record,
  ...V1_GAINS,
  answer: v1Answer(record),
  decidedBy: v1Decider(record),
});

/** How much of an unreadable record its summary keeps. */
const UNREADABLE_SUMMARY_MAX = 500;

/** The one field an unreadable record may still say: when it was asked. */
const decodeAskedAt = Schema.decodeUnknownOption(
  Schema.Struct({ askedAt: Schema.Finite })
);

/**
 * A stored record no version can read, kept rather than dropped: cancelled at the migration
 * (`decidedBy` system `boot`) with what it kept in `summary`, so nobody can answer it and the loss
 * shows on the card instead of vanishing.
 */
const unreadable = (id: string, raw: JsonValue | undefined): ApprovalRecord => {
  const at = Option.match(decodeAskedAt(raw), {
    onNone: () => 0,
    onSome: (kept) => kept.askedAt,
  });

  return {
    id,
    toolTaskId: 0,
    tool: "unknown",
    kind: "tool-call",
    summary:
      `Unreadable record kept at migration: ${JSON.stringify(raw ?? null)}`.slice(
        0,
        UNREADABLE_SUMMARY_MAX
      ),
    status: "cancelled",
    askedAt: at,
    expiresAt: at,
    answeredAt: at,
    run: null,
    executorRequestId: null,
    ...V1_GAINS,
    answer: null,
    decidedBy: { kind: "system", why: "boot" },
  };
};

/**
 * `cairn.approvals` version 1 to 2, pure as pi-durable's `migrate` must be. Every record keeps its
 * fields and gains version 2's: `payload`, `reason` and the brief and question fields are null and
 * `route` is `user`, because version 1 held only tool calls and kept no words; `decidedBy` and
 * `answer` are read from the status, so every status past `pending` names a decider (invariant 8
 * of `docs/golden/thread-states.md`). A record that is not version 1's shape is kept as cancelled
 * (`unreadable`), never dropped. A version this code does not know throws: a later version adds its
 * own case here, so nothing is lost by a migration that skipped it.
 */
export const migrateApprovals = (
  value: JsonRecord,
  fromVersion: number
): ApprovalsState => {
  if (fromVersion !== 1) {
    throw new Error(
      `cairn.approvals has no migration from version ${fromVersion} to ${APPROVALS_VERSION}`
    );
  }

  const items: ApprovalsState["items"] = {};
  const stored = isJsonRecord(value.items) ? value.items : {};

  for (const [id, raw] of Object.entries(stored)) {
    items[id] = Option.match(decodeRecordV1(raw), {
      onNone: () => unreadable(id, raw),
      onSome: fromV1,
    });
  }

  return { items };
};

/** `cairn.approvals`: every decision record of one conversation, by id (ADR 0029). */
export const Approvals = defineDoc<ApprovalsState>({
  kind: APPROVALS_DOCUMENT,
  version: APPROVALS_VERSION,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  migrate: migrateApprovals,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** `cairn.permissions` state: the thread's mode, and the tools "Allow for this thread" added. */
export interface PermissionsState {
  [key: string]: JsonValue;
  mode: RuntimeMode;
  allow: Array<string>;
}

/** `cairn.permissions`: the mode gated tools read at call time (ADR 0031). */
export const Permissions = defineDoc<PermissionsState>({
  kind: PERMISSIONS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is another thread, which starts in the default mode.
  fork: "initial",
  initial: () => ({ mode: DEFAULT_RUNTIME_MODE, allow: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

/** Writes the thread's mode into its permissions, inside the caller's transaction. */
export const writeMode = async (
  tx: Tx,
  conversationId: ConversationId,
  mode: RuntimeMode
): Promise<void> => {
  const doc = await tx.doc(Permissions, conversationId);

  if (doc.mode !== mode) {
    doc.mode = mode;
  }
};

/** Adds `tool` to the thread's "Allow for this thread" list, inside the caller's transaction. */
export const allowTool = async (
  tx: Tx,
  conversationId: ConversationId,
  tool: string
): Promise<void> => {
  const doc = await tx.doc(Permissions, conversationId);

  if (!doc.allow.includes(tool)) {
    doc.allow.push(tool);
  }
};

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
  /** Frozen on the record at ask time, such as the program an Executor `execute` runs. */
  readonly payload: Option.Option<JsonRecord>;
  /**
   * The permission mode that accepts this call at ask time without asking (`decidedBy` mode), for
   * the audit trail and the sandwich; none asks the user.
   */
  readonly acceptedBy: Option.Option<RuntimeMode>;
}

/** How a record settled: its status, who decided and the reason they gave. */
export interface ApprovalSettlement {
  readonly status: ApprovalStatus;
  readonly decidedBy: Option.Option<Decider>;
  readonly reason: Option.Option<string>;
}

/** A settled record's settlement. */
export const settlementOf = (record: ApprovalRecord): ApprovalSettlement => ({
  status: record.status,
  decidedBy: Option.fromNullOr(record.decidedBy),
  reason: Option.fromNullOr(record.reason),
});

/**
 * The text a tool gives the model for a settlement: the status, then the decider's reason, so a
 * declined call tells the model why ("declined: not before the review").
 */
export const settlementText = (settlement: ApprovalSettlement): string =>
  Option.match(settlement.reason, {
    onNone: () => settlement.status,
    onSome: (reason) => `${settlement.status}: ${reason}`,
  });

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
  /** As `awaitAnswer`, with who decided and why. */
  readonly awaitSettlement: Effect.Effect<
    ApprovalSettlement,
    ApprovalLedgerError
  >;
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

const copyObject = (value: JsonRecord | null): JsonRecord | null => {
  if (value === null) {
    return null;
  }

  const copied = copyJson(value);

  return isJsonRecord(copied) ? copied : null;
};

const copyAnswers = (
  answers: ReadonlyArray<QuestionAnswer | QuestionAnswerState>
): Array<QuestionAnswerState> =>
  answers.map((answer) => ({
    index: answer.index,
    picks: [...answer.picks],
    custom: answer.custom,
  }));

/** A detached deep copy of a record, safe to hold after its transaction ends. */
export const copyRecord = (record: ApprovalRecord): ApprovalRecord => ({
  ...record,
  payload: copyObject(record.payload),
  answer:
    record.answer === null
      ? null
      : {
          ...record.answer,
          answers:
            record.answer.answers === null
              ? null
              : copyAnswers(record.answer.answers),
          launch: copyObject(record.answer.launch),
        },
  decidedBy: record.decidedBy === null ? null : { ...record.decidedBy },
  started: record.started === null ? null : { ...record.started },
  mirrorOf: record.mirrorOf === null ? null : { ...record.mirrorOf },
});

/** The fields a new record starts with past the ask's own: nothing decided, nothing started. */
export const UNDECIDED = {
  payload: null,
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
} as const satisfies Partial<ApprovalRecord>;

/** The answer a record accepted at ask time carries. */
const ACCEPTED_AT_ASK: ApprovalAnswerState = {
  decision: "accept",
  answers: null,
  note: null,
  launch: null,
};

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
        return copyRecord(existing);
      }

      const askedAt = api.now();
      const accepted = Option.isSome(request.acceptedBy);

      const record: ApprovalRecord = {
        id: approvalId,
        toolTaskId: api.taskId,
        tool: request.tool,
        kind: request.kind,
        summary: request.summary,
        status: accepted ? "accepted" : "pending",
        askedAt,
        expiresAt: askedAt + request.ttlMillis,
        answeredAt: accepted ? askedAt : null,
        run: null,
        executorRequestId: null,
        ...UNDECIDED,
        payload: copyObject(Option.getOrNull(request.payload)),
        answer: accepted ? ACCEPTED_AT_ASK : null,
        decidedBy: Option.match(request.acceptedBy, {
          onNone: () => null,
          onSome: (mode): Decider => ({ kind: "mode", mode }),
        }),
      };

      items[approvalId] = record;

      return copyRecord(record);
    });

  const expire = change("approvals.expire", (items) => {
    const current = items[approvalId];

    if (current === undefined) {
      return Option.none<ApprovalSettlement>();
    }

    if (current.status === "pending") {
      current.status = "expired";
      current.answeredAt = api.now();
      current.decidedBy = { kind: "expiry" };
    }

    return Option.some(settlementOf(current));
  });

  // The first settlement this record reaches, from a watch on the conversation's approvals. The
  // listener only hands values on; the stream's scope stops the watch.
  const answered = Stream.callback<ApprovalSettlement, ApprovalLedgerError>(
    (queue) => {
      const offer = (value: Readonly<ApprovalsState> | null) => {
        const record = value?.items[approvalId];

        if (record !== undefined && record.status !== "pending") {
          Queue.offerUnsafe(queue, settlementOf(record));
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

  const awaitSettlement = Effect.gen(function* () {
    const record = yield* read;

    if (Option.isNone(record)) {
      return yield* missing(approvalId);
    }

    if (record.value.status !== "pending") {
      return settlementOf(record.value);
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

  const awaitAnswer = Effect.map(
    awaitSettlement,
    (settlement) => settlement.status
  );

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

  return {
    approvalId,
    ask,
    awaitAnswer,
    awaitSettlement,
    begin,
    noteExecutorRequest,
    finish,
  };
};

/** An answer to one record from the host side: the decision, who made it, and their words. */
export interface RecordAnswer {
  readonly decision: ApprovalDecision;
  readonly by: Decider;
  readonly reason: Option.Option<string>;
  readonly answers: Option.Option<ReadonlyArray<QuestionAnswer>>;
}

/**
 * How an answer landed: it changed a pending record, the record was already settled, there is no
 * such record, or the record cannot take it (`answers` on a record that asked no questions,
 * answers that do not fit the questions asked, `revise` on anything but a brief, or `revise` with
 * no notes: Send back says what to change).
 */
export type AnswerOutcome =
  | "answered"
  | "already_settled"
  | "not_found"
  | "refused_answers"
  | "refused_answers_invalid"
  | "refused_revise"
  | "refused_revise_reason";

/** Why a record refused an answer, in the words both harnesses fail with; none when it took it. */
export const refusalText = (
  outcome: AnswerOutcome,
  approvalId: string
): Option.Option<string> => {
  if (outcome === "refused_answers") {
    return Option.some(
      `Approval ${approvalId} asked no questions, so it takes no answers. Answer it with a decision alone.`
    );
  }

  if (outcome === "refused_answers_invalid") {
    return Option.some(
      `The answers to approval ${approvalId} do not fit its questions. Each answer names one question by its index, picks only that question's option labels (one unless it allows several), adds its own words only where the question allows them, and says something. Fix the answers and send them again.`
    );
  }

  if (outcome === "refused_revise_reason") {
    return Option.some(
      `Sending back approval ${approvalId} needs notes on what to change. Add them and send it back again.`
    );
  }

  return outcome === "refused_revise"
    ? Option.some(
        `Approval ${approvalId} is not a brief, so it cannot be sent back. Approve or decline it.`
      )
    : Option.none();
};

/** The status a decision moves a pending record to. */
const STATUS_OF: Readonly<Record<ApprovalDecision, ApprovalStatus>> = {
  accept: "accepted",
  accept_for_thread: "accepted",
  accept_sample: "accepted",
  decline: "declined",
  revise: "revised",
};

const decodeQuestions = Schema.decodeUnknownOption(QuestionsPayload);

/**
 * How a record takes `answers`: none for a record that asked no questions, refused when they do
 * not fit the questions it asked (`answersProblem`), fine otherwise.
 */
const answersFit = (
  record: ApprovalRecord,
  answers: ReadonlyArray<QuestionAnswer>
): "fits" | "refused_answers" | "refused_answers_invalid" =>
  Option.match(decodeQuestions(record.payload), {
    onNone: () => "refused_answers",
    onSome: (payload) =>
      Option.isSome(answersProblem(payload.questions, answers))
        ? "refused_answers_invalid"
        : "fits",
  });

/**
 * Applies an answer to one record in place: the status, `answer`, `decidedBy`, `reason` and
 * `answeredAt` together, and nothing else (the payload stays as asked). A record that is no longer
 * pending stays as it was, so a late or repeated answer cannot run a declined call. Both harnesses
 * answer through this, pi-durable's inside one transaction.
 */
export const applyAnswer = (
  record: ApprovalRecord,
  answer: RecordAnswer,
  now: number
): AnswerOutcome => {
  if (record.status !== "pending") {
    return "already_settled";
  }

  if (Option.isSome(answer.answers)) {
    const fit = answersFit(record, answer.answers.value);

    if (fit !== "fits") {
      return fit;
    }
  }

  if (answer.decision === "revise" && record.kind !== "brief") {
    return "refused_revise";
  }

  if (
    answer.decision === "revise" &&
    Option.isNone(
      Option.filter(answer.reason, (reason) => reason.trim() !== "")
    )
  ) {
    return "refused_revise_reason";
  }

  record.status = STATUS_OF[answer.decision];
  record.answeredAt = now;
  record.decidedBy = { ...answer.by };
  record.reason = Option.getOrNull(answer.reason);
  record.answer = {
    decision: answer.decision,
    answers: Option.match(answer.answers, {
      onNone: () => null,
      onSome: copyAnswers,
    }),
    note: null,
    launch: null,
  };

  return "answered";
};

/**
 * Answers one record from the host side, in one transaction (`applyAnswer`). "Allow for this
 * thread" (`accept_for_thread`) also adds the record's tool to `cairn.permissions` in that commit.
 */
export const answerApproval = (
  session: Pick<Session, "commit">,
  conversationId: ConversationId,
  approvalId: string,
  answer: RecordAnswer,
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

        const outcome = applyAnswer(record, answer, now);

        // "Allow for this thread" lands with the answer, so the next call of the tool runs at once.
        if (outcome === "answered" && answer.decision === "accept_for_thread") {
          await allowTool(tx, conversationId, record.tool);
        }

        return outcome;
      }, context)
  );

/**
 * Whether a run holds this record: a pending tool call or question its own tool task waits on.
 * Briefs and criteria wait for the user with no run, and an escalated question or a mirror is
 * answered across threads, so a stop leaves those pending.
 */
export const heldByRun = (record: ApprovalRecord) =>
  record.status === "pending" &&
  record.toolTaskId > 0 &&
  record.kind !== "brief" &&
  record.kind !== "criteria" &&
  record.escalatedAt === null &&
  record.mirrorOf === null;

/** A stored task id as pi-durable types it. */
const piTaskOf = (id: number) => piTaskId(TaskId.make(id));

/** Why the system cancelled a record: a stop, or boot finding its tool task abandoned. */
export type CancelWhy = "run-stopped" | "boot";

/** Marks a held record cancelled by the system, in place. */
export const cancelRecord = (
  record: ApprovalRecord,
  now: number,
  why: CancelWhy
) => {
  record.status = "cancelled";
  record.answeredAt = now;
  record.decidedBy = { kind: "system", why };
};

/** How many owners up a tool task may sit below its run's task (a tool, a nested call). */
const OWNER_HOPS = 8;

/** Whether `taskId` is one of `stopped` or owned, through any chain, by one of them. */
const ownedByStopped = async (
  tx: Tx,
  taskId: number,
  stopped: ReadonlySet<number>
): Promise<boolean> => {
  let current: Option.Option<number> = Option.some(taskId);

  for (let hop = 0; hop <= OWNER_HOPS && Option.isSome(current); hop += 1) {
    if (stopped.has(current.value)) {
      return true;
    }

    // Each hop reads the owner the last one named.
    // oxlint-disable-next-line no-await-in-loop
    const task = await tx.task(piTaskOf(current.value));

    current = Option.map(Option.fromUndefinedOr(task?.owner), Number);
  }

  return false;
};

/**
 * Cancels, in one transaction, every pending record a stopped run held: those whose tool task is
 * one of `stopped` (the run's tasks) or owned by one. Each records `cancelled` with `decidedBy`
 * system `run-stopped`, so the row stops naming a request nobody can answer. Returns the ids.
 */
export const cancelStoppedApprovals = (
  session: Pick<Session, "commit">,
  conversationId: ConversationId,
  stopped: ReadonlyArray<PiTaskId>,
  now: number
): Effect.Effect<ReadonlyArray<string>, DurableCallError> =>
  durable(
    "approvals.cancel",
    async (context) =>
      await session.commit(async (tx) => {
        const { items } = await tx.doc(Approvals, conversationId);
        const runTasks = new Set(stopped.map(Number));

        const held = Object.values(items).filter(heldByRun);

        const owned = await Promise.all(
          held.map(
            async (record) =>
              await ownedByStopped(tx, record.toolTaskId, runTasks)
          )
        );

        const cancelled = held.filter(
          (_record, index) => owned[index] === true
        );

        for (const record of cancelled) {
          cancelRecord(record, now, "run-stopped");
        }

        return cancelled.map((record) => record.id);
      }, context)
  );

/**
 * Whether a held record's tool task will never wait on it again: the task (or an owner up its
 * chain) is gone, ending, or under an abort mark. A stop commits its abort marks before it cancels
 * the records its run held, so a crash between the two leaves exactly this.
 */
const abandonedTask = async (tx: Tx, taskId: number): Promise<boolean> => {
  let current: Option.Option<number> = Option.some(taskId);

  for (let hop = 0; hop <= OWNER_HOPS && Option.isSome(current); hop += 1) {
    // Each hop reads the owner the last one named.
    // oxlint-disable-next-line no-await-in-loop
    const task = await tx.task(piTaskOf(current.value));

    if (
      task === undefined ||
      task.abortRequested ||
      task.state.status === "completing" ||
      task.state.status === "terminal"
    ) {
      return true;
    }

    current = Option.map(Option.fromUndefinedOr(task.owner), Number);
  }

  return false;
};

/**
 * Cancels, in one transaction, every record of one conversation that a run held and whose tool
 * task is abandoned (`abandonedTask`), with `decidedBy` system `boot`. Returns the ids.
 */
export const cancelAbandonedApprovals = (
  session: Pick<Session, "commit">,
  conversationId: ConversationId,
  now: number
): Effect.Effect<ReadonlyArray<string>, DurableCallError> =>
  durable(
    "approvals.cancel-abandoned",
    async (context) =>
      await session.commit(async (tx) => {
        const { items } = await tx.doc(Approvals, conversationId);
        const held = Object.values(items).filter(heldByRun);

        const abandoned = await Promise.all(
          held.map(async (record) => await abandonedTask(tx, record.toolTaskId))
        );

        const cancelled = held.filter(
          (_record, index) => abandoned[index] === true
        );

        for (const record of cancelled) {
          cancelRecord(record, now, "boot");
        }

        return cancelled.map((record) => record.id);
      }, context)
  );

/** How many conversations one page of the boot scan reads. */
const SCAN_PAGE = 200;

/**
 * The boot repair for a stop cut off between its abort and its cancellations (a crash, or a
 * failed cancel): before the Harness resumes, every conversation's held records whose tool task is
 * abandoned are cancelled (`cancelAbandonedApprovals`), so no request nobody can answer stays
 * pending. Every conversation is read, not only those with live tasks, because the tool task of
 * such a record may already be terminal. None without a pi-durable `Brain`. Returns how many it
 * cancelled. `BootRepairs.ts` lists it before the parked approval waits are retried.
 */
export const cancelAbandonedApprovalsAtBoot = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return 0;
  }

  const brain = found.value;
  const { harness, storage } = yield* brain.session;
  let cursor: Option.Option<Cursor> = Option.none();
  let cancelled = 0;

  do {
    const after = Option.getOrUndefined(cursor);

    const page = yield* durable(
      "conversations.scan",
      async (context) =>
        await storage.scanConversations({}, SCAN_PAGE, after, context)
    );

    for (const conversation of page.items) {
      const approvals = yield* durable(
        "approvals.read",
        async (context) =>
          await harness.snapshot(Approvals, conversation.id, context)
      );

      if (Object.values(approvals?.items ?? {}).some(heldByRun)) {
        const ids = yield* cancelAbandonedApprovals(
          harness,
          conversation.id,
          brain.now()
        );

        cancelled += ids.length;
      }
    }

    cursor = Option.fromUndefinedOr(page.next);
  } while (Option.isSome(cursor));

  yield* Effect.logInfo(`cancelled ${cancelled} abandoned approvals`).pipe(
    Effect.annotateLogs({ event: "boot_cancelled_approvals", cancelled })
  );

  return cancelled;
});
