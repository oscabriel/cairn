// Ported from github.com/pingdotgg/t3code, apps/web/src/pendingUserInput.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a draft answer per question (picks and the
// user's own words), the user's own words winning over picks where the question takes them, a
// single-select pick replacing the last and a multi-select pick toggling, the progress through a
// card's questions (the active one, how many are answered, whether it may advance, whether the
// whole card is complete), dropping drafts for requests no longer pending, and carrying an answer
// typed into a card that closed under it into the composer's draft. Changed: Cairn's question has
// no option values, initial answer, attachments or thread chips (`Question` in
// `@cairn/protocol/Policy`), so those branches are gone; questions are named by index, as
// `QuestionAnswer` names them; an answer is the protocol's `QuestionAnswer`, and absence is an
// Option, not null.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { Question, QuestionAnswer } from "@cairn/protocol/Policy";
import { Option } from "effect";

/** What the user has given one question so far: option labels picked, and their own words. */
export interface DraftAnswer {
  readonly picks: ReadonlyArray<string>;
  readonly custom: string;
}

/** A request's drafts, by the question's index as a string. */
export type DraftAnswers = Readonly<Record<string, DraftAnswer>>;

/** An untouched draft. */
export const EMPTY_DRAFT: DraftAnswer = { picks: [], custom: "" };

/** The key a question's draft is kept under. */
export const draftKey: (index: number) => string = String;

const draftOf = (drafts: DraftAnswers, index: number): DraftAnswer =>
  drafts[draftKey(index)] ?? EMPTY_DRAFT;

/** The user's own words, trimmed; none when there are none or the question takes none. */
const customOf = (question: Question, draft: DraftAnswer) => {
  const trimmed = draft.custom.trim();

  return question.allowCustomAnswer && trimmed.length > 0
    ? Option.some(trimmed)
    : Option.none();
};

/** The picks that are options of `question`, each once, in the order picked. */
const picksOf = (question: Question, draft: DraftAnswer) => {
  const labels = new Set(question.options.map((option) => option.label));

  return [...new Set(draft.picks)].filter((pick) => labels.has(pick));
};

/**
 * The answer a draft gives question `index`: the user's own words when the question takes them
 * and they wrote some, else every pick on a multi-select question, else the one pick; none while
 * the draft answers nothing.
 */
export const resolveAnswer = (
  question: Question,
  draft: DraftAnswer,
  index: number
): Option.Option<QuestionAnswer> => {
  const custom = customOf(question, draft);

  if (Option.isSome(custom)) {
    return Option.some({ index, picks: [], custom: custom.value });
  }

  const picks = picksOf(question, draft);

  if (picks.length === 0) {
    return Option.none();
  }

  return Option.some({
    index,
    picks: question.multiSelect ? picks : picks.slice(0, 1),
    custom: null,
  });
};

/**
 * The draft after the user typed `custom`: words that say something drop the picks. A question
 * that takes no words of its own keeps its draft.
 */
export const setCustomAnswer = (
  question: Question,
  draft: DraftAnswer,
  custom: string
): DraftAnswer =>
  question.allowCustomAnswer
    ? { picks: custom.trim().length > 0 ? [] : draft.picks, custom }
    : draft;

/**
 * The draft after the user picked `label`: on a multi-select question it toggles, on a single
 * one it replaces the last pick. Either way the user's own words are cleared.
 */
export const toggleOption = (
  question: Question,
  draft: DraftAnswer,
  label: string
): DraftAnswer => {
  if (!question.multiSelect) {
    return { picks: [label], custom: "" };
  }

  const picks = [...new Set(draft.picks)];

  return {
    picks: picks.includes(label)
      ? picks.filter((pick) => pick !== label)
      : [...picks, label],
    custom: "",
  };
};

/** Every question's answer, in order; none while any question is unanswered. */
export const buildAnswers = (
  questions: ReadonlyArray<Question>,
  drafts: DraftAnswers
): Option.Option<ReadonlyArray<QuestionAnswer>> =>
  Option.all(
    questions.map((question, index) =>
      resolveAnswer(question, draftOf(drafts, index), index)
    )
  );

