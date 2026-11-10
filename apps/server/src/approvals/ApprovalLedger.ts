// The approval ledger (ADR 0013, ADR 0029): the records of `cairn.approvals` from the ask to the
// settlement, over the documents `brain/CairnDocs.ts` declares. It is the interface tools use to
// record an approval and the effect sandwich around it (`started` before the effect, `done` after).
// The shape comes from spikes/4-approvals/brain.ts in this repo. The host side answers a record
// (`answerApproval`) and cancels the records a stopped run held (`cancelStoppedApprovals`); two
// boot repairs cancel those a stop cut off by a crash left behind (`cancelAbandonedApprovalsAtBoot`)
// and expire the records nothing waits on that lapsed (`expireLapsedApprovalsAtBoot`).
//
// What else an answer does in its commit (a brief's Go starts its child, a launch's Go approves its
// row, accepted criteria bind) is the caller's `AnsweredHook`, injected by the features that own
// those records, so this folder imports none of them. A child's question and its parent's mirror
// settle together here (ADR 0027), over the subagents' documents the brain declares.

import { answersProblem } from "@cairn/client-logic/PendingRequests";
import {
  ConversationId as ProtocolConversationId,
  TaskId,
} from "@cairn/protocol/Ids";
import {
  LaunchEdits,
  QuestionAnswer as QuestionAnswerSchema,
  QuestionsPayload,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import type {
  ApprovalDecision,
  Decider,
  QuestionAnswer,
  RuntimeMode,
  ApprovalStatus,
  RuntimeRequestKind,
} from "@cairn/protocol/Policy";
import type { DocumentState } from "@cairn/protocol/Thread";
import type {
  ConversationId,
  Cursor,
  Session,
  TaskId as PiTaskId,
  ToolExecutionApi,
  Tx,
  WatchCall,
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

import { Brain } from "../brain/Brain.ts";
import type { BrainSession } from "../brain/Brain.ts";
import {
  Approvals,
  ThreadMeta,
  ThreadReceipt,
  allowTool,
} from "../brain/CairnDocs.ts";
import type {
  ApprovalAnswerState,
  ApprovalPayloadState,
  ApprovalRecord,
  ApprovalsState,
} from "../brain/CairnDocs.ts";
import { documentCall, durable, handOff } from "../brain/Durable.ts";
import type { DurableCallError, LineFields } from "../brain/Durable.ts";
import { emit } from "../brain/Events.ts";
import { PendingApprovals } from "../brain/PendingApprovals.ts";
import { piConversationId, piTaskId } from "../brain/PiIds.ts";
import {
  ChildDoc,
  EscalationsDoc,
  isLinked,
  markQuestion,
  plainCopy,
} from "../brain/SubagentDocs.ts";
import type { ChildState } from "../brain/SubagentDocs.ts";
import {
  WorkflowsDoc,
  declineRow,
  NODE_BRIEF_TOOLS,
  launchOf,
} from "../brain/WorkflowsDoc.ts";

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
  readonly payload: Option.Option<ApprovalPayloadState>;
  /**
   * The permission mode that accepts this call at ask time without asking (`decidedBy` mode), for
   * the audit trail and the sandwich; none asks the user.
   */
  readonly acceptedBy: Option.Option<RuntimeMode>;
}

/** How a record settled: its status, who decided and the reason they gave. */
export interface ApprovalSettlement {
  readonly status: ApprovalStatus;
  readonly decidedBy: Option.Option<DocumentState<typeof Decider>>;
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

/** A detached deep copy of a record, safe to hold after its transaction ends. */
export const copyRecord = (record: Readonly<ApprovalRecord>): ApprovalRecord =>
  plainCopy(record);

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

/** The status a decision moves a pending record to. */
const STATUS_OF: Readonly<Record<ApprovalDecision, ApprovalStatus>> = {
  accept: "accepted",
  accept_for_thread: "accepted",
  accept_sample: "accepted",
  decline: "declined",
  revise: "revised",
};

const encodeLaunchEdits = Schema.encodeSync(LaunchEdits);

const encodeAnswers = Schema.encodeSync(Schema.Array(QuestionAnswerSchema));

/**
 * One way a pending record settles (ADR 0029): an answer that took, its expiry, the system's
 * cancel (with the words the card shows, if any), or a parent's mirror taking the ending of the
 * child's question it mirrors.
 */
export type SettleMove =
  | { readonly kind: "answer"; readonly answer: RecordAnswer }
  | { readonly kind: "expire" }
  | {
      readonly kind: "cancel";
      readonly why: CancelWhy;
      readonly reason: Option.Option<string>;
    }
  | { readonly kind: "follow"; readonly settled: Readonly<ApprovalRecord> };

/**
 * Settles a pending record in place: the one move out of `pending`, which writes the status,
 * `answeredAt` and `decidedBy` together (and an answer's `answer` and `reason`), and nothing else,
 * so the payload stays as asked. Every settle goes through it, so a record leaves `pending` once:
 * one no longer pending, or a mirror whose child is still pending, stays as it is. Returns whether
 * it moved.
 */
export const settleRecord = (
  record: ApprovalRecord,
  move: SettleMove,
  now: number
): boolean => {
  if (record.status !== "pending") {
    return false;
  }

  if (move.kind === "follow") {
    if (move.settled.status === "pending") {
      return false;
    }

    record.status = move.settled.status;
    record.decidedBy =
      move.settled.decidedBy === null ? null : { ...move.settled.decidedBy };
  } else if (move.kind === "expire") {
    record.status = "expired";
    record.decidedBy = { kind: "expiry" };
  } else if (move.kind === "cancel") {
    record.status = "cancelled";
    record.decidedBy = { kind: "system", why: move.why };
    record.reason = Option.getOrElse(move.reason, () => record.reason);
  } else {
    const { answer } = move;

    record.status = STATUS_OF[answer.decision];
    record.decidedBy = { ...answer.by };
    record.reason = Option.getOrNull(answer.reason);
    record.answer = {
      decision: answer.decision,
      answers: Option.match(answer.answers, {
        onNone: () => null,
        onSome: (answers) => plainCopy(encodeAnswers(answers)),
      }),
      note: null,
      launch: Option.match(answer.launch, {
        onNone: () => null,
        onSome: (edits) => plainCopy(encodeLaunchEdits(edits)),
      }),
    };
  }

  record.answeredAt = now;

  return true;
};

/** Expires a record still pending at its expiry, in place; any other record is left as it is. */
export const expirePending = (record: ApprovalRecord, now: number) => {
  settleRecord(record, { kind: "expire" }, now);
};

/**
 * Whether no task waits on a pending record, so nothing commits its expiry: proposed criteria
 * (`goal_propose_criteria` returns at once) and a record no tool task asked (a budget raise). A
 * mirror has none either, but its child's question ends it.
 */
export const waiterless = (record: ApprovalRecord): boolean =>
  record.status === "pending" &&
  record.mirrorOf === null &&
  (record.kind === "criteria" || record.toolTaskId === 0);

/** The tool of a budget raise record, a thread scope's or a workflow's (`BudgetSources.ts`, `WorkflowBudget.ts`). */
const BUDGET_RAISE_TOOL = "budget_raise";

/**
 * Whether a pending record outlives its `expiresAt`: a budget raise does. It is asked once per
 * epoch and is the way out of a halted scope or workflow, so a late answer is the user's current
 * choice, not a stale one (ADR 0029).
 */
const neverLapses = (record: ApprovalRecord): boolean =>
  record.toolTaskId === 0 && record.tool === BUDGET_RAISE_TOOL;

/** Whether a record is a parent's mirror of its child's escalated question, still pending. */
const pendingMirror = (record: ApprovalRecord): boolean =>
  record.status === "pending" && record.mirrorOf !== null;

/**
 * The ledger of one tool invocation, committing through that invocation's own `commit`. It writes
 * a lifecycle line when a record is asked for and when the wait for it settles, on the context the
 * calling tool runs it with.
 */
export const approvalLedger = (api: ToolExecutionApi): ApprovalLedger => {
  const approvalId = approvalIdOf(api.taskId);
  const { conversationId } = api;
  const fail = storeFailed(approvalId);

  /** One lifecycle line about this call's record. */
  const line = (message: string, fields: LineFields) =>
    Effect.logInfo(message).pipe(
      Effect.annotateLogs({
        conversationId,
        taskId: api.taskId,
        approvalId,
        ...fields,
      })
    );

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

  const ask = (request: ApprovalRequest) => {
    // Whether the record was there already: a rerun after a restart asks again and finds it.
    let again = false;

    return change("approvals.ask", (items) => {
      const existing = items[approvalId];

      again = existing !== undefined;

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
        payload: Option.getOrNull(Option.map(request.payload, plainCopy)),
        answer: accepted ? ACCEPTED_AT_ASK : null,
        decidedBy: Option.match(request.acceptedBy, {
          onNone: () => null,
          onSome: (mode): Decider => ({ kind: "mode", mode }),
        }),
      };

      items[approvalId] = record;

      return copyRecord(record);
    }).pipe(
      Effect.tap((record) =>
        line(again ? "approval asked again" : "approval asked", {
          event: "approval_asked",
          tool: record.tool,
          kind: record.kind,
          status: record.status,
          again,
        })
      )
    );
  };

  const expire = change("approvals.expire", (items) => {
    const current = items[approvalId];

    if (current === undefined) {
      return Option.none<ApprovalSettlement>();
    }

    expirePending(current, api.now());

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
        watch.start(
          handOff((call: WatchCall<Readonly<ApprovalsState>>) => {
            for (const value of Option.toArray(documentCall(call))) {
              offer(value);
            }
          })
        );
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

  /**
   * The settlement, with its lifecycle line: its status and how the wait ended (`how`). Only the
   * status is read: an expiry's settlement still points into its commit's settled overlay, where
   * reading the decider throws.
   */
  const settled = (settlement: ApprovalSettlement, how: string) =>
    Effect.as(
      line("approval settled", {
        event: "approval_settled",
        status: settlement.status,
        how,
      }),
      settlement
    );

  const awaitSettlement = Effect.gen(function* () {
    const record = yield* read;

    if (Option.isNone(record)) {
      return yield* missing(approvalId);
    }

    if (record.value.status !== "pending") {
      return yield* settled(settlementOf(record.value), "found-settled");
    }

    const remaining = Math.max(0, record.value.expiresAt - api.now());

    const answer = yield* answered.pipe(
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(remaining)),
      Effect.map(Option.flatten)
    );

    if (Option.isSome(answer)) {
      return yield* settled(answer.value, "answered");
    }

    const expired = yield* expire;

    return yield* Effect.fromOption(expired).pipe(
      Effect.mapError(() => missing(approvalId)),
      Effect.flatMap((settlement) => settled(settlement, "expired"))
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
  /**
   * The card's budget edit: with Go or Run on 1 first on a workflow's launch, with Go on a
   * subagent's brief (ADR 0047).
   */
  readonly launch: Option.Option<LaunchEdits>;
}

/**
 * How an answer landed: it changed a pending record, the record was already settled, there is no
 * such record, or the record cannot take it (`answers` on a record that asked no questions,
 * answers that do not fit the questions asked, `revise` on anything but a subagent's brief or a
 * workflow's launch, `revise` with no notes: Send back says what to change, Run on 1 first on
 * anything but a workflow's launch, or a budget edit on anything but Go on a subagent's brief or Go
 * or Run on 1 first on a workflow's launch).
 */
export type AnswerOutcome =
  | "answered"
  | "already_settled"
  | "not_found"
  | "refused_answers"
  | "refused_answers_invalid"
  | "refused_revise"
  | "refused_revise_reason"
  | "refused_sample"
  | "refused_launch";

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

  if (outcome === "refused_sample") {
    return Option.some(
      `Approval ${approvalId} is not a workflow's launch, so it cannot run on 1 first. Approve or decline it.`
    );
  }

  if (outcome === "refused_launch") {
    return Option.some(
      `Approval ${approvalId} takes no budget edit: only Go on a subagent's brief, or Go or Run on 1 first on a workflow's launch, carries a changed budget. Answer without it.`
    );
  }

  return outcome === "refused_revise"
    ? Option.some(
        `Approval ${approvalId} is not a subagent's brief or a workflow's launch, so it cannot be sent back. Approve or decline it.`
      )
    : Option.none();
};

/**
 * The tool whose briefs take Send back: `subagent_spawn` (`SPAWN_TOOL` in
 * `subagents/BrainCap.ts`, which imports this module, so the name is written here too).
 */
const SEND_BACK_TOOL = "subagent_spawn";

const decodeQuestions = Schema.decodeUnknownOption(QuestionsPayload);

const isWorkflowLaunch = Schema.is(WorkflowLaunch);

/** Whether a record is a workflow's launch approval: a brief whose frozen payload is a launch. */
export const isLaunchRecord = (record: ApprovalRecord): boolean =>
  record.kind === "brief" && isWorkflowLaunch(record.payload);

/** Whether a record is a subagent's brief, whose Go may carry a budget edit (ADR 0047). */
const isSpawnBriefRecord = (record: ApprovalRecord): boolean =>
  record.kind === "brief" && record.tool === SEND_BACK_TOOL;

/**
 * Why a record refuses Run on 1 first or a budget edit, or none when it takes the answer. A budget
 * edit comes with Go or Run on 1 first on a workflow's launch, and with Go on a subagent's brief
 * (ADR 0047), whose start reads it as the child's budget.
 */
const launchFit = (
  record: ApprovalRecord,
  answer: RecordAnswer
): Option.Option<"refused_sample" | "refused_launch"> => {
  if (answer.decision === "accept_sample" && !isLaunchRecord(record)) {
    return Option.some("refused_sample");
  }

  const takesEdit = isLaunchRecord(record)
    ? answer.decision === "accept" || answer.decision === "accept_sample"
    : isSpawnBriefRecord(record) && answer.decision === "accept";

  return Option.isSome(answer.launch) && !takesEdit
    ? Option.some("refused_launch")
    : Option.none();
};

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
 * Applies an answer to one record in place (`settleRecord`): the status, `answer`, `decidedBy`,
 * `reason` and `answeredAt` together, and nothing else (the payload stays as asked). A record that
 * is no longer pending stays as it was, so a late or repeated answer cannot run a declined call,
 * and one past its `expiresAt` takes no answer (`already_settled`): it expires here when nothing
 * waits on it (`waiterless`). Both harnesses answer through this, pi-durable's inside one
 * transaction.
 */
export const applyAnswer = (
  record: ApprovalRecord,
  answer: RecordAnswer,
  now: number
): AnswerOutcome => {
  if (record.status !== "pending") {
    return "already_settled";
  }

  // Past its expiry a record takes no answer. One nothing waits on expires here; a waiting task
  // commits its own expiry, with what goes with it (a brief's tell to its parent).
  if (now >= record.expiresAt && !neverLapses(record)) {
    if (waiterless(record)) {
      expirePending(record, now);
    }

    return "already_settled";
  }

  if (Option.isSome(answer.answers)) {
    const fit = answersFit(record, answer.answers.value);

    if (fit !== "fits") {
      return fit;
    }
  }

  const launch = launchFit(record, answer);

  if (Option.isSome(launch)) {
    return launch.value;
  }

  // Send back asks the proposer for a new one: a subagent's brief (its parent writes another) or a
  // workflow's launch (its model proposes the script again). A node's own brief has no one to revise
  // it (its workflow reads Go or Decline).
  if (
    answer.decision === "revise" &&
    (record.kind !== "brief" ||
      (record.tool !== SEND_BACK_TOOL && !isLaunchRecord(record)))
  ) {
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

  settleRecord(record, { kind: "answer", answer }, now);

  return "answered";
};

/** A stored conversation id as pi-durable types it. */
const piConversationOf = (id: number) =>
  piConversationId(ProtocolConversationId.make(id));

/**
 * The child's record a mirror stands for, as a draft of the caller's transaction, with the child's
 * conversation; none when no thread receipt or record names it.
 */
const mirroredRecord = async (
  tx: Tx,
  mirror: ApprovalRecord
): Promise<
  Option.Option<{
    readonly childId: ConversationId;
    readonly approvalId: string;
    readonly child: ApprovalRecord;
  }>
> => {
  if (mirror.mirrorOf === null) {
    return Option.none();
  }

  const { approvalId, threadId } = mirror.mirrorOf;

  const receipt = await tx.doc(ThreadReceipt, threadId, {
    conversationId: 0,
  });

  if (receipt.conversationId < 1) {
    return Option.none();
  }

  const childId = piConversationOf(receipt.conversationId);
  const childApprovals = await tx.doc(Approvals, childId);
  const child = childApprovals.items[approvalId];

  return child === undefined
    ? Option.none()
    : Option.some({ childId, approvalId, child });
};

/**
 * When the child question a pending mirror stands for is no longer pending, ends the mirror with
 * the child's status and decider inside the caller's transaction, and marks the question
 * `cancelled` in the parent's registry (which resolves its escalation entry) unless it was
 * answered, as `ask_parent`'s `endUnanswered` would. Returns whether it ended the mirror. A child
 * no thread receipt or record names leaves the mirror as it is.
 */
const endedWithChild = async (
  tx: Tx,
  conversationId: ConversationId,
  mirror: ApprovalRecord,
  now: number
): Promise<boolean> => {
  const found = await mirroredRecord(tx, mirror);

  if (
    Option.isNone(found) ||
    !settleRecord(mirror, { kind: "follow", settled: found.value.child }, now)
  ) {
    return false;
  }

  const { childId, approvalId, child } = found.value;

  await markQuestion(
    tx,
    conversationId,
    childId,
    approvalId,
    child.status === "accepted" ? "answered" : "cancelled",
    Option.none()
  );

  return true;
};

/**
 * Settles, inside the answering transaction, what an answered record is linked to (ADR 0027): a
 * parent's mirror settles the child's escalated question it mirrors, and a child's question settles
 * every mirror of it in its parent, so an answer from either thread lands once and the other
 * reports `already_settled`. A child's question also marks its parent's registry. `link` is the
 * conversation's `cairn.child`, read before the transaction (it never changes once written).
 */
const settleLinked = async (
  tx: Tx,
  conversationId: ConversationId,
  record: ApprovalRecord,
  link: Readonly<ChildState> | undefined,
  answer: RecordAnswer,
  now: number
): Promise<void> => {
  if (record.mirrorOf !== null) {
    const { approvalId, threadId } = record.mirrorOf;

    const receipt = await tx.doc(ThreadReceipt, threadId, {
      conversationId: 0,
    });

    if (receipt.conversationId < 1) {
      return;
    }

    const childId = piConversationOf(receipt.conversationId);
    const childApprovals = await tx.doc(Approvals, childId);
    const child = childApprovals.items[approvalId];

    // `answerApproval` found the child still pending, so it takes the answer too.
    if (child !== undefined && applyAnswer(child, answer, now) !== "answered") {
      return;
    }

    await markQuestion(
      tx,
      conversationId,
      childId,
      approvalId,
      "answered",
      Option.none()
    );

    return;
  }

  if (!isLinked(link) || record.kind !== "user-input") {
    return;
  }

  const parentId = piConversationOf(link.parentConversationId);
  const meta = await tx.doc(ThreadMeta, conversationId);
  const parent = await tx.doc(Approvals, parentId);

  for (const mirror of Object.values(parent.items)) {
    if (
      mirror.mirrorOf?.threadId === meta.threadId &&
      mirror.mirrorOf.approvalId === record.id
    ) {
      applyAnswer(mirror, answer, now);
    }
  }

  await markQuestion(
    tx,
    parentId,
    conversationId,
    record.id,
    "answered",
    Option.none()
  );
};

/** What an answer's events say: the record, its status and who decided. */
const decisionData = (
  conversationId: ConversationId,
  record: ApprovalRecord
) => ({
  conversationId,
  approvalId: record.id,
  kind: record.kind,
  tool: record.tool,
  status: record.status,
  decision: record.answer?.decision ?? null,
  decidedBy: record.decidedBy,
});

/**
 * `brief.approved` for an accepted brief, in the commit that accepted it: an answer's, or a
 * workflow node's dispatch, whose envelope accepted its brief (`decidedBy` envelope, ADR 0032).
 */
export const emitBriefApproved = async (
  tx: Tx,
  conversationId: ConversationId,
  record: ApprovalRecord,
  at: number
): Promise<void> => {
  await emit(tx, {
    name: "brief.approved",
    data: decisionData(conversationId, record),
    at,
    context: Option.none(),
  });
};

/**
 * The events an answer emits in its own commit (ADR 0033): `approval.answered` for every record an
 * answer settles, and `brief.approved` for a brief it accepted (a subagent's, a workflow's launch or
 * a workflow node's own). Written last, after the commit's table reads (pi-durable refuses a table
 * read after a write).
 */
export const emitAnswered = async (
  tx: Tx,
  conversationId: ConversationId,
  record: ApprovalRecord,
  at: number
): Promise<void> => {
  await emit(tx, {
    name: "approval.answered",
    data: decisionData(conversationId, record),
    at,
    context: Option.none(),
  });

  if (record.kind === "brief" && record.status === "accepted") {
    await emitBriefApproved(tx, conversationId, record, at);
  }
};

/** What else an answer does, inside its transaction, to the record it just settled. */
export type AnsweredHook = (
  tx: Tx,
  conversationId: ConversationId,
  record: ApprovalRecord
) => Promise<void>;

/** An answer that does nothing more. */
const noAnsweredHook: AnsweredHook = async () => {
  await Promise.resolve();
};

/**
 * Whether a brief is one a run's own task waits on: a workflow's launch approval (the
 * `workflow_plan` task is the wait) or a workflow node's own brief (the node's task waits on it).
 * A subagent's brief waits for the user with no run.
 */
const workflowBrief = (record: ApprovalRecord) =>
  isLaunchRecord(record) || NODE_BRIEF_TOOLS.has(record.tool);

/**
 * Whether a run holds this record: a pending tool call, question or workflow brief its own tool
 * task waits on. A subagent's brief and criteria wait for the user with no run, and a mirror (in a
 * parent, of its child's escalated question) has no tool task of its own, so a stop leaves those
 * pending. A child's question is held by the child's run even once escalated: stopping the child
 * ends the `ask_parent` call that would read its answer, and `cancelLinkedQuestions` cancels its
 * mirrors.
 */
export const heldByRun = (record: ApprovalRecord) =>
  record.status === "pending" &&
  record.toolTaskId > 0 &&
  (record.kind !== "brief" || workflowBrief(record)) &&
  record.kind !== "criteria" &&
  record.mirrorOf === null;

/**
 * For the records just cancelled in `conversationId`, every workflow launch approval among them
 * declines its row still `proposed`, inside the caller's transaction, so a stopped or abandoned
 * `workflow_plan` leaves no row waiting for a Go nothing would run (ADR 0032).
 */
const declineCancelledLaunches = async (
  tx: Tx,
  conversationId: ConversationId,
  cancelled: ReadonlyArray<ApprovalRecord>
): Promise<void> => {
  const launches = cancelled.flatMap((record) =>
    Option.toArray(
      Option.map(launchOf(record), (launch) => ({ record, launch }))
    )
  );

  if (launches.length === 0) {
    return;
  }

  const ledger = await tx.doc(WorkflowsDoc, conversationId);

  for (const { record, launch } of launches) {
    const row = ledger.items[launch.workflowId];

    if (row !== undefined) {
      declineRow(row, record);
    }
  }
};

/** The `tool` of a question record a child's final answer became (ADR 0027): no tool asked it. */
export const RELAYED_QUESTION_TOOL = "subagent_answer";

/**
 * Whether a record is a pending question a child's final answer became. The reporter task in the
 * parent waits on it, not a run of the child's, so a stop of the child cancels it by its tool
 * (`cancelStoppedApprovals`, `cancelAbandonedApprovals`), whether or not the child runs.
 */
export const relayedQuestion = (record: ApprovalRecord) =>
  record.status === "pending" &&
  record.tool === RELAYED_QUESTION_TOOL &&
  record.mirrorOf === null;

/** A stored task id as pi-durable types it. */
const piTaskOf = (id: number) => piTaskId(TaskId.make(id));

/** The lifecycle line of a system cancel: which records of `conversationId` it ended, and why. */
const cancelledLine =
  (conversationId: ConversationId, why: CancelWhy) =>
  (ids: ReadonlyArray<string>) =>
    Effect.logInfo("approvals cancelled").pipe(
      Effect.annotateLogs({
        event: "approvals_cancelled",
        conversationId,
        why,
        cancelled: ids.length,
        approvalIds: ids.join(","),
      })
    );

/** Why the system cancelled a record: a stop, or boot finding its tool task abandoned. */
export type CancelWhy = "run-stopped" | "boot";

/** Marks a pending record cancelled by the system, in place (`settleRecord`). */
export const cancelRecord = (
  record: ApprovalRecord,
  now: number,
  why: CancelWhy,
  reason: Option.Option<string> = Option.none()
) => {
  settleRecord(record, { kind: "cancel", why, reason }, now);
};

/**
 * For the records just cancelled in `conversationId`, a subagent's questions to its parent: every
 * mirror of them in the parent is cancelled too, and the parent's registry marks each question
 * `cancelled`, inside the caller's transaction (ADR 0027, ADR 0029). Nothing for a conversation
 * that is not a subagent: only a subagent's questions (`ask_parent`, or a final answer the relay
 * turned into one) are routed to a parent or escalated, so the child link is opened only when one
 * was cancelled. Writes documents only.
 */
const cancelLinkedQuestions = async (
  tx: Tx,
  conversationId: ConversationId,
  cancelled: ReadonlyArray<ApprovalRecord>,
  now: number,
  why: CancelWhy
): Promise<void> => {
  const questions = cancelled.filter(
    (record) =>
      record.kind === "user-input" &&
      (record.route === "parent" || record.escalatedAt !== null)
  );

  if (questions.length === 0) {
    return;
  }

  const link = await tx.doc(ChildDoc, conversationId);

  if (!isLinked(link)) {
    return;
  }

  const parentId = piConversationOf(link.parentConversationId);
  const meta = await tx.doc(ThreadMeta, conversationId);
  const parent = await tx.doc(Approvals, parentId);

  for (const question of questions) {
    for (const mirror of Object.values(parent.items)) {
      if (
        mirror.status === "pending" &&
        mirror.mirrorOf?.threadId === meta.threadId &&
        mirror.mirrorOf.approvalId === question.id
      ) {
        cancelRecord(mirror, now, why);
      }
    }

    // oxlint-disable-next-line no-await-in-loop -- document writes, in order
    await markQuestion(
      tx,
      parentId,
      conversationId,
      question.id,
      "cancelled",
      Option.none()
    );
  }
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
 * one of `stopped` (the run's tasks) or owned by one, and any question the conversation's final
 * answer became (`relayedQuestion`), which the stop ends whether or not a run was stopped. Each
 * records `cancelled` with `decidedBy` system `run-stopped`, so the row stops naming a request
 * nobody can answer. Returns the ids.
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

        // A question the child's final answer became ends with the stop too: the child stopped.
        const cancelled = held.filter(
          (record, index) => owned[index] === true || relayedQuestion(record)
        );

        for (const record of cancelled) {
          cancelRecord(record, now, "run-stopped");
        }

        await cancelLinkedQuestions(
          tx,
          conversationId,
          cancelled,
          now,
          "run-stopped"
        );
        await declineCancelledLaunches(tx, conversationId, cancelled);

        return cancelled.map((record) => record.id);
      }, context)
  ).pipe(Effect.tap(cancelledLine(conversationId, "run-stopped")));

/**
 * Whether a held record's tool task will never wait on it again: the task (or an owner up its
 * chain) is ending or under an abort mark, or is gone unless `gone` says otherwise. A stop commits
 * its abort marks before it cancels the records its run held, so a crash between the two leaves
 * exactly this.
 */
const abandonedTask = async (
  tx: Tx,
  taskId: number,
  gone = true
): Promise<boolean> => {
  let current: Option.Option<number> = Option.some(taskId);

  for (let hop = 0; hop <= OWNER_HOPS && Option.isSome(current); hop += 1) {
    // Each hop reads the owner the last one named.
    // oxlint-disable-next-line no-await-in-loop
    const task = await tx.task(piTaskOf(current.value));

    if (task === undefined) {
      return gone;
    }

    if (
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
 * Answers one record from the host side, in one transaction (`applyAnswer`). "Allow for this
 * thread" (`accept_for_thread`) also adds the record's tool to `cairn.permissions` in that commit,
 * and an escalated question settles with its mirror (`settleLinked`). A parent's pending mirror is
 * answered only through its open `cairn.escalations` entry, which the answer resolves. `answered`
 * runs inside the same transaction, for a record the answer moved out of `pending`: a brief's Go
 * creates its child's start task there (ADR 0030), and a workflow launch's Go approves its ledger
 * row (ADR 0032), so each lands with its answer or not at all. The answer's events come last.
 */
export const answerApproval = (
  session: Pick<Session, "commit" | "snapshot">,
  conversationId: ConversationId,
  approvalId: string,
  answer: RecordAnswer,
  now: number,
  answered: AnsweredHook = noAnsweredHook
): Effect.Effect<AnswerOutcome, DurableCallError> =>
  durable("approvals.answer", async (context) => {
    const link = await session.snapshot(ChildDoc, conversationId, context);
    // The record's status as the commit left it, copied out for the lifecycle line.
    let status: string | null = null;

    const taken = await session.commit(async (tx): Promise<AnswerOutcome> => {
      status = null;

      const { items } = await tx.doc(Approvals, conversationId);
      const record = items[approvalId];

      if (record === undefined) {
        return "not_found";
      }

      ({ status } = record);

      // A mirror is answered through its open escalation entry, which is also its authorization
      // (ADR 0027): a pending mirror with none was never escalated here.
      if (record.mirrorOf !== null && record.status === "pending") {
        const index = await tx.doc(EscalationsDoc, conversationId);

        if (index.items[record.mirrorOf.approvalId]?.status !== "open") {
          return "not_found";
        }

        // The child's question ended first (it expired, or its run stopped, in the commits before
        // `ask_parent` ends the parent's side): the mirror ends with it and takes no answer.
        if (await endedWithChild(tx, conversationId, record, now)) {
          return "already_settled";
        }

        // The child's run is being stopped (its `ask_parent` task abort marked, the cancel not yet
        // committed): the answer would land on a question nothing reads, and the stop's cancel
        // ends both records. Read before any write, as below.
        const mirrored = await mirroredRecord(tx, record);

        if (
          Option.isSome(mirrored) &&
          heldByRun(mirrored.value.child) &&
          (await abandonedTask(tx, mirrored.value.child.toolTaskId, false))
        ) {
          return "already_settled";
        }
      }

      // A record whose run a stop is ending (abort marked, the cancel not yet committed) takes no
      // answer: nothing would run on it, and the stop's cancel finds it still pending. A tool task
      // gone from the store is the boot repair's to cancel. Read before any write, as pi-durable
      // reads tables.
      if (
        heldByRun(record) &&
        (await abandonedTask(tx, record.toolTaskId, false))
      ) {
        return "already_settled";
      }

      const outcome = applyAnswer(record, answer, now);

      ({ status } = record);

      if (outcome !== "answered") {
        return outcome;
      }

      // "Allow for this thread" lands with the answer, so the next call of the tool runs at once.
      if (answer.decision === "accept_for_thread") {
        await allowTool(tx, conversationId, record.tool);
      }

      await settleLinked(tx, conversationId, record, link, answer, now);
      await answered(tx, conversationId, record);
      await emitAnswered(tx, conversationId, record, now);

      return outcome;
    }, context);

    return { outcome: taken, status };
  }).pipe(
    Effect.tap(({ outcome, status }) =>
      Effect.logInfo(
        outcome === "answered"
          ? "approval answered"
          : "approval answer not taken"
      ).pipe(
        Effect.annotateLogs({
          event: "approval_answered",
          conversationId,
          approvalId,
          outcome,
          status,
          decision: answer.decision,
          decidedBy: answer.by.kind,
        })
      )
    ),
    Effect.map(({ outcome }) => outcome)
  );

/**
 * Cancels, in one transaction, every record of one conversation that a run held and whose tool
 * task is abandoned (`abandonedTask`), with `decidedBy` system `why`: `boot` for the boot repair,
 * `run-stopped` for a stop that cancels after its abort (`subagent_stop`), which also cancels any
 * question the conversation's final answer became (`relayedQuestion`). Returns the ids.
 */
export const cancelAbandonedApprovals = (
  session: Pick<Session, "commit">,
  conversationId: ConversationId,
  now: number,
  why: CancelWhy
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

        // A stop (not the boot repair) also ends a question the child's final answer became.
        const cancelled = held.filter(
          (record, index) =>
            abandoned[index] === true ||
            (why === "run-stopped" && relayedQuestion(record))
        );

        for (const record of cancelled) {
          cancelRecord(record, now, why);
        }

        await cancelLinkedQuestions(tx, conversationId, cancelled, now, why);
        await declineCancelledLaunches(tx, conversationId, cancelled);

        return cancelled.map((record) => record.id);
      }, context)
  ).pipe(Effect.tap(cancelledLine(conversationId, why)));

/** How many conversations one page of the boot scan reads. */
const SCAN_PAGE = 200;

/**
 * Visits every conversation's `cairn.approvals` that holds a pending record (every one, not only
 * those with live tasks) with `visit`, which returns how many records it changed. Returns the
 * total. The boot repairs read records this way before the Harness resumes. With
 * `PendingApprovals` (the brain's one scan per boot) only those conversations are read;
 * without it, every conversation is.
 */
const sweepApprovals = (
  session: BrainSession,
  visit: (
    conversationId: ConversationId,
    items: ApprovalsState["items"]
  ) => Effect.Effect<number, DurableCallError>
) =>
  Effect.gen(function* () {
    const { harness, storage } = session;
    let cursor: Option.Option<Cursor> = Option.none();
    let changed = 0;

    const index = yield* Effect.serviceOption(PendingApprovals);

    if (Option.isSome(index)) {
      for (const conversationId of yield* index.value.conversations) {
        const approvals = yield* durable(
          "approvals.read",
          async (context) =>
            await harness.snapshot(Approvals, conversationId, context)
        );

        changed += yield* visit(conversationId, approvals?.items ?? {});
      }

      return changed;
    }

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

        changed += yield* visit(conversation.id, approvals?.items ?? {});
      }

      cursor = Option.fromUndefinedOr(page.next);
    } while (Option.isSome(cursor));

    return changed;
  });

/**
 * The boot repair for a stop cut off between its abort and its cancellations (a crash, or a
 * failed cancel): before the Harness resumes, every conversation's held records whose tool task is
 * abandoned are cancelled (`cancelAbandonedApprovals`), so no request nobody can answer stays
 * pending. Every conversation is read, not only those with live tasks, because the tool task of
 * such a record may already be terminal. None without a pi-durable `Brain`. Returns how many it
 * cancelled. `BootRepairs.ts` lists it before the crash accounting (`CrashLimit.ts`).
 */
export const cancelAbandonedApprovalsAtBoot = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return 0;
  }

  const brain = found.value;
  const session = yield* brain.session;

  const cancelled = yield* sweepApprovals(session, (conversationId, items) =>
    Object.values(items).some(heldByRun)
      ? Effect.map(
          cancelAbandonedApprovals(
            session.harness,
            conversationId,
            brain.now(),
            "boot"
          ),
          (ids) => ids.length
        )
      : Effect.succeed(0)
  );

  yield* Effect.logInfo(`cancelled ${cancelled} abandoned approvals`).pipe(
    Effect.annotateLogs({ event: "boot_cancelled_approvals", cancelled })
  );

  return cancelled;
});

