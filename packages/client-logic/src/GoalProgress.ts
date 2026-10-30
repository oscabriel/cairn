// A goal's progress (ADR 0026, briefs note section 3), as a pure function over the goal document,
// the goal thread's subagent rows and its pending records: "2 of 4 criteria met, 1 subagent working,
// 1 brief waiting for Go". No percentage and no model-written status line: every number counts
// something an outside judge or the user decided, or something still waiting on them. The goal
// strip reads the same pieces: each criterion's state glyph and judge chip, the evidence popover's
// lines, then the children and the pending briefs. The chip names a command judge's argv whole, and
// warns when a command always passes, so a proposal judged by `true` is visible on the criteria card
// before the user binds it.

import type { ThreadId } from "@cairn/protocol/Ids";
import { GoalDocument } from "@cairn/protocol/Policy";
import type {
  ApprovalRecord,
  Criterion,
  CriterionState,
  JudgeRef,
  Verdict,
} from "@cairn/protocol/Policy";
import type { GoalTally, ThreadShell } from "@cairn/protocol/Shell";
import { Match, Option, Schema } from "effect";

import { subagentDescendants } from "./SubagentRollup.ts";

const decodeGoal = Schema.decodeUnknownOption(GoalDocument);

/**
 * The goal of a thread's `cairn.goal` document as a client holds it (plain JSON); none for a thread
 * without one, or one whose document does not decode (the strip cannot show a shape it cannot
 * read).
 */
export const goalOf = (
  document: Schema.Json | undefined
): Option.Option<GoalDocument> =>
  document === undefined ? Option.none() : decodeGoal(document);

/** "Is a goal" is having criteria, not a row kind (ADR 0026). */
export const isGoal = (goal: Option.Option<GoalDocument>): boolean =>
  Option.exists(goal, (found) => found.criteria.length > 0);

/** The criteria counted for the shell row (`ThreadShell.goal`); none on a thread that is not a goal. */
export const goalTallyOf = (
  goal: Option.Option<GoalDocument>
): Option.Option<GoalTally> =>
  Option.map(
    Option.filter(goal, (found) => found.criteria.length > 0),
    (found) => ({
      total: found.criteria.length,
      met: found.criteria.filter((criterion) => criterion.state === "met")
        .length,
      failed: found.criteria.filter((criterion) => criterion.state === "failed")
        .length,
    })
  );

/** The fields of a subagent's row progress reads. */
export type ProgressRow = Pick<
  ThreadShell,
  "id" | "lineage" | "activity" | "activeRunId" | "pendingRuntimeRequest"
>;

/** A goal's progress in counts, and the line that says it. */
export interface GoalProgress {
  readonly criteria: {
    readonly total: number;
    readonly met: number;
    readonly failed: number;
    readonly open: number;
  };
  readonly subagents: {
    readonly working: number;
    readonly asking: number;
  };
  /** Briefs waiting for Go on the goal thread. */
  readonly briefsWaiting: number;
  /** Criteria proposals waiting for the user. */
  readonly criteriaWaiting: number;
  /** "2 of 4 criteria met, 1 subagent working, 1 brief waiting for Go". */
  readonly line: string;
}

/** "1 brief", "2 briefs". */
const count = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

const isLive = (row: ProgressRow): boolean =>
  Option.isSome(row.activeRunId) ||
  row.activity === "preparing" ||
  row.activity === "running" ||
  row.activity === "waiting";

/**
 * The progress of the goal on `threadId`: its criteria by state, its subagents (every descendant
 * by lineage) working or asking, and the briefs and criteria proposals its records hold pending.
 */
