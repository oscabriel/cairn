// Question routing (ADR 0027; docs/phase-2/notes/briefs.md section 4, B5; subagents.md section 6).
// A subagent's question goes to its parent's model first, and only what the parent cannot settle
// reaches the user, as a card in the parent thread. The routing is code, not prompt rules.
//
// - A question is a `user-input` record in the child's own `cairn.approvals` with `route:
//   "parent"`: from `ask_parent`, or from a final plain answer whose last line asks for a decision
//   (`needsDecision`, the relay in SubagentTasks.ts, `source: "answer"`).
// - `routeQuestion` offers it to the parent's model as a follow-up input (request id
//   `subagent-q-<child>-<approvalId>`), which the parent answers or escalates with
//   `subagent_reply`, and escalates it by itself when the parent cannot: the parent is halted when
//   it is asked (stopped or failed), the run that was shown the question ends without
//   settling it, the parent is left idle after a failed or stopped run with the question still
//   queued (it is withdrawn there), or the parent's model saw it `QUESTION_WINDOW_MILLIS` ago (from
//   the input's placement, kept as a memo so a rerun keeps the time). Something else escalating it
//   first (the parent's own `subagent_reply`, the `QuestionRoutes` fiber) withdraws the queued
//   input too.
// - The `QuestionRoutes` fiber escalates the open questions of a parent the route cannot watch from
//   inside pi-durable: one the user archived or deleted (shell events), plus, once at start, any
//   such parent it missed. A parent run that crashes cut off too often is ended at boot
//   (`CrashLimit.ts`), which the route sees as a run that ended without settling.
// - `escalateIn` writes the escalation in one commit: the child's record turns to the user, a
//   mirror lands in the parent's `cairn.approvals`, and the parent's `cairn.escalations` indexes it
//   with why it reached the user. An answer from either thread settles both once
//   (`answerApproval`, which resolves a mirror only through an open index entry); `markQuestion`
//   resolves the entry when the question is answered or ends.
//
// Nothing here waits inside a hook or a commit: the route's waits are the replay-safe tool's or the
// reporter task's, which find what was decided meanwhile when they rerun (ADR 0013).

import { setTimeout as sleep } from "node:timers/promises";

import { ThreadId } from "@cairn/protocol/Ids";
import type { QuestionSource } from "@cairn/protocol/Policy";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type {
  ConversationDocToken,
  ConversationHandle,
  ConversationId as PiConversationId,
  Cursor,
  DocumentObserver,
  JsonObject,
  Submission,
  Tx,
} from "@earendil-works/pi-durable";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import {
  Clock,
  Effect,
  Layer,
  Option,
  Predicate,
  PubSub,
  Stream,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import type { BrainSession } from "../brain/Brain.ts";
import {
  Approvals,
  copyRecord,
  settleRecord,
  ThreadMeta,
  ThreadReceipt,
  UNDECIDED,
} from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { durable, errorText } from "../brain/Durable.ts";
import type { DurableRunner } from "../brain/Durable.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import {
  EscalationWhy,
  renderQuestion,
  SubagentRequestIds,
  SubagentToolText,
} from "../brain/SubagentText.ts";
import { EventStore } from "../shell/EventStore.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { conversationOf, parentHalt } from "../subagents/Delivery.ts";
import {
  ChildDoc,
  EscalationsDoc,
  isLinked,
  markQuestion,
  SubagentsDoc,
} from "../subagents/SubagentDocs.ts";
import { awaitDoc } from "../subagents/Waits.ts";
import { decisionOptions } from "./NeedsDecision.ts";

/** How long a parent's model may hold a question it was shown before the user gets it. */
export const QUESTION_WINDOW_MILLIS = 15 * 60 * 1000;

/** How many conversations the start scan reads per page. */
const SCAN_PAGE = 200;

/** One escalation: the child's question, the parent that mirrors it, when and why. */
export interface EscalationTarget {
  readonly parentConversationId: PiConversationId;
  readonly childConversationId: PiConversationId;
  readonly approvalId: string;
  readonly now: number;
  /** Why it reached the user: an `EscalationWhy` text, or the parent's own reason. */
  readonly why: string;
}