/** How many questions the drafts answer. */
export const countAnswered = (
  questions: ReadonlyArray<Question>,
  drafts: DraftAnswers
): number =>
  questions.filter((question, index) =>
    Option.isSome(resolveAnswer(question, draftOf(drafts, index), index))
  ).length;

/** The first unanswered question's index; the last question's once every one is answered. */
export const firstUnansweredIndex = (
  questions: ReadonlyArray<Question>,
  drafts: DraftAnswers
): number => {
  const unanswered = questions.findIndex((question, index) =>
    Option.isNone(resolveAnswer(question, draftOf(drafts, index), index))
  );

  return unanswered === -1 ? Math.max(questions.length - 1, 0) : unanswered;
};

/** Where the user is in a card's questions. */
export interface Progress {
  /** The active question's index, kept inside the questions. */
  readonly questionIndex: number;
  readonly activeQuestion: Option.Option<Question>;
  readonly activeDraft: DraftAnswer;
  /** The active question's picks that are its options. */
  readonly picks: ReadonlyArray<string>;
  /** The active question's own words as typed; empty when it takes none. */
  readonly custom: string;
  readonly resolvedAnswer: Option.Option<QuestionAnswer>;
  readonly usingCustomAnswer: boolean;
  readonly answeredCount: number;
  readonly isLastQuestion: boolean;
  /** Every question is answered, so the card can be sent. */
  readonly isComplete: boolean;
  /** The active question is answered, so the card may move past it. */
  readonly canAdvance: boolean;
}

/** The progress through `questions` with `drafts`, at question `questionIndex`. */
export const deriveProgress = (
  questions: ReadonlyArray<Question>,
  drafts: DraftAnswers,
  questionIndex: number
): Progress => {
  const index =
    questions.length === 0
      ? 0
      : Math.max(0, Math.min(questionIndex, questions.length - 1));

  const activeQuestion = Option.fromUndefinedOr(questions[index]);
  const activeDraft = draftOf(drafts, index);

  const resolvedAnswer = Option.flatMap(activeQuestion, (question) =>
    resolveAnswer(question, activeDraft, index)
  );

  const custom = Option.match(activeQuestion, {
    onNone: () => "",
    onSome: (question) =>
      question.allowCustomAnswer ? activeDraft.custom : "",
  });

  return {
    questionIndex: index,
    activeQuestion,
    activeDraft,
    picks: Option.match(activeQuestion, {
      onNone: () => [],
      onSome: (question) => picksOf(question, activeDraft),
    }),
    custom,
    resolvedAnswer,
    usingCustomAnswer: custom.trim().length > 0,
    answeredCount: countAnswered(questions, drafts),
    isLastQuestion: index >= questions.length - 1,
    isComplete: Option.isSome(buildAnswers(questions, drafts)),
    canAdvance: Option.isSome(resolvedAnswer),
  };
};

/**
 * Drafts kept only for requests still pending, by request id. Unchanged input is returned as is,
 * so a caller can compare by reference.
 */
export const pruneResolvedDrafts = <A>(
  draftsByRequest: Readonly<Record<string, A>>,
  pendingRequestIds: ReadonlyArray<string>
): Readonly<Record<string, A>> => {
  const pending = new Set(pendingRequestIds);

  const retained = Object.entries(draftsByRequest).filter(([id]) =>
    pending.has(id)
  );

  return retained.length === Object.keys(draftsByRequest).length
    ? draftsByRequest
    : Object.fromEntries(retained);
};

const DISPLACED_ANSWER_SEPARATOR = "\n\n";

/**
 * The composer's draft after a card closed under words the user had typed into it (answered on
 * another device, or stopped): the words go after the draft, a blank line between, so nothing
 * typed is lost.
 */
export const carryDisplacedCustomAnswerIntoPrompt = (
  prompt: string,
  custom: string
): string => {
  const displaced = custom.trim();

  if (displaced.length === 0) {
    return prompt;
  }

  if (prompt.trim().length === 0) {
    return displaced;
  }

  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
};
