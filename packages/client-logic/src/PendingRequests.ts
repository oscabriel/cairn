// Pending requests and settled decisions, read from a thread's `cairn.approvals` (ADR 0029): what
// the request card shows, in which order, what a question's answer must look like, how an answer
// reads back to the model, and the one transcript line a settled record becomes. Pure, so the
// brain (the `ask_user` tool, the answer check both harnesses run) and the client (the card, the
// transcript) read requests the same way.
//
// The card's order is t3code's composer drawer (apps/web/src/components/chat/ChatComposer.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92): approvals first, because they hold a run, then
// questions, then briefs; Cairn adds criteria last. Ideas only; the code is Cairn's.

import type {
  ApprovalPayload,
  ApprovalStatus,
  Brief,
  BudgetRaisePayload,
  CriterionProposal,
  Decider,
  ProgramPayload,
  Question,
  QuestionAnswer,
  RuntimeRequestKind,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import { ApprovalRecord } from "@cairn/protocol/Policy";
import { Data, Match, Option, Predicate, Schema } from "effect";

import { runtimeModePresentation } from "./RuntimeMode.ts";

/** What a pending request asks, by the card body that answers it. */
export type RequestBody = Data.TaggedEnum<{
  Approval: {
    readonly summary: string;
    /** A budget raise or an Executor program; none for a plain tool call. */
    readonly payload: Option.Option<BudgetRaisePayload | ProgramPayload>;
  };
  Question: { readonly questions: ReadonlyArray<Question> };
  Brief: { readonly payload: Brief | WorkflowLaunch };
  Criteria: { readonly criteria: ReadonlyArray<CriterionProposal> };
}>;

/** Constructors and matchers of `RequestBody`. */
export const RequestBody = Data.taggedEnum<RequestBody>();

/** One request the user can answer now, with its place on the card ("2/3"). */
export interface PendingRequest {
  readonly record: ApprovalRecord;
  readonly body: RequestBody;
  /** 1-based. */
  readonly position: number;
  readonly total: number;
}

const decodeRecord = Schema.decodeUnknownOption(ApprovalRecord);

const byAge = (a: ApprovalRecord, b: ApprovalRecord) =>
  a.askedAt - b.askedAt || a.id.localeCompare(b.id);

/**
 * The records of a `cairn.approvals` document as a client holds it (plain JSON), oldest first. A
 * record that does not decode is left out rather than failing the thread: the card cannot offer an
 * answer to a shape it cannot read.
 */
export const approvalRecordsOf = (
  document: Schema.Json | undefined
): ReadonlyArray<ApprovalRecord> => {
  if (!Predicate.isObject(document) || Array.isArray(document)) {
    return [];
  }

  const { items } = document;

  if (!Predicate.isObject(items) || Array.isArray(items)) {
    return [];
  }

  return Object.values(items)
    .flatMap((raw) => Option.toArray(decodeRecord(raw)))
    .toSorted(byAge);
};

/** The card body a record's payload calls for; a payload that does not fit its kind reads as an approval. */
export const requestBodyOf = (record: ApprovalRecord): RequestBody => {
  const payload: ApprovalPayload | null = record.payload;

  if (payload?.type === "questions") {
    return RequestBody.Question({ questions: payload.questions });
  }

  if (payload?.type === "brief" || payload?.type === "workflow") {
    return RequestBody.Brief({ payload });
  }

  if (payload?.type === "criteria") {
    return RequestBody.Criteria({ criteria: payload.criteria });
  }

  return RequestBody.Approval({
    summary: record.summary,
    payload: Option.fromNullOr(payload),
  });
};

/** Card order by kind: approvals hold a run, so they come first. */
const KIND_RANK: Readonly<Record<RuntimeRequestKind, number>> = {
  "tool-call": 0,
  "executor-call": 0,
  "sign-in": 0,
  "user-input": 1,
  brief: 2,
  criteria: 3,
};

/**
 * The requests the user can answer on this thread, in card order: pending and routed to the user
 * (a child's question still with its parent is not the user's yet), approvals first, then
 * questions, briefs and criteria, each group oldest first.
 */
export const pendingRequests = (
  records: ReadonlyArray<ApprovalRecord>
): ReadonlyArray<PendingRequest> => {
  const open = records
    .filter((record) => record.status === "pending" && record.route === "user")
    .toSorted((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || byAge(a, b));

  return open.map((record, index) => ({
    record,
    body: requestBodyOf(record),
    position: index + 1,
    total: open.length,
  }));
};

/** The questions a record asked; none unless its payload is a question payload. */
export const questionsOf = (
  record: Pick<ApprovalRecord, "payload">
): Option.Option<ReadonlyArray<Question>> =>
  record.payload?.type === "questions"
    ? Option.some(record.payload.questions)
    : Option.none();

/**
 * Why `answers` do not fit `questions`, or none when they do. Each answer names a question by its
 * index, once; picks only that question's option labels, each once, and at most one unless it
 * allows several; adds its own words only where the question allows them, and says something.
 * A question left out is unanswered, which the model reads as "(no answer)".
 */
export const answersProblem = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>
): Option.Option<string> => {
  const seen = new Set<number>();

  for (const answer of answers) {
    const question = questions[answer.index];

    if (question === undefined) {
      return Option.some(
        `answer ${answer.index + 1} names no question; there are ${questions.length}`
      );
    }

    if (seen.has(answer.index)) {
      return Option.some(`question ${answer.index + 1} is answered twice`);
    }

    seen.add(answer.index);

    const labels = new Set(question.options.map((option) => option.label));
    const unknown = answer.picks.find((pick) => !labels.has(pick));

    if (unknown !== undefined) {
      return Option.some(
        `"${unknown}" is not an option of question ${answer.index + 1}`
      );
    }

    if (new Set(answer.picks).size !== answer.picks.length) {
      return Option.some(`question ${answer.index + 1} picks one option twice`);
    }

    if (!question.multiSelect && answer.picks.length > 1) {
      return Option.some(`question ${answer.index + 1} takes one pick`);
    }

    const custom = Option.fromNullOr(answer.custom);

    if (Option.isSome(custom) && !question.allowCustomAnswer) {
      return Option.some(
        `question ${answer.index + 1} offers only its options`
      );
    }

    if (
      answer.picks.length === 0 &&
      Option.getOrElse(
        Option.map(custom, (text) => text.trim() === ""),
        () => true
      )
    ) {
      return Option.some(`answer ${answer.index + 1} says nothing`);
    }
  }

  return Option.none();
};

/** One question as answered, for the model and for the settled line. */
export interface AnsweredQuestion {
  readonly header: string;
  /** The picks, then the user's own words; "(no answer)" when left out. */
  readonly text: string;
}

/** What was answered to each question, in the questions' order. */
export const answeredQuestions = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>
): ReadonlyArray<AnsweredQuestion> =>
  questions.map((question, index) => {
    const answer = answers.find((found) => found.index === index);

    const parts: Array<string> = [];

    if (answer !== undefined) {
      parts.push(...answer.picks);

      if (answer.custom !== null && answer.custom.trim() !== "") {
        parts.push(answer.custom);
      }
    }

    return {
      header: question.header,
      text: parts.length === 0 ? "(no answer)" : parts.join(", "),
    };
  });