/** The id of the mirror a parent keeps of its child's escalated question. */
export const mirrorIdOf = (
  childConversationId: PiConversationId,
  approvalId: string
) => `esc-${childConversationId}-${approvalId}`;

/**
 * Escalates a child's question to the user (ADR 0027), inside the caller's transaction: the
 * child's record turns to the user, a mirror lands in the parent's `cairn.approvals`, and the
 * parent's `cairn.escalations` indexes it with `why`, so the card shows in the parent thread and an
 * answer to either settles both (`answerApproval`). The one store makes every write one commit.
 * Returns whether it escalated: a record that is gone, settled or already escalated is left as it
 * is. Writes documents only.
 */
export const escalateIn = async (
  tx: Tx,
  target: EscalationTarget
): Promise<boolean> => {
  const { items } = await tx.doc(Approvals, target.childConversationId);
  const record = items[target.approvalId];

  if (
    record === undefined ||
    record.status !== "pending" ||
    record.escalatedAt !== null
  ) {
    return false;
  }

  record.route = "user";
  record.escalatedAt = target.now;

  const meta = await tx.doc(ThreadMeta, target.childConversationId);
  const mirrorId = mirrorIdOf(target.childConversationId, target.approvalId);

  const mirror: ApprovalRecord = {
    ...copyRecord(record),
    id: mirrorId,
    toolTaskId: 0,
    askedAt: target.now,
    escalatedAt: null,
    mirrorOf: { threadId: meta.threadId, approvalId: target.approvalId },
  };

  const parent = await tx.doc(Approvals, target.parentConversationId);

  parent.items[mirrorId] = mirror;

  const index = await tx.doc(EscalationsDoc, target.parentConversationId);

  index.items[target.approvalId] = {
    childThreadId: meta.threadId,
    kind: record.kind,
    payload: copyRecord(record).payload,
    askedAt: record.askedAt,
    escalatedAt: target.now,
    why: target.why,
    status: "open",
  };

  await markQuestion(
    tx,
    target.parentConversationId,
    target.childConversationId,
    target.approvalId,
    "escalated",
    Option.some(target.now)
  );

  return true;
};

/**
 * Ends the parent's side of a child's question that settled without an answer (its record
 * expired), inside the caller's transaction: every pending mirror of it in the parent takes the
 * record's status and decider, and the parent's registry marks the question `cancelled` (which
 * resolves its escalation entry), so the parent stops waiting on the user and `subagent_status`
 * stops reporting it open. A record still pending or accepted, or a question the registry already
 * closed, is left as it is. Writes documents only.
 */
export const endUnanswered = async (
  tx: Tx,
  target: Omit<EscalationTarget, "why">
): Promise<void> => {
  const { items } = await tx.doc(Approvals, target.childConversationId);
  const record = items[target.approvalId];

  if (
    record === undefined ||
    record.status === "pending" ||
    record.status === "accepted"
  ) {
    return;
  }

  const meta = await tx.doc(ThreadMeta, target.childConversationId);
  const parent = await tx.doc(Approvals, target.parentConversationId);

  for (const mirror of Object.values(parent.items)) {
    if (
      mirror.status === "pending" &&
      mirror.mirrorOf?.threadId === meta.threadId &&
      mirror.mirrorOf.approvalId === target.approvalId
    ) {
      settleRecord(mirror, { kind: "follow", settled: record }, target.now);
    }
  }

  const registry = await tx.doc(SubagentsDoc, target.parentConversationId);
  const link = await tx.doc(ChildDoc, target.childConversationId);
  const state = registry.items[link.key]?.questions[target.approvalId]?.state;

  if (state === "pending" || state === "escalated") {
    await markQuestion(
      tx,
      target.parentConversationId,
      target.childConversationId,
      target.approvalId,
      "cancelled",
      Option.none()
    );
  }
};

/** The most options a child's question offers: the protocol's `Question`. */
export const MAX_QUESTION_OPTIONS = 9;

/** The longest question or option label: the protocol's `DisplayText`. */
export const MAX_QUESTION_LENGTH = 4096;

