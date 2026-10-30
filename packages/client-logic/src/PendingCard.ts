// What the request card says about the request it shows (surfaces note S3 and W1, briefs note
// section 4): its title and kind word, the detail an approval asks about, the fields of a brief in
// the order the user reads them, and the words for a budget and a judge (a workflow's launch is
// `LaunchCard.ts`).
// Pure, so the card's view only draws what this module decides and its tests judge the words. The
// card's order and its question drafts are `PendingRequests.ts` and `PendingUserInput.ts`.

import type {
  ApprovalRecord,
  Brief,
  BudgetRaisePayload,
  CriterionProposal,
  JudgeRef,
  ProgramPayload,
} from "@cairn/protocol/Policy";
import type { Budget } from "@cairn/protocol/Spend";
import { Match, Option } from "effect";

import { RequestBody } from "./PendingRequests.ts";
import { runtimeModePresentation } from "./RuntimeMode.ts";

/** One label and value line of a card's body. */
export type CardLine = readonly [label: string, value: string];

/** The kind word a card's header chip shows. */
export const requestKindWord = (body: RequestBody): string =>
  RequestBody.$match(body, {
    Approval: () => "Approval",
    Question: () => "Question",
    Brief: ({ payload }) =>
      payload.type === "workflow" ? "Workflow" : "Brief",
    Criteria: () => "Criteria",
  });

/** The card's title: what the user is asked, in a few words. */
export const requestTitle = (
  record: Pick<ApprovalRecord, "tool">,
  body: RequestBody
): string =>
  RequestBody.$match(body, {
    Approval: ({ payload }) =>
      Option.match(payload, {
        onNone: () => `Allow ${record.tool}?`,
        onSome: (found) =>
          found.type === "budget-raise"
            ? "Raise the budget?"
            : "Run this program?",
      }),
    Question: ({ questions }) =>
      questions.length === 1
        ? (questions[0]?.header ?? "Question")
        : `${questions.length} questions`,
    Brief: ({ payload }) =>
      payload.type === "workflow" ? payload.name : payload.title,
    Criteria: () => "Bind these criteria?",
  });

/** Dollars from list-price micros, to the cent: "$2.00". */
export const dollarsText = (micros: number): string =>
  `$${(micros / 1_000_000).toFixed(2)}`;

const grouped = (count: number): string =>
  count.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** A budget in words: each limit it sets, or "No limit". */
export const budgetText = (budget: Budget): string => {
  const parts: Array<string> = [];

  if (budget.maxListMicros !== null) {
    parts.push(`${dollarsText(budget.maxListMicros)} at API list price`);
  }

  if (budget.maxTokens !== null) {
    parts.push(`${grouped(budget.maxTokens)} tokens`);
  }

  if (budget.maxTurns !== null) {
    parts.push(`${grouped(budget.maxTurns)} turns`);
  }

  if (budget.maxMinutes !== null) {
    parts.push(`${grouped(budget.maxMinutes)} min`);
  }

  if (budget.planGuard !== null) {
    parts.push(
      `${Math.round(budget.planGuard.maxUsedFraction * 100)}% of the ${budget.planGuard.provider} plan window`
    );
  }

  return parts.length === 0 ? "No limit" : parts.join(", ");
};

/** Who judges a criterion, in words. */
export const judgeText = (judge: JudgeRef): string =>
  Match.value(judge).pipe(
    Match.discriminatorsExhaustive("kind")({
      command: (found) =>
        `the command \`${found.argv.join(" ")}\` exits ${found.expectExit}`,
      user: () => "you",
      model: (found) => `a model (${found.spec})`,
      verification: (found) => `the ${found.recipe} recipe`,
    })
  );

/** A criterion and its judge on one line: "Tests pass (judged by you)". */
export const criterionText = (criterion: CriterionProposal): string =>
  `${criterion.text} (judged by ${judgeText(criterion.judge)})`;

/** Who runs a brief: its role, else its model, else its parent's model. */
const whoText = (brief: Brief): string => {
  if (brief.role !== null) {
    return brief.role;
  }

  if (brief.model !== null) {
    return `${brief.model.provider}/${brief.model.modelId}`;
  }

  return "The parent's model";
};

/** Where a brief's child works. */
const whereText = (brief: Brief): string => {
  const place =
    brief.workspace === "worktree"
      ? `A worktree from ${brief.base ?? "the parent's HEAD"}`
      : "The parent's checkout";

  return brief.writes.length === 0
    ? place
    : `${place}; writes ${brief.writes.join(", ")}`;
};

/**
 * A brief's fields in reading order (the briefs note's card): Do, Why, Avoid (when it has any),
 * Judged by, Where, Who, Budget.
 */
export const briefLines = (brief: Brief): ReadonlyArray<CardLine> => {
  const lines: Array<CardLine> = [
    ["Do", brief.task],
    ["Why", brief.why],
  ];

  if (brief.avoid.length > 0) {
    lines.push(["Avoid", brief.avoid.join("; ")]);
  }

  lines.push(
    ["Judged by", brief.doneWhen.map(criterionText).join("; ")],
    ["Where", whereText(brief)],
    ["Who", `${whoText(brief)}, ${runtimeModePresentation[brief.mode].label}`],
    ["Budget", budgetText(brief.budget)]
  );

  return lines;
};

/** A budget raise's scope and its two budgets. */
export const budgetRaiseLines = (
  raise: BudgetRaisePayload
): ReadonlyArray<CardLine> => [
  ["Scope", raise.scope],
  ["Now", budgetText(raise.from)],
  ["Raise to", budgetText(raise.to)],
];

/**
 * The detail an approval asks about, as the card's mono block shows it: an Executor program
 * whole, the call's summary for a plain tool call, nothing for a budget raise (its lines say it).
 */
export const approvalDetail = (
  summary: string,
  payload: Option.Option<BudgetRaisePayload | ProgramPayload>
): Option.Option<string> =>
  Option.match(payload, {
    onNone: () => Option.some(summary),
    onSome: (found) =>
      found.type === "program" ? Option.some(found.code) : Option.none(),
  });
