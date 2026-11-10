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

/**
 * The first input a child receives: its brief's title and task, then why, and the command its
 * parent named for when the work is done (ADR 0055), which the child is asked to run.
 */
export const renderBrief = (brief: Brief): string => {
  const lines = [brief.title, "", brief.task];

  if (brief.why.trim() !== "") {
    lines.push("", `Why: ${brief.why}`);
  }

  const commands = brief.doneWhen.flatMap((criterion) =>
    criterion.judge.kind === "command"
      ? [
          `\`${criterion.judge.argv.join(" ")}\` exits ${String(criterion.judge.expectExit)}`,
        ]
      : []
  );

  if (commands.length > 0) {
    lines.push(
      "",
      `Done when: ${commands.join("; ")}. Run it in your workspace before you report, and say what it printed.`
    );
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
  | { readonly kind: "expired" }
  /** Accepted, but the child's workspace could not be made (`why`), so nothing started. */
  | { readonly kind: "noWorkspace"; readonly why: string }
  /** Accepted, but the model the brief names was not ready at Go (`why`), so nothing started. */
  | { readonly kind: "noModel"; readonly why: string }
  /** Accepted, but the model catalog could not be read at Go however long it was retried. */
  | { readonly kind: "modelsUnread"; readonly why: string }
  /** Accepted, but the brain already had its most children live at Go (`live`), so nothing started. */
  | { readonly kind: "noRoom"; readonly live: number }
  /** Accepted, but a budget covering the parent was at its line at Go (`why`), so nothing started. */
  | { readonly kind: "noBudget"; readonly why: string }
  /** Accepted, but starting the child failed (`why`, the start task's throw), so nothing started. */
  | { readonly kind: "startFailed"; readonly why: string };

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
      noWorkspace: (found) =>
        `The user approved the brief "${title}", but its workspace could not be made, so nothing started: ${found.why}`,
      noModel: (found) =>
        `The user approved the brief "${title}", but the model it names is not ready, so nothing started: ${found.why}`,
      modelsUnread: (found) =>
        `The user approved the brief "${title}", but the model it names could not be checked, so nothing started: ${found.why}`,
      noBudget: (found) =>
        `The user approved the brief "${title}", but a budget is reached, so nothing started: ${found.why}`,
      noRoom: (found) =>
        `The user approved the brief "${title}", but the brain already has ${found.live} subagents working or waiting for Go across all threads, the most it may have, so nothing started. Spawn it again once one reports.`,
      startFailed: (found) =>
        `The user approved the brief "${title}", but starting its subagent failed, so nothing started: ${found.why} Spawn it again to retry.`,
    })
  );

/**
 * The error of a settlement a reporter recorded when one of its phases threw (`why`): the child's
 * result for the input was not read, and the parent can send the child its work again.
 */
export const reporterFailedText = (why: string): string =>
  `Cairn could not follow this input to its end, so the child's result for it was not read: ${why} Ask the child with subagent_send to report again.`;

/**
 * Why a child's relayed question was cancelled when the reporter following it threw (O-3): the
 * child's answer that asked it is reported as the run's result instead.
 */
export const questionFailedText = (why: string): string =>
  `Cairn could not follow this question to its end, so the child's answer is reported as its result: ${why}`;

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
  /** `subagent_spawn` at the brain's cap of live and proposed children, across every thread. */
  brainCapReached: (live: number) =>
    `The brain already has ${live} subagents working or waiting for Go across all threads, the most it may have. Wait for one to report, then spawn again.`,
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
  /** `subagent_reply` whose escalate reason is longer than an escalation shows. */
  escalateTooLong: (max: number) =>
    `subagent_reply's escalate reason may be at most ${max} characters. Call it again with a shorter one.`,
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
  /**
   * `report` accepted from a typed child. A report from code mode is a nested call, whose
   * `terminate` pi-durable drops, so the run goes on and this text sends the child to
   * `submit_result`, which code mode cannot reach. Worded the same whatever the result's state, so
   * a report beside `submit_result` in one step reads alike however the two calls interleave.
   */
  reportedTyped:
    "Reported. Your brief also asks for a typed result: if submit_result has not accepted one, call it now with your result and its divergence from the brief. It is a direct tool call, not one of code mode's tools.",
  /** `ask_parent` with more options than a question may offer. */
  tooManyOptions: (max: number) =>
    `ask_parent takes at most ${max} options. Call it again with fewer, or none for a free answer.`,
  /** `ask_parent` with a question or an option longer than a card shows. */
  tooLong: (max: number) =>
    `ask_parent's question and each option may be at most ${max} characters. Call it again with shorter ones.`,
  /** `subagent_spawn` missing its description or its brief. */
  spawnNeedsBrief:
    "subagent_spawn needs a description (5 to 10 words) and a brief. Call it again with both.",
  /** `subagent_spawn` whose `model` is not ready now (`why`: the reason). */
  modelRefused: (why: string) =>
    `subagent_spawn's model cannot take a child now. ${why} Tell the user if they asked for that model; otherwise leave model out to run the child on your own model.`,
  /** `subagent_spawn` whose model could not be checked: the catalog was unreadable. */
  modelUnchecked: (why: string) =>
    `subagent_spawn could not check its model just now: ${why} Call it again in a moment, or leave model out.`,
  /** `subagent_spawn` whose `model` is not `provider/modelId[:level]`. */
  modelInvalid: (model: string) =>
    `subagent_spawn's model "${model}" is not provider/modelId[:level]. Call models to see what a child can run on, then call it again with one, or leave model out to run the child on your own model.`,
  /** `subagent_spawn` whose `model` is a role name: roles were removed (ADR 0043). */
  roleRemoved: (role: string) =>
    `subagent_spawn's model "${role}" is a role, and roles were removed. Pass model as provider/modelId[:level] (call models to see what a child can run on), or leave it out to run the child on your own model and level.`,
  /** `subagent_spawn` whose `done_when` is not a command as an argv list. */
  doneWhenInvalid:
    'subagent_spawn\'s done_when must be a command as an argv list of non-empty strings, run without a shell, for example ["npm", "test"]. Pass one, or leave it out when you will judge the result yourself.',
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
  /** The user archived the parent thread. */
  parentArchived: "The parent thread was archived.",
  /** The user deleted the parent thread. */
  parentDeleted: "The parent thread was deleted.",
  /** The parent's model saw the question and did not settle it within the window. */
  parentSlow: (windowMillis: number) =>
    windowMillis >= 60_000
      ? `The parent did not answer within ${Math.round(windowMillis / 60_000)} minutes.`
      : `The parent did not answer within ${Math.round(windowMillis / 1000)} seconds.`,
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

/** The entry kind of a brief's answer in the parent's transcript (the protocol's). */
export { BRIEF_ANSWER_ENTRY } from "@cairn/protocol/Subagents";

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
  /**
   * The answer a child gets when the run of its `seq`th settlement ended on a question in its
   * final answer (ADR 0027): the run goes on with it, as with a nudge.
   */
  answer: (child: string, seq: number) => `subagent-answer-${child}-${seq}`,
  /** The question record a child's final answer became, for that run's mark `seq`. */
  answerQuestion: (child: string, seq: number) =>
    `subagent-ask-${child}-${seq}`,
} as const;