/**
 * The longest reason a parent's `subagent_reply` may escalate with: its `why` in the parent's
 * `cairn.escalations` (`SubagentToolText.parentEscalated`) stays within `DisplayText`.
 */
export const MAX_ESCALATE_REASON =
  MAX_QUESTION_LENGTH - SubagentToolText.parentEscalated("").length;

/**
 * The question a final answer that asks for a decision becomes (the relay): the answer, its ending
 * kept within `MAX_QUESTION_LENGTH`, and the numbered options it ends with as the question's
 * options, so the card offers them as picks (none past `MAX_QUESTION_OPTIONS` or too long a label).
 */
export const relayedAsk = (answer: string) => {
  const options = decisionOptions(answer);

  return {
    question: answer.trim().slice(-MAX_QUESTION_LENGTH),
    options:
      options.length <= MAX_QUESTION_OPTIONS &&
      options.every((label) => label.length <= MAX_QUESTION_LENGTH)
        ? options
        : [],
  };
};

/** A question a child puts to its parent, as its record freezes it. */
export interface AskedQuestion {
  readonly approvalId: string;
  /** The task that waits on it: `ask_parent`'s, or the reporter that relayed an answer. */
  readonly toolTaskId: number;
  readonly tool: string;
  readonly source: QuestionSource;
  readonly askedAt: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
}