/**
 * The text a question's answer returns to the model, numbered as the questions were:
 * "The user answered:\n1. Database: Postgres\n2. Targets: staging, production".
 */
export const answerText = (
  by: "user" | "parent",
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>
): string =>
  [
    `The ${by} answered:`,
    ...answeredQuestions(questions, answers).map(
      (answered, index) => `${index + 1}. ${answered.header}: ${answered.text}`
    ),
  ].join("\n");

/** A settled status: every status but `pending`. */
export type SettledStatus = Exclude<ApprovalStatus, "pending">;

/** The one transcript line a settled record becomes: what was decided, by whom, and why. */
export interface SettledLine {
  readonly id: string;
  readonly kind: RuntimeRequestKind;
  readonly tool: string;
  readonly summary: string;
  readonly status: SettledStatus;
  /** Where the line sits among the entries. */
  readonly askedAt: number;
  readonly answeredAt: Option.Option<number>;
  readonly decidedBy: Option.Option<Decider>;
  readonly reason: Option.Option<string>;
  /** "Approved by you", "Declined: not before the review", "Accepted by full access", "Stopped". */
  readonly text: string;
  /** A question's answers; empty for every other kind. */
  readonly answers: ReadonlyArray<AnsweredQuestion>;
}

/** The verb for an accepted record by its body, as the card's main button names it. */
const acceptedVerb = (record: ApprovalRecord): string => {
  const decision = record.answer?.decision;

  return RequestBody.$match(requestBodyOf(record), {
    Question: () => "Answered",
    Brief: () => (decision === "accept_sample" ? "Run on 1 first" : "Go"),
    Criteria: () => "Approved",
    Approval: () =>
      decision === "accept_for_thread" ? "Allowed for this thread" : "Approved",
  });
};

