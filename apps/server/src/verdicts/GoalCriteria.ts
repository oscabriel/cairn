// The rules of `goal_criteria`'s arguments and the goal's text for the model (briefs note section 3):
// flat parameters, one boundary parse into the protocol's `CriterionProposal`, and refusals that
// name the field. A judge is `command`, `user` or `model`; `verification` waits for phase 4. A
// command judge's argv runs without a shell, as the user will read it on the criteria card.

import { CriterionProposal } from "@cairn/protocol/Policy";
import type { JudgeRef } from "@cairn/protocol/Policy";
import { Match, Option, Result, Schema } from "effect";

import type { GoalState, JudgeRefState } from "./GoalDocs.ts";

/** The `goal_criteria` tool's name. */
export const GOAL_CRITERIA_TOOL = "goal_criteria";

/** The `goal_check` tool's name. */
export const GOAL_CHECK_TOOL = "goal_check";

/** The most criteria one proposal carries. */
export const MAX_PROPOSED = 16;

/** The longest criterion text. */
export const MAX_CRITERION_TEXT = 1000;

/** The longest rubric. */
export const MAX_RUBRIC = 2000;

/** A command judge's timeout when the proposal gives none. */
export const DEFAULT_TIMEOUT_SEC = 600;

/** How long a criteria proposal waits for the user: as long as a brief (ADR 0030). */
export const CRITERIA_TTL_MILLIS = 7 * 24 * 60 * 60 * 1000;

/** One proposed criterion as the model passes it. */
export interface CriterionArgs {
  readonly text: string;
  readonly judge: string;
  readonly argv?: ReadonlyArray<string> | undefined;
  readonly expect_exit?: number | undefined;
  readonly timeout_sec?: number | undefined;
  readonly model?: string | undefined;
  readonly rubric?: string | undefined;
}

const decodeProposal = Schema.decodeUnknownResult(CriterionProposal);

/** The judge one proposed criterion names, or the refusal naming its field. */
const judgeOf = (
  args: CriterionArgs,
  at: string
): Result.Result<JudgeRef | { readonly kind: "unchecked" }, string> => {
  if (args.judge === "command") {
    if (args.argv === undefined || args.argv.length === 0) {
      return Result.fail(
        `${at}.argv: a command judge needs the command as an argv list, for example ["npm", "test"]. It runs without a shell in the thread's folder.`
      );
    }

    return Result.succeed({
      kind: "command",
      argv: [args.argv[0] ?? "", ...args.argv.slice(1)],
      expectExit: args.expect_exit ?? 0,
      timeoutSec: args.timeout_sec ?? DEFAULT_TIMEOUT_SEC,
    });
  }

  if (args.judge === "user") {
    return Result.succeed({ kind: "user" });
  }

  if (args.judge === "model") {
    if (args.model === undefined || args.model.trim() === "") {
      return Result.fail(
        `${at}.model: a model judge names a role (such as @judge) or provider/modelId of another family than this thread's model.`
      );
    }

    if (args.rubric === undefined || args.rubric.trim() === "") {
      return Result.fail(
        `${at}.rubric: a model judge needs a rubric saying what evidence meets the criterion.`
      );
    }

    return Result.succeed({ kind: "unchecked" });
  }

  return Result.fail(
    `${at}.judge: "${args.judge}" is not a judge. Use command, user or model; verification recipes arrive in phase 4.`
  );
};

/**
 * The proposals `goal_criteria` asks the user to bind, or the refusal naming the field. The model
 * judge's spec is decoded here and resolved by the tool (it needs the role table).
 */
export const proposalsOf = (
  criteria: ReadonlyArray<CriterionArgs>
): Result.Result<ReadonlyArray<CriterionProposal>, string> => {
  if (criteria.length === 0 || criteria.length > MAX_PROPOSED) {
    return Result.fail(
      `criteria: propose between 1 and ${String(MAX_PROPOSED)} criteria at a time.`
    );
  }

  const proposals: Array<CriterionProposal> = [];

  for (const [index, args] of criteria.entries()) {
    const at = `criteria[${String(index)}]`;
    const text = args.text.trim();

    if (text === "" || text.length > MAX_CRITERION_TEXT) {
      return Result.fail(
        `${at}.text: say the condition in 1 to ${String(MAX_CRITERION_TEXT)} characters.`
      );
    }

    const judge = judgeOf(args, at);

    if (Result.isFailure(judge)) {
      return Result.fail(judge.failure);
    }

    const raw =
      judge.success.kind === "unchecked"
        ? {
            text,
            judge: {
              kind: "model",
              spec: (args.model ?? "").trim(),
              rubric: (args.rubric ?? "").trim().slice(0, MAX_RUBRIC),
            },
          }
        : { text, judge: judge.success };

    const decoded = decodeProposal(raw);

    if (Result.isFailure(decoded)) {
      return Result.fail(
        `${at}: ${decoded.failure.message}. A model is a role such as @judge or provider/modelId; a timeout is 1 to 3600 seconds.`
      );
    }

    proposals.push(decoded.success);
  }

  return Result.succeed(proposals);
};

/** A judge as one short line: what the card's chip and the model's listing say. */
export const judgeLine = (judge: JudgeRef | JudgeRefState): string =>
  Match.value<JudgeRef | JudgeRefState>(judge).pipe(
    Match.discriminatorsExhaustive("kind")({
      command: (found) =>
        `command \`${found.argv.join(" ")}\`${found.expectExit === 0 ? "" : `, exit ${String(found.expectExit)}`}`,
      user: () => "the user",
      model: (found) => `model ${found.spec}`,
      verification: (found) => `verification ${found.recipe}`,
    })
  );

/** The one-line summary of a criteria proposal, for its record. */
export const criteriaSummary = (
  proposals: ReadonlyArray<CriterionProposal>
): string => {
  const first = proposals[0]?.text ?? "";
  const more = proposals.length - 1;

  return `Criteria: ${first}${more > 0 ? ` (and ${String(more)} more)` : ""}`;
};

/** The goal as `goal_check` lists it to the model. */
export const goalListing = (goal: Readonly<GoalState>): string => {
  if (goal.criteria.length === 0) {
    return "This thread has no criteria yet. Propose them with goal_criteria; the user approves them before they bind.";
  }

  const lines = goal.criteria.map((criterion) => {
    const verdict = Option.match(Option.fromNullOr(criterion.verdict), {
      onNone: () => "",
      onSome: (found) =>
        ` (last verdict ${found.runId}: ${found.ok ? "ok" : "not ok"})`,
    });

    return `- ${criterion.id} [${criterion.state}] ${criterion.text}; judged by ${judgeLine(criterion.judge)}${verdict}`;
  });

  const met = goal.criteria.filter(
    (criterion) => criterion.state === "met"
  ).length;

  return [
    `Goal: ${goal.objective === "" ? "(no objective stated)" : goal.objective}`,
    `${String(met)} of ${String(goal.criteria.length)} criteria met.`,
    ...lines,
    "Call goal_check with a criterion's id to queue its judge; its verdict arrives as a note.",
  ].join("\n");
};