/** The pending record of a child's question to its parent (ADR 0027), in the child's ledger. */
export const questionRecord = (
  asked: AskedQuestion,
  ttlMillis: number
): ApprovalRecord => ({
  id: asked.approvalId,
  toolTaskId: asked.toolTaskId,
  tool: asked.tool,
  kind: "user-input",
  summary: asked.question,
  status: "pending",
  askedAt: asked.askedAt,
  expiresAt: asked.askedAt + ttlMillis,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  ...UNDECIDED,
  payload: {
    type: "questions",
    questions: [
      {
        header: "Question",
        question: asked.question,
        options: asked.options.map((label) => ({
          label,
          description: null,
          recommended: false,
        })),
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ],
    source: asked.source,
  },
  route: "parent",
});

/**
 * Escalates, inside the caller's transaction, every question a parent's children still route to
 * it, with `why`: the parent can no longer settle them. Returns how many it escalated.
 */
export const escalateOpenQuestions = async (
  tx: Tx,
  parent: PiConversationId,
  why: string,
  now: number
): Promise<number> => {
  const registry = await tx.doc(SubagentsDoc, parent);
  let escalated = 0;

  for (const item of Object.values(registry.items)) {
    for (const [approvalId, mark] of Object.entries(item.questions)) {
      if (mark.state === "pending") {
        // oxlint-disable-next-line no-await-in-loop -- document writes, in order
        const turned = await escalateIn(tx, {
          parentConversationId: parent,
          childConversationId: conversationOf(item.conversationId),
          approvalId,
          now,
          why,
        });

        escalated += turned ? 1 : 0;
      }
    }
  }

  return escalated;
};

/**
 * What a route needs of the replay-safe tool or the task that waits on the question, bound to its
 * call's context.
 */
export interface RouteIo {
  /** Runs the route's Effects and writes its lines, on the extension layer's context. */
  readonly run: DurableRunner;
  readonly observer: DocumentObserver;
  /** The Harness clock. */
  readonly now: () => number;
  /**
   * The placement time of question `approvalId`: the first value given wins, kept across reruns (a
   * memo named by `placedMemoOf`, so each question of a task that asks more than one keeps its own).
   */
  readonly placedAt: (approvalId: string, candidate: number) => Promise<number>;
  readonly conversation: (
    id: PiConversationId
  ) => Promise<ConversationHandle | undefined>;
  /** Commits `change`, which writes documents only. */
  readonly commitDocs: (change: (tx: Tx) => Promise<void>) => Promise<void>;
  /** Called once the question's input to the parent is admitted: a judge brain's crash point. */
  readonly offered: () => void;
}

/**
 * The memo a route keeps one question's placement time in. A memo lasts its task's whole life, and
 * a reporter relays a question from each final answer that asks one, so the name carries the
 * question's id.
 */
export const placedMemoOf = (approvalId: string) =>
  `cairn.question-placed:${approvalId}`;

/** One question to route. */
export interface Route {
  readonly parent: PiConversationId;
  readonly child: PiConversationId;
  readonly childThreadId: string;
  readonly approvalId: string;
  /** The child's description in its parent's registry. */
  readonly description: string;
  readonly question: string;
  /** How long after its placement the parent's model may hold it. */
  readonly windowMillis: number;
  /** Resolves once the record left `pending`. */
  readonly settled: Promise<unknown>;
  /** A planted fault: a halted parent is offered the question anyway. */
  readonly offerHalted: boolean;
  /** A planted fault: the offer's request id is fresh on every attempt (`freshQuestionIds`). */
  readonly freshId: boolean;
}

/** How a route's race ended. */
type RaceEnd = "answered" | "escalated" | "ended" | "idle" | "window" | "cut";

/**
 * `cut` once `signal` ends the race, never before: a side that cannot decide the race (a document
 * that does not exist, a question withdrawn before its placement) waits here instead of winning it.
 */
const untilCut = async (signal: AbortSignal): Promise<RaceEnd> => {
  if (signal.aborted) {
    return "cut";
  }

  const { promise, resolve } = Promise.withResolvers<RaceEnd>();

  signal.addEventListener(
    "abort",
    () => {
      resolve("cut");
    },
    { once: true }
  );

  return await promise;
};

/**
 * What a side of the race does when its wait throws. An abort (`signal` ended: the race is decided,
 * or the call ended) is `cut` at once. Any other throw is a failure, a storage error under the
 * watch say: it is logged, and the side waits in `untilCut`, so a failed side never wins the race
 * and leaves the question neither answered nor escalated.
 */
const sideFailed = async (
  run: DurableRunner,
  side: string,
  why: string,
  signal: AbortSignal
): Promise<RaceEnd> => {
  if (signal.aborted) {
    return "cut";
  }

  run.fork(
    Effect.logWarning("question route side failed").pipe(
      Effect.annotateLogs({
        event: "question_route_side_failed",
        side,
        cause: why,
      })
    )
  );

  return await untilCut(signal);
};

/**
 * Resolves with `end` once `token` on `conversationId` passes `pick`; `cut` when `signal` ends it. A
 * watch that fails waits for `signal` (`sideFailed`). Its wait runs through `run`. Exported for its
 * test.
 */
export const watchFor = async <T extends JsonObject>(
  run: DurableRunner,
  observer: DocumentObserver,
  token: ConversationDocToken<T>,
  conversationId: PiConversationId,
  pick: (value: Readonly<T> | null) => boolean,
  end: RaceEnd,
  signal: AbortSignal
): Promise<RaceEnd> => {
  let found: Option.Option<boolean>;

  try {
    found = await run.promise(
      awaitDoc(observer, token, conversationId, (value) =>
        pick(value) ? Option.some(true) : Option.none()
      ),
      { signal }
    );
  } catch (error) {
    return await sideFailed(run, `watch ${end}`, errorText(error), signal);
  }

  return Option.isSome(found) ? end : await untilCut(signal);
};

/**
 * `end` once `promise` resolves. A rejection is `cut` when `signal` ended (the call ended), and a
 * failure that waits for `signal` otherwise (`sideFailed`).
 */
const endsAs = async (
  run: DurableRunner,
  promise: Promise<unknown>,
  end: RaceEnd,
  signal: AbortSignal
): Promise<RaceEnd> => {
  try {
    await promise;
  } catch (error) {
    return await sideFailed(run, end, errorText(error), signal);
  }

  return end;
};

/**
 * Waits for the question input's placement, then for the window to pass: `window` once the
 * parent's model held it `windowMillis` since its placement (kept as a memo, so a rerun after a
 * restart keeps the start), `cut` when the race ended first.
 */
const windowPassed = async (
  io: RouteIo,
  route: Route,
  submission: Submission,
  context: ChordContext,
  signal: AbortSignal
): Promise<RaceEnd> => {
  const left = await watchFor(
    io.run,
    io.observer,
    InboxDoc,
    route.parent,
    (inbox) => !(inbox?.items ?? []).some((item) => item.id === submission.id),
    "window",
    signal
  );

  if (left === "cut") {
    return "cut";
  }

  let placed: boolean;

  try {
    const status = await submission.status(context);

    // Withdrawn or ended before a model saw it: the other sides decide.
    placed = status.status === "placed" || status.status === "done";

    if (placed) {
      const placedAt = await io.placedAt(route.approvalId, io.now());
      const wait = Math.max(0, placedAt + route.windowMillis - io.now());

      await sleep(wait, undefined, { signal });
    }
  } catch (error) {
    return await sideFailed(io.run, "window", errorText(error), signal);
  }

  return placed ? "window" : await untilCut(signal);
};

/**
 * Routes a child's pending question to its parent (ADR 0027): a halted parent sends it to the user
 * at once; otherwise the parent's model is offered it as an input, and it escalates by itself when
 * the parent's run that was shown it ends, the parent is left idle with it still queued (withdrawn
 * there), or the window passes after its placement. Returns once the question is answered,
 * escalated or out of the parent's hands; the caller then waits for its record to settle.
 */
export const routeQuestion = async (
  io: RouteIo,
  route: Route,
  context: ChordContext
): Promise<void> => {
  /** The route's lifecycle line: how it was decided (`how`). */
  const decided = (how: string) => {
    io.run.line("question route decided", {
      event: "question_routed",
      conversationId: route.parent,
      childThreadId: route.childThreadId,
      approvalId: route.approvalId,
      how,
    });
  };

  const escalateWith = async (why: string) => {
    await io.commitDocs(async (tx) => {
      await escalateIn(tx, {
        parentConversationId: route.parent,
        childConversationId: route.child,
        approvalId: route.approvalId,
        now: io.now(),
        why,
      });
    });
  };

  // A halted parent is never offered the question.
  let offer = false;
  // Why it was not offered: a halted parent sends it to the user; else it settled first.
  const held = { halted: false };

  await io.commitDocs(async (tx) => {
    const halt = await parentHalt(tx, route.parent);
    const { items } = await tx.doc(Approvals, route.child);
    const record = items[route.approvalId];

    if (
      record === undefined ||
      record.status !== "pending" ||
      record.escalatedAt !== null
    ) {
      return;
    }

    if (Option.isSome(halt) && !route.offerHalted) {
      held.halted = true;

      await escalateIn(tx, {
        parentConversationId: route.parent,
        childConversationId: route.child,
        approvalId: route.approvalId,
        now: io.now(),
        why: halt.value,
      });

      return;
    }

    offer = true;
  });

  if (!offer) {
    // `settled`: answered, escalated or gone before the route began; `halted`: sent to the user.
    decided(held.halted ? "escalated-parent-halted" : "already-settled");

    return;
  }

  const conversation = await io.conversation(route.parent);

  const submission = await conversation?.submit(
    {
      type: "input",
      // The kill judge's control mints a fresh id on every attempt, so a rerun offers it again.
      requestId: route.freshId
        ? `${SubagentRequestIds.question(route.childThreadId, route.approvalId)}-${String(io.now())}`
        : SubagentRequestIds.question(route.childThreadId, route.approvalId),
      content: renderQuestion(route.description, route.question),
      whenBusy: "followUp",
    },
    context
  );

  if (submission === undefined) {
    decided("parent-gone");

    return;
  }

  decided("offered-to-parent");
  io.offered();

  const race = new AbortController();

  const signal = AbortSignal.any(
    [context.abortSignal, race.signal].filter(Predicate.isNotUndefined)
  );

  const answered = endsAs(io.run, route.settled, "answered", signal);

  // The run that placed the question ends; a wait rejected by the call ending is `cut`.
  const ended = endsAs(io.run, submission.wait(context), "ended", signal);

  // A parent whose run failed or stopped keeps the question queued (`afterFailedRun: "keep"`),
  // where no run places it.
  const idle = watchFor(
    io.run,
    io.observer,
    LiveDoc,
    route.parent,
    (live) => live?.run === undefined,
    "idle",
    signal
  );

  // Escalated by something else: the parent's own reply, or the `QuestionRoutes` fiber.
  const escalated = watchFor(
    io.run,
    io.observer,
    Approvals,
    route.child,
    (approvals) =>
      (approvals?.items[route.approvalId]?.escalatedAt ?? null) !== null,
    "escalated",
    signal
  );

  const window = windowPassed(io, route, submission, context, signal);

  const first = await Promise.race([answered, ended, idle, escalated, window]);

  race.abort();

  if (first === "answered" || first === "cut") {
    decided(first);

    return;
  }

  if (first === "escalated") {
    // Out of the parent's hands: a question still queued there is withdrawn.
    await submission.abort(context);
    decided("escalated-elsewhere");

    return;
  }

  if (first === "window") {
    await escalateWith(EscalationWhy.parentSlow(route.windowMillis));
    decided("escalated-window-passed");

    return;
  }

  if (first === "idle") {
    const withdrawn = await submission.abort(context);

    // Placed meanwhile: a run took it, so its end decides.
    if (withdrawn !== "aborted") {
      const after = await Promise.race([answered, ended]);

      if (after !== "ended") {
        decided(after);

        return;
      }
    }
  }

  await escalateWith(EscalationWhy.parentRunEnded);
  decided(first === "idle" ? "escalated-parent-idle" : "escalated-run-ended");
};

/** The open questions of `threadId`'s children escalated with `why`, if it has a conversation. */
const escalateForThread = (
  session: BrainSession,
  threadId: ThreadId,
  why: (tx: Tx, parent: PiConversationId) => Promise<Option.Option<string>>,
  now: number
) =>
  durable("questions.escalate-parent", async (context) => {
    const receipt = await session.harness.snapshot(
      ThreadReceipt,
      threadId,
      context
    );

    if (
      receipt === null ||
      receipt === undefined ||
      receipt.conversationId < 1
    ) {
      return 0;
    }

    const parent = conversationOf(receipt.conversationId);
    let escalated = 0;

    await session.harness.commit(async (tx) => {
      const reason = await why(tx, parent);

      if (Option.isSome(reason)) {
        escalated = await escalateOpenQuestions(tx, parent, reason.value, now);
      }
    }, context);

    return escalated;
  });

/** Why the shell row of `threadId` no longer holds questions: archived or deleted. */
const goneWhy = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const rows = yield* ThreadRows;
    const row = yield* rows.get(threadId);

    return Option.flatMap(row, (found) => {
      if (Option.isSome(found.deletedAt)) {
        return Option.some(EscalationWhy.parentDeleted);
      }

      return Option.isSome(found.shell.archivedAt)
        ? Option.some(EscalationWhy.parentArchived)
        : Option.none();
    });
  });

