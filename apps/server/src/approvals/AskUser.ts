// `ask_user`'s rules, shared by the pi-durable tool (`AskUserTool.ts`) and the scripted harness:
// the arguments a model may send and the question record they become, and the text the model reads
// once the record settles. A model asks up to nine questions, each with a short header, up to nine
// options (labels, an optional description, an optional recommendation) and whether it takes
// several picks or the user's own words (briefs note, section 4). The question is a `user-input`
// record with a frozen `questions` payload, answered through `thread.respond` like any approval;
// the answer comes back numbered as the questions were.
//
// The argument shape follows t3code's user-input question (packages/contracts/src/orchestrationV2.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92), ideas only, with Ultimate's "recommended" pick.

import { answerText } from "@cairn/client-logic/PendingRequests";
import type { Question } from "@cairn/protocol/Policy";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Option, Result, Schema } from "effect";

import type { ApprovalRecord, JsonRecord } from "../brain/CairnDocs.ts";

/** The tool's name. */
export const ASK_USER_TOOL = "ask_user";

/** How many questions one call asks, and how many options one question offers. */
export const MAX_QUESTIONS = 9;

export const MAX_OPTIONS = 9;

/** The longest header: a short label for the card's step ("Database"). */
export const MAX_HEADER = 80;

/** The longest option label. */
export const MAX_LABEL = 200;

/** The longest question or description. */
export const MAX_TEXT = 4000;

/** How long a question stays answerable: a week, as a brief does (ADR 0030). */
export const QUESTION_TTL_MILLIS = 7 * 86_400_000;

/** The tool's description, the same on both harnesses. */
export const ASK_USER_DESCRIPTION =
  "Ask the user one to nine questions and wait for the answers. Each question has a short header, the question, up to nine options (a label, an optional description, recommended: true on your pick), multiSelect when several picks make sense, and allowCustomAnswer (default true) for an answer in the user's own words. Ask only what the task and your instructions do not settle. The answers come back numbered as you asked.";

const Text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

const OptionArgument = Schema.Struct({
  label: Text(MAX_LABEL),
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MAX_TEXT))
  ),
  recommended: Schema.optionalKey(Schema.Boolean),
});

const QuestionArgument = Schema.Struct({
  header: Text(MAX_HEADER),
  question: Text(MAX_TEXT),
  options: Schema.optionalKey(
    Schema.Array(OptionArgument).check(Schema.isMaxLength(MAX_OPTIONS))
  ),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  allowCustomAnswer: Schema.optionalKey(Schema.Boolean),
});

/** `ask_user`'s arguments as the model sends them. */
export const AskUserArguments = Schema.Struct({
  questions: Schema.Array(QuestionArgument).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_QUESTIONS)
  ),
});

export type AskUserArguments = typeof AskUserArguments.Type;

const decodeArguments = Schema.decodeUnknownResult(AskUserArguments);

/** One option as the record keeps it: plain JSON. */
interface OptionJson {
  [key: string]: JsonValue;
  label: string;
  description: string | null;
  recommended: boolean;
}

/** One question as the record keeps it: plain JSON in the protocol's `Question` shape. */
interface QuestionJson {
  [key: string]: JsonValue;
  header: string;
  question: string;
  options: Array<OptionJson>;
  multiSelect: boolean;
  allowCustomAnswer: boolean;
}

/** A question record to ask: its frozen payload, the questions in it, and the card's one line. */
export interface QuestionAsk {
  readonly payload: JsonRecord;
  readonly questions: ReadonlyArray<Question>;
  readonly summary: string;
}

/** The longest summary line. */
const SUMMARY_MAX = 300;

const summaryOf = (questions: ReadonlyArray<QuestionJson>): string => {
  const [first] = questions;
  const lead = first === undefined ? "Questions" : first.question;

  const more =
    questions.length > 1 ? ` (and ${questions.length - 1} more)` : "";

  const room = SUMMARY_MAX - more.length;

  return `${lead.length > room ? `${lead.slice(0, room - 3)}...` : lead}${more}`;
};

/** Why a question cannot be asked as written, or none. */
const questionProblem = (question: QuestionJson, n: number) => {
  if (question.options.length === 0 && !question.allowCustomAnswer) {
    return Option.some(
      `question ${n} has no options and allows no answer of the user's own`
    );
  }

  const labels = question.options.map((option) => option.label);

  if (new Set(labels).size !== labels.length) {
    return Option.some(`question ${n} offers one label twice`);
  }

  return Option.none<string>();
};

/**
 * The question record `ask_user`'s arguments ask, or the refusal the model reads: arguments that
 * do not fit the shape, a question with nothing to answer with, or one label offered twice.
 * Options default to none, `multiSelect` to false and `allowCustomAnswer` to true.
 */
export const questionAskOf = (
  args: JsonObject
): Result.Result<QuestionAsk, string> => {
  const decoded = decodeArguments(args);

  if (Result.isFailure(decoded)) {
    return Result.fail(
      `ask_user needs one to ${MAX_QUESTIONS} questions, each with a header (at most ${MAX_HEADER} characters), the question, and at most ${MAX_OPTIONS} options with labels. ${decoded.failure.message} Call it again with arguments of that shape.`
    );
  }

  const questions = decoded.success.questions.map((question): QuestionJson => ({
    header: question.header,
    question: question.question,
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? null,
      recommended: option.recommended ?? false,
    })),
    multiSelect: question.multiSelect ?? false,
    allowCustomAnswer: question.allowCustomAnswer ?? true,
  }));

  for (const [index, question] of questions.entries()) {
    const problem = questionProblem(question, index + 1);

    if (Option.isSome(problem)) {
      return Result.fail(
        `ask_user cannot ask this: ${problem.value}. Call it again with that fixed.`
      );
    }
  }

  return Result.succeed({
    payload: { type: "questions", questions },
    questions,
    summary: summaryOf(questions),
  });
};

/** What `ask_user` returns to the model: the text, and whether it is an error result. */
export interface AskUserResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * The result of a settled question record: the numbered answers when accepted (by the user, or a
 * parent answering its child), otherwise why there is no answer, with the decider's reason.
 */
export const askUserResult = (
  record: ApprovalRecord,
  questions: ReadonlyArray<Question>
): AskUserResult => {
  const reason = Option.match(Option.fromNullOr(record.reason), {
    onNone: () => "",
    onSome: (text) => `: ${text}`,
  });

  const results: Readonly<
    Record<ApprovalRecord["status"], () => AskUserResult>
  > = {
    accepted: () => ({
      text: answerText(
        record.decidedBy?.kind === "thread" ? "parent" : "user",
        questions,
        record.answer?.answers ?? []
      ),
      isError: false,
    }),
    declined: () => ({
      text: `The user declined to answer${reason}. Go on without the answers, or ask differently.`,
      isError: true,
    }),
    expired: () => ({
      text: "The questions expired unanswered. Go on without the answers.",
      isError: true,
    }),
    pending: () => ({
      text: "The questions were left unanswered. Nothing was answered.",
      isError: true,
    }),
    cancelled: () => ({
      text: `The questions were cancelled${reason}. Nothing was answered.`,
      isError: true,
    }),
    revised: () => ({
      text: `The questions were revised${reason}. Nothing was answered.`,
      isError: true,
    }),
  };

  return results[record.status]();
};
