// What a parent and its subagent read of each other (ADR 0028, ADR 0027): the child's first input
// rendered from its approved brief, the settlement note, the wake, a routed question, a brief's
// answer, what the subagent tools return, and the request ids that make each land once. Both
// harnesses write these words, so the conformance scenarios and goldens hold them to the same
// text; the subagents extension renders the same.
//
// The settlement's block takes the idea of Fold's `renderSubagentResult` (Fold at 4bd8c58,
// packages/fold-core/src/Subagents/, as docs/phase-2/notes/subagents.md cites it; the idea only,
// no text): the result inside a `<subagent_result>` block, read as data, plus the divergence,
// payload and commit lines Cairn's settlement adds.

import type { Brief } from "@cairn/protocol/Policy";
import type { SubagentSettlement } from "@cairn/protocol/Subagents";
import { Match, Option } from "effect";

/** The first input a child receives: its brief's title and task, then why and how it is judged. */
export const renderBrief = (brief: Brief): string => {
  const lines = [brief.title, "", brief.task];

  if (brief.why.trim() !== "") {
    lines.push("", `Why: ${brief.why}`);
  }

  if (brief.resultSchema !== null) {
    lines.push(
      "",
      "Finish by calling submit_result with your result, which must match its schema, and how it differs from the brief."
    );
  }

  return lines.join("\n");
};

const OUTCOME_WORDS: Readonly<Record<SubagentSettlement["outcome"], string>> = {
  completed: "completed",
  stopped: "was stopped",
  failed: "failed",
};

/** The note a settlement becomes in its parent's transcript. */
export const renderSettlement = (
  description: string,
  settlement: SubagentSettlement
): string => {
  const lines = [
    `Subagent "${description}" (thread ${settlement.subagent}) ${OUTCOME_WORDS[settlement.outcome]}.`,
    "<subagent_result>",
    settlement.summary,
    "</subagent_result>",
    `Divergence: ${settlement.divergence}`,
  ];

  if (settlement.payload !== null) {
    lines.push(`Payload: ${JSON.stringify(settlement.payload)}`);
  }

  if (settlement.commit !== null) {
    lines.push(`Commit: ${settlement.commit}`);
  }

  if (settlement.error !== null) {
    lines.push(`Error: ${settlement.error}`);
  }

  return lines.join("\n");
};

/** The wake that follows a settlement's note when the parent should act on it. */
export const renderWake = (description: string): string =>
  `Subagent "${description}" reported; its result is in the note above.`;

/** The input that carries a child's `ask_parent` question to its parent. */
export const renderQuestion = (description: string, question: string): string =>
  `Subagent "${description}" asks: ${question}\nAnswer with subagent_reply, or escalate it to the user.`;

/** One question's answer as a record keeps it: the labels picked and any custom text. */
export interface QuestionAnswerText {
  readonly picks: ReadonlyArray<string>;
  readonly custom: string | null;
}

/**
 * The words of a question's answer: the picked labels, joined, then the custom text; none when
 * the answer holds neither.
 */
export const answerWords = (
  answer: QuestionAnswerText | undefined
): Option.Option<string> => {
  const parts: Array<string> = answer === undefined ? [] : [...answer.picks];

  if (answer?.custom !== null && answer?.custom !== undefined) {
    parts.push(answer.custom);
  }

  const words = parts.filter((part) => part.trim() !== "");

  return words.length === 0 ? Option.none() : Option.some(words.join("; "));
};

/** What `ask_parent` returns once its question is answered. */
export const renderAnswer = (
  by: "parent" | "user",
  answer: QuestionAnswerText | undefined
): string =>
  `The ${by} answered: ${Option.getOrElse(answerWords(answer), () => "(no answer)")}`;

/** How the user answered a brief, as its parent reads it. */
export type BriefAnswer =
  | { readonly kind: "go"; readonly childThreadId: string }
  | { readonly kind: "declined"; readonly reason: Option.Option<string> }
  | { readonly kind: "revised"; readonly reason: Option.Option<string> }
  | { readonly kind: "expired" };

/** `: <reason>` after an answer's verb, or nothing without one. */
const withReason = (reason: Option.Option<string>) =>
  Option.match(reason, { onNone: () => "", onSome: (text) => `: ${text}` });

/** The text a brief's answer reaches its parent with. */
export const renderBriefAnswer = (title: string, answer: BriefAnswer): string =>
  Match.value(answer).pipe(
    Match.discriminatorsExhaustive("kind")({
      go: (found) =>
        `The user approved the brief "${title}"; subagent thread ${found.childThreadId} started.`,
      declined: (found) =>
        `The user declined the brief "${title}"${withReason(found.reason)}.`,
      revised: (found) =>
        `The user sent back the brief "${title}"${withReason(found.reason)}.`,
      expired: () =>
        `The brief "${title}" expired without an answer; nothing started.`,
    })
  );

/** What `subagent_spawn` returns: the brief waits for the user, and the tool does not. */
export const SPAWN_WAITING =
  "The brief is waiting for the user's Go. You will be told when it is answered.";

/**
 * What the subagent tools return, word for word: the conformance goldens record each, so the
 * subagents extension returns the same.
 */