/** The thread of `childThreadId`'s parent, when it is a subagent's thread. */
const parentThreadOf = (session: BrainSession, childThreadId: ThreadId) =>
  durable("questions.parent-of", async (context) => {
    const receipt = await session.harness.snapshot(
      ThreadReceipt,
      childThreadId,
      context
    );

    if (
      receipt === null ||
      receipt === undefined ||
      receipt.conversationId < 1
    ) {
      return Option.none<ThreadId>();
    }

    const link = await session.harness.snapshot(
      ChildDoc,
      conversationOf(receipt.conversationId),
      context
    );

    if (!isLinked(link)) {
      return Option.none<ThreadId>();
    }

    const meta = await session.harness.snapshot(
      ThreadMeta,
      conversationOf(link.parentConversationId),
      context
    );

    return meta === null || meta === undefined
      ? Option.none<ThreadId>()
      : Option.some(ThreadId.make(meta.threadId));
  });

/** Logs an escalation pass that failed; the next event or the next start tries again. */
const logged = <A, E extends { readonly message: string }, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.tapError((failure) =>
      Effect.logWarning("questions not escalated").pipe(
        Effect.annotateLogs({
          event: "question_escalation_failed",
          threadId,
          error: failure.message,
        })
      )
    ),
    Effect.option
  );