export const goalProgress = (
  threadId: ThreadId,
  goal: Option.Option<GoalDocument>,
  rows: ReadonlyArray<ProgressRow>,
  records: ReadonlyArray<ApprovalRecord>
): GoalProgress => {
  const criteria = Option.match(goal, {
    onNone: (): ReadonlyArray<Criterion> => [],
    onSome: (found) => found.criteria,
  });

  const met = criteria.filter((criterion) => criterion.state === "met").length;

  const failed = criteria.filter(
    (criterion) => criterion.state === "failed"
  ).length;

  let working = 0;
  let asking = 0;

  for (const child of subagentDescendants(threadId, rows)) {
    if (Option.isSome(child.pendingRuntimeRequest)) {
      asking += 1;
    } else if (isLive(child)) {
      working += 1;
    }
  }

  const pending = records.filter((record) => record.status === "pending");

  const briefsWaiting = pending.filter(
    (record) => record.kind === "brief"
  ).length;

  const criteriaWaiting = pending.filter(
    (record) => record.kind === "criteria"
  ).length;

  const parts = [
    criteria.length === 0
      ? "No criteria yet"
      : `${String(met)} of ${String(criteria.length)} criteria met`,
  ];

  const optional: ReadonlyArray<readonly [number, string]> = [
    [failed, `${String(failed)} not met`],
    [working, `${count(working, "subagent", "subagents")} working`],
    [asking, `${count(asking, "subagent", "subagents")} asking`],
    [
      briefsWaiting,
      `${count(briefsWaiting, "brief", "briefs")} waiting for Go`,
    ],
    [
      criteriaWaiting,
      `${count(criteriaWaiting, "criteria proposal", "criteria proposals")} waiting for you`,
    ],
  ];

  for (const [n, words] of optional) {
    if (n > 0) {
      parts.push(words);
    }
  }

  return {
    criteria: {
      total: criteria.length,
      met,
      failed,
      open: criteria.length - met - failed,
    },
    subagents: { working, asking },
    briefsWaiting,
    criteriaWaiting,
    line: parts.join(", "),
  };
};

/** A criterion's state as its glyph and word, drawn as mark and word (never colour alone). */
export const criterionStateLabel = (
  state: CriterionState
): { readonly glyph: string; readonly word: string } =>
  Match.value(state).pipe(
    Match.when("met", () => ({ glyph: "✓", word: "Met" })),
    Match.when("failed", () => ({ glyph: "✗", word: "Not met" })),
    Match.when("open", () => ({ glyph: "○", word: "Open" })),
    Match.exhaustive
  );

/** Commands that exit 0 whatever the work: a judge naming one decides nothing. */
const ALWAYS_PASSES: ReadonlySet<string> = new Set([
  "true",
  ":",
  "/bin/true",
  "/usr/bin/true",
]);

/** The command a shell is told to run (`sh -c "<script>"`), when argv is one. */
const shellScript = (argv: ReadonlyArray<string>): Option.Option<string> => {
  const [program, flag, script] = argv;
  const shell = (program ?? "").split("/").at(-1) ?? "";

  return ["sh", "bash", "zsh", "dash"].includes(shell) &&
    flag === "-c" &&
    script !== undefined
    ? Option.some(script.trim())
    : Option.none();
};

/**
 * Why a judge decides nothing, if it does not: a command that always exits as expected (`true`,
 * `:`, `exit 0`, `echo`), however it is wrapped in a shell. The criteria card shows it beside the
 * chip, so the user does not bind a judge of `true` unread.
 */
export const judgeWarning = (judge: JudgeRef): Option.Option<string> => {
  if (judge.kind !== "command" || judge.expectExit !== 0) {
    return Option.none();
  }

  const script = Option.getOrElse(shellScript(judge.argv), () =>
    judge.argv.join(" ")
  );

  const first = script.split(/\s+/u)[0] ?? "";

  return ALWAYS_PASSES.has(script) ||
    /^exit\s+0$/u.test(script) ||
    first === "echo" ||
    ALWAYS_PASSES.has(first)
    ? Option.some("This command always succeeds, so it decides nothing.")
    : Option.none();
};

/** A judge's chip: what decides the criterion, a command's argv whole. */
export const judgeChip = (judge: JudgeRef): string =>
  Match.value(judge).pipe(
    Match.discriminatorsExhaustive("kind")({
      command: (found) =>
        `Command: ${found.argv.join(" ")}${found.expectExit === 0 ? "" : ` (exit ${String(found.expectExit)})`}`,
      user: () => "You",
      model: (found) => `Model: ${found.spec}`,
      verification: (found) => `Verification: ${found.recipe}`,
    })
  );

/** The evidence popover's lines for a verdict: exit code, commit, model, note, output tail. */
export const evidenceLines = (verdict: Verdict): ReadonlyArray<string> => {
  const { evidence } = verdict;

  return [
    `${verdict.ok ? "Passed" : "Did not pass"} (${verdict.runId})`,
    ...Option.toArray(
      Option.map(
        Option.fromNullOr(evidence.exit),
        (exit) => `Exit ${String(exit)}`
      )
    ),
    ...Option.toArray(
      Option.map(
        Option.fromNullOr(evidence.sha),
        (sha) => `At ${sha.slice(0, 12)}`
      )
    ),
    ...Option.toArray(
      Option.map(
        Option.fromNullOr(evidence.model),
        (model) => `Judged by ${model}`
      )
    ),
    ...Option.toArray(Option.fromNullOr(evidence.note)),
    ...Option.toArray(Option.fromNullOr(evidence.tail)),
  ];
};