/** Who decided, as the line names them after "by". */
const deciderName = (decider: Decider): string =>
  Match.value(decider).pipe(
    Match.discriminatorsExhaustive("kind")({
      user: () => "you",
      thread: () => "its parent thread",
      mode: (found) => runtimeModePresentation[found.mode].label.toLowerCase(),
      envelope: () => "the workflow's launch approval",
      judge: () => "a judge",
      expiry: () => "expiry",
      system: () => "Cairn",
    })
  );

const withReason = (text: string, reason: Option.Option<string>) =>
  Option.match(reason, {
    onNone: () => text,
    onSome: (said) => `${text}: ${said}`,
  });

const decidedByKind = (
  decider: Option.Option<Decider>,
  kind: Decider["kind"]
) => Option.exists(decider, (found) => found.kind === kind);

/** " <joiner> <decider>", or nothing when nobody is named. */
const named = (decider: Option.Option<Decider>, joiner: "by" | "from") =>
  Option.match(decider, {
    onNone: () => "",
    onSome: (found) => ` ${joiner} ${deciderName(found)}`,
  });

/** The words of an accepted record's line: "Approved by you", "Go from you", "Accepted by full access". */
const acceptedText = (
  record: ApprovalRecord,
  reason: Option.Option<string>
) => {
  const decider = Option.fromNullOr(record.decidedBy);

  if (decidedByKind(decider, "mode")) {
    return withReason(`Accepted${named(decider, "by")}`, reason);
  }

  // A brief's Go comes from someone; every other answer is by someone.
  const joiner = RequestBody.$is("Brief")(requestBodyOf(record))
    ? "from"
    : "by";

  return withReason(`${acceptedVerb(record)}${named(decider, joiner)}`, reason);
};

/** Whether a cancellation was boot's, finding the tool task that asked gone. */
const cancelledAtBoot = (decider: Option.Option<Decider>) =>
  Option.exists(
    decider,
    (found) => found.kind === "system" && found.why === "boot"
  );

/** The words of a settled record's line, by its status. */
const lineText = (
  record: ApprovalRecord,
  status: SettledStatus,
  reason: Option.Option<string>
): string => {
  const decider = Option.fromNullOr(record.decidedBy);

  const texts: Readonly<Record<SettledStatus, () => string>> = {
    accepted: () => acceptedText(record, reason),
    // The user's own Decline reads as their words; anyone else's names them first.
    declined: () =>
      Option.isSome(reason) && decidedByKind(decider, "user")
        ? `Declined: ${reason.value}`
        : withReason(`Declined${named(decider, "by")}`, reason),
    revised: () => withReason("Sent back", reason),
    expired: () => "Expired",
    cancelled: () =>
      cancelledAtBoot(decider) ? "Cancelled at restart" : "Stopped",
  };

  return texts[status]();
};

/** The line one record becomes; none while it is pending. */
export const settledLineOf = (
  record: ApprovalRecord
): Option.Option<SettledLine> => {
  const { status } = record;

  if (status === "pending") {
    return Option.none();
  }

  const reason = Option.fromNullOr(record.reason);

  return Option.some({
    id: record.id,
    kind: record.kind,
    tool: record.tool,
    summary: record.summary,
    status,
    askedAt: record.askedAt,
    answeredAt: Option.fromNullOr(record.answeredAt),
    decidedBy: Option.fromNullOr(record.decidedBy),
    reason,
    text: lineText(record, status, reason),
    answers: Option.match(questionsOf(record), {
      onNone: () => [],
      onSome: (questions) =>
        status === "accepted"
          ? answeredQuestions(questions, record.answer?.answers ?? [])
          : [],
    }),
  });
};

/**
 * Every settled record of a thread as a transcript line, ordered by `askedAt` so the transcript
 * can place each among its entries. A parent's mirror of a child's escalated question is a line
 * too: the parent's card asked it, so the parent's transcript says how it ended.
 */
export const settledLines = (
  records: ReadonlyArray<ApprovalRecord>
): ReadonlyArray<SettledLine> =>
  records
    .toSorted(byAge)
    .flatMap((record) => Option.toArray(settledLineOf(record)));