/**
 * The start scan: every parent with a question still routed to it whose thread is archived or
 * deleted escalates it. Parents are found by their `cairn.subagents`.
 */
export const escalateStrandedQuestions = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return 0;
  }

  const session = yield* found.value.session;
  let after: Option.Option<Cursor> = Option.none();
  let escalated = 0;

  do {
    const cursor = Option.getOrUndefined(after);

    const page = yield* durable(
      "conversations.scan",
      async (context) =>
        await session.storage.scanConversations({}, SCAN_PAGE, cursor, context)
    );

    for (const conversation of page.items) {
      const open = yield* durable("questions.open", async (context) => {
        const registry = await session.harness.snapshot(
          SubagentsDoc,
          conversation.id,
          context
        );

        const meta = await session.harness.snapshot(
          ThreadMeta,
          conversation.id,
          context
        );

        const asking = Object.values(registry?.items ?? {}).some((item) =>
          Object.values(item.questions).some((mark) => mark.state === "pending")
        );

        return asking && meta !== null && meta !== undefined
          ? Option.some(ThreadId.make(meta.threadId))
          : Option.none();
      });

      for (const threadId of Option.toArray(open)) {
        const gone = yield* Effect.option(goneWhy(threadId)).pipe(
          Effect.map(Option.flatten)
        );

        if (Option.isNone(gone)) {
          continue;
        }

        const now = yield* Clock.currentTimeMillis;

        const count = yield* logged(
          threadId,
          escalateForThread(
            session,
            threadId,
            async () => await Promise.resolve(gone),
            now
          )
        );

        escalated += Option.getOrElse(count, () => 0);
      }
    }

    after = Option.fromUndefinedOr(page.next);
  } while (Option.isSome(after));

  return escalated;
});