export const SubagentToolText = {
  /** `subagent_status` for a thread with no subagents. */
  noSubagents: "No subagents.",
  /** One child's line in `subagent_status`. */
  statusLine: (
    child: string,
    description: string,
    status: string,
    asking: boolean
  ) =>
    `${child} "${description}": ${status}${asking ? ", a question is waiting" : ""}`,
  /** A tool naming a subagent the thread does not own. */
  notYours: (named: string) =>
    `No subagent ${named} belongs to this thread. Check the thread id with subagent_status.`,
  /** `subagent_spawn` at the cap of live and proposed children. */
  capReached: (live: number) =>
    `This thread already has ${live} subagents working or waiting for Go, the most it may have. Wait for one to report, then spawn again.`,
  /** `subagent_reply` for a child with no question routed to its parent. */
  noQuestionWaiting: (child: string) =>
    `Subagent ${child} has no question waiting for its parent. Its approvals are the user's to answer.`,
  /** `subagent_reply` whose answer settled the question. */
  replySettled: "settled",
  /** `subagent_reply` for a question something else settled first. */
  replyAlreadySettled: "already_settled",
  /** `subagent_reply` that escalated the question to the user. */
  replyEscalated: "escalated",
  /** `subagent_reply` answering a question already escalated to the user. */
  replyAfterEscalation: (questionId: string, child: string) =>
    `The question ${questionId} from subagent ${child} was escalated to the user, whose answer settles it.`,
  /** The reason an escalation by the parent carries to the user. */
  parentEscalated: (reason: string) => `The parent escalated: ${reason}`,
  /** `subagent_send` once the input is on its way. */
  sent: (child: string) => `Sent to subagent ${child}.`,
  /** `subagent_stop` once the child stopped. */
  stopped: (child: string) =>
    `Stopped subagent ${child}. Uncommitted paths: none.`,
  /** `ask_parent` whose question was cancelled. */
  questionCancelled: "The question was cancelled.",
  /** `ask_parent` whose question ended without an answer. */
  questionEnded: (status: string) => `The question was ${status}.`,
  /** `report` outside a subagent's run. */
  reportOutsideSubagent:
    "report is for a subagent's run. Answer in plain text instead.",
  /** `report` again in a run that already reported. */
  alreadyReported: "Already reported.",
  /** `report` accepted. */
  reported: "Reported.",
  /** `ask_parent` with more options than a question may offer. */
  tooManyOptions: (max: number) =>
    `ask_parent takes at most ${max} options. Call it again with fewer, or none for a free answer.`,
  /** `ask_parent` with a question or an option longer than a card shows. */
  tooLong: (max: number) =>
    `ask_parent's question and each option may be at most ${max} characters. Call it again with shorter ones.`,
  /** `subagent_spawn` missing its description or its brief. */
  spawnNeedsBrief:
    "subagent_spawn needs a description (5 to 10 words) and a brief. Call it again with both.",
  /** `subagent_spawn` whose `result_schema` is not a JSON object. */
  resultSchemaNotObject:
    "subagent_spawn's result_schema must be a JSON Schema object. Pass an object, or leave it out for a text result.",
  /** `subagent_spawn` called by a subagent already at the deepest depth. */
  depthReached: (depth: number) =>
    `This thread is a subagent at depth ${depth}, the deepest one may be, so it cannot start subagents. Do the work here or report back.`,
  /** `subagent_send` with no message. */
  sendNeedsMessage: "subagent_send needs a message. Call it again with one.",
  /** `ask_parent` outside a subagent's run. */
  askOutsideSubagent:
    "ask_parent is for a subagent's run. Ask the user in plain text instead.",
  /** `ask_parent` with no question. */
  askNeedsQuestion: "ask_parent needs a question. Call it again with one.",
  /** `subagent_reply` with neither an answer nor an escalation. */
  replyNeedsAnswer:
    "subagent_reply needs an answer, or escalate with the reason the user should answer. Call it again with one.",
} as const;

/** Why a child's question reached the user without the parent model escalating it (ADR 0027). */
export const EscalationWhy = {
  /** The parent's run that was shown the question ended without answering it. */
  parentRunEnded: "The parent's run ended without answering.",
  /** The parent is stopped or failed, so no run of its own will read the question. */
  parentStopped: "The parent is stopped.",
} as const;

/**
 * A typed child's settlement summary when it never called `report` and its last answer holds no
 * text (it ended on the `submit_result` call): the payload line of the note carries the result.
 */
export const TYPED_RESULT_SUMMARY = "The child submitted its typed result.";

/**
 * Why a typed child's settlement failed when it ended without a result: the cap's words once its
 * attempts are spent, these otherwise.
 */
export const NO_RESULT_ERROR =
  "The child ended without submitting the typed result its brief asked for.";

/** The entry kind of a brief's answer in the parent's transcript. */
export const BRIEF_ANSWER_ENTRY = "cairn.brief-answer";

/** Request ids, in the protocol's `RequestId` alphabet, so each delivery lands once. */
export const SubagentRequestIds = {
  /** The settlement note of a child's `seq`th settlement. */
  note: (child: string, seq: number) => `subagent-note-${child}-${seq}`,
  /** The wake after that note. */
  wake: (child: string, seq: number) => `subagent-wake-${child}-${seq}`,
  /** The input carrying a child's question to its parent. */
  question: (child: string, approvalId: string) =>
    `subagent-q-${child}-${approvalId}`,
  /** A brief's answer delivered to its parent. */
  briefAnswer: (briefId: string) => `${briefId}-answer`,
  /** The brief's rendered input to the child. */
  brief: (briefId: string) => `${briefId}-input`,
  /** The one nudge a typed child gets when the run of its `seq`th settlement ends without one. */
  nudge: (child: string, seq: number) => `subagent-nudge-${child}-${seq}`,
} as const;
