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

import { briefSpec, judgeModelText, namedSpecText } from "./BriefGo.ts";
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
      model: (found) => `a model (${judgeModelText(found.spec)})`,
      verification: (found) => `the ${found.recipe} recipe`,
    })
  );

/** A criterion and its judge on one line: "Tests pass (judged by you)". */
export const criterionText = (criterion: CriterionProposal): string =>
  `${criterion.text} (judged by ${judgeText(criterion.judge)})`;

/**
 * The brief card's words for how a child's result is judged (V-9, ADR 0055). A brief's `doneWhen`
 * holds the command its parent named (`done_when`), frozen and shown before Go, which Cairn does
 * not run yet, and otherwise the parent or the workflow script accepting the result, which is no
 * outside judge. The card says so rather than "judged by you".
 */
export const BriefJudgeText = {
  doneWhenLabel: "Done when",
  judgedByLabel: "Judged by",
  /** A command the parent named for the child's result. */
  command: (argv: ReadonlyArray<string>, expectExit: number) =>
    `\`${argv.join(" ")}\` exits ${String(expectExit)} (the child is told to run it; Cairn does not run it yet)`,
  /** Who accepts the result when nothing outside the work judges it. */
  noOutsideJudge: (accepts: string) => `No outside judge; ${accepts}`,
  /** Who accepts a result when the brief names nobody. */
  parentAccepts: "the parent accepts the result",
} as const;

/** "The parent accepts the result." as the card's clause: "the parent accepts the result". */
const acceptsClause = (text: string): string => {
  const trimmed = text.trim().replace(/\.$/u, "");

  return `${trimmed.slice(0, 1).toLowerCase()}${trimmed.slice(1)}`;
};

/** A brief's "Done when" and "Judged by" lines. */
const judgedLines = (brief: Brief): ReadonlyArray<CardLine> => {
  const commands = brief.doneWhen.flatMap((criterion) =>
    criterion.judge.kind === "command"
      ? [
          BriefJudgeText.command(
            criterion.judge.argv,
            criterion.judge.expectExit
          ),
        ]
      : []
  );

  const accepts = brief.doneWhen.find(
    (criterion) => criterion.judge.kind !== "command"
  );

  const judged: CardLine = [
    BriefJudgeText.judgedByLabel,
    BriefJudgeText.noOutsideJudge(
      accepts === undefined
        ? BriefJudgeText.parentAccepts
        : acceptsClause(accepts.text)
    ),
  ];

  return commands.length === 0
    ? [judged]
    : [[BriefJudgeText.doneWhenLabel, commands.join("; ")], judged];
};

/**
 * Who runs a brief: the model it names, else its parent's model, which a role recorded before
 * ADR 0043 runs on too.
 */
const whoText = (brief: Brief): string =>
  Option.match(briefSpec(brief), {
    onNone: () => "The parent's model",
    onSome: namedSpecText,
  });

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
 * Done when (when its parent named a command), Judged by, Where, Who, Budget.
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
    ...judgedLines(brief),
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