/**
 * The fiber that escalates the questions a parent can no longer settle, which the route cannot see
 * from inside pi-durable: a `thread.archived` or `thread.deleted` shell event for the parent. It first escalates any it missed while down
 * (`escalateStrandedQuestions`). Off without pi-durable. Leaves `HarnessSeam`, `EventStore` and
 * `ThreadRows` to the composition root.
 */
export const QuestionRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const harness = yield* HarnessSeam;
    const brain = yield* Effect.serviceOption(Brain);
    const store = yield* EventStore;
    const context = yield* Effect.context<ThreadRows>();

    if (Option.isNone(brain)) {
      return;
    }

    const now = Clock.currentTimeMillis;

    const onGone = (threadId: ThreadId, why: string) =>
      Effect.gen(function* () {
        const session = yield* brain.value.session;

        return yield* escalateForThread(
          session,
          threadId,
          async () => await Promise.resolve(Option.some(why)),
          yield* now
        );
      }).pipe((effect) => logged(threadId, effect));

    // A child asks a parent the user already archived or deleted: the route offered it to the
    // parent's model, which cannot see the user's answer there, so it goes to the user (and the
    // route withdraws the input if it is still queued).
    const onAsked = (childThreadId: ThreadId) =>
      Effect.gen(function* () {
        const session = yield* brain.value.session;
        const parent = yield* parentThreadOf(session, childThreadId);

        for (const threadId of Option.toArray(parent)) {
          const gone = yield* goneWhy(threadId);

          if (Option.isSome(gone)) {
            yield* escalateForThread(
              session,
              threadId,
              async () => await Promise.resolve(gone),
              yield* now
            );
          }
        }
      }).pipe(Effect.provideContext(context), (effect) =>
        logged(childThreadId, effect)
      );

    const subscription = yield* store.subscribe;

    yield* Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
      Stream.runForEach((event) =>
        event.aggregateKind === "thread" &&
        (event.type === "thread.archived" || event.type === "thread.deleted")
          ? onGone(
              event.aggregateId,
              event.type === "thread.archived"
                ? EscalationWhy.parentArchived
                : EscalationWhy.parentDeleted
            )
          : Effect.void
      ),
      Effect.forkScoped({ startImmediately: true })
    );

    yield* Stream.runForEach(harness.events, (event) =>
      Predicate.isTagged(event, "RuntimeRequestUpdated") &&
      event.kind === "user-input" &&
      event.status === "pending"
        ? onAsked(event.threadId)
        : Effect.void
    ).pipe(Effect.forkScoped({ startImmediately: true }));

    yield* logged("all", escalateStrandedQuestions).pipe(
      Effect.provideContext(context),
      Effect.forkScoped({ startImmediately: true })
    );
  })
);