/**
 * The boot repair for records nothing waits on (`waiterless`: proposed criteria; a budget raise
 * never lapses, `neverLapses`):
 * no task's timer expires them, so one still pending past its `expiresAt` is expired here, in one
 * commit per conversation, and stops asking for the user. `applyAnswer` refuses an answer to one
 * meanwhile. A pending mirror whose child's question already ended (it expired, then a stop of the
 * child's run skipped it before `ask_parent` ended the mirror) ends with it here too
 * (`endedWithChild`). None without a pi-durable `Brain`. Returns how many records it ended.
 */
export const expireLapsedApprovalsAtBoot = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return 0;
  }

  const brain = found.value;
  const session = yield* brain.session;
  const now = brain.now();

  const lapsed = (record: ApprovalRecord) =>
    waiterless(record) && !neverLapses(record) && now >= record.expiresAt;

  const expired = yield* sweepApprovals(session, (conversationId, items) =>
    Object.values(items).some(
      (record) => lapsed(record) || pendingMirror(record)
    )
      ? durable(
          "approvals.expire-lapsed",
          async (context) =>
            await session.harness.commit(async (tx) => {
              const doc = await tx.doc(Approvals, conversationId);
              const ending = Object.values(doc.items).filter(lapsed);

              for (const record of ending) {
                expirePending(record, now);
              }

              let ended = ending.length;

              for (const mirror of Object.values(doc.items).filter(
                pendingMirror
              )) {
                // oxlint-disable-next-line no-await-in-loop -- document reads, one mirror at a time
                if (await endedWithChild(tx, conversationId, mirror, now)) {
                  ended += 1;
                }
              }

              return ended;
            }, context)
        )
      : Effect.succeed(0)
  );

  yield* Effect.logInfo(`expired ${expired} lapsed approvals`).pipe(
    Effect.annotateLogs({ event: "boot_expired_approvals", expired })
  );

  return expired;
});
