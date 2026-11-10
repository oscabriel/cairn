// A subagent's steps in the work panel (surfaces note S7, "per-subagent steps"): a closed set read
// from the child's own records, never from model text. A child thread exists only once the user
// said Go, so that step is always done; then it starts (in a worktree or the project's checkout),
// works, and says what it did. Pure, so the panel, the header's pill and the judges read a row
// alike.
//
// When its brief names a `done_when` command, a fifth step follows the answer: "Checked by an
// outside judge", read from the check its `cairn.child` holds (ADR 0055). Cairn runs the command
// once the child's run completes; the step is done when it was met, failed when it was not, and
// stopped when Cairn did not run it. A brief with no command has no such step, rather than one
// never done. The sketch's last step, "Leave the merge to you", has no record yet (integration is
// phase 3), so it is not shown.

import type { ThreadShell } from "@cairn/protocol/Shell";
import type { ChildCheck } from "@cairn/protocol/Subagents";
import type { Entry } from "@cairn/protocol/Thread";
import { Array, DateTime, Option, Schema } from "effect";

import type { SubagentRequest } from "./SubagentRollup.ts";
import type { ThreadStateRow, ThreadStatus } from "./ThreadState.ts";
import { THREAD_LABELS, threadStatus } from "./ThreadState.ts";

/** Which step: Go, the start, the work, the answer, and the outside judge's check. */
export type ChildStepKind =
  | "go"
  | "started"
  | "working"
  | "reported"
  | "checked";

/**
 * Where one step stands: `done`; `now` while the child is on it; `todo` before it; `failed` when the
 * run failed on it; `stopped` when the run ended on it without an answer.
 */
export type ChildStepState = "done" | "now" | "todo" | "failed" | "stopped";

/** One step: what it is, its words, its state, and a quiet word on what holds it now. */
export interface ChildStep {
  readonly kind: ChildStepKind;
  readonly title: string;
  readonly state: ChildStepState;
  readonly meta: Option.Option<string>;
}

/** The fields of a child's row its steps read. */
export type ChildStepsRow = ThreadStateRow &
  Pick<
    ThreadShell,
    "worktreePath" | "latestRunStartedAt" | "latestRunCompletedAt"
  >;

/** What the child's own records add to its row. */
export interface ChildStepsContext {
  /** What the child's descendants ask of the user (`pendingSubagentRequests`). */
  readonly request: Option.Option<SubagentRequest>;
  /** The child called `report` (its `cairn.child` document holds one). */
  readonly hasReport: boolean;
  /**
   * Whether the child's last run ended on an answer, read from its transcript
   * (`lastRunAnsweredIn`); none while the transcript is not at hand.
   */
  readonly answered: Option.Option<boolean>;
  /** The brief's `done_when` check (its `cairn.child` holds it); none when it names no command. */
  readonly check: Option.Option<ChildCheck>;
}

/** The checked step's words, by what the outside judge found. */
export const CheckStepText = {
  checked: "Checked by an outside judge",
  notMet: "Not met by an outside judge",
  notRun: "Not checked by an outside judge",
} as const;

/** The checked step, once the child said what it did (`reported`); to do until then. */
const checkedStep = (
  check: ChildCheck,
  reported: ChildStepState
): ChildStep => {
  const step = {
    kind: "checked",
    title: CheckStepText.checked,
    state: "todo",
    meta: Option.none(),
  } satisfies ChildStep;

  if (reported !== "done") {
    return step;
  }

  if (check.verdict === "running") {
    return { ...step, state: "now" };
  }

  if (check.verdict === "met") {
    return { ...step, state: "done" };
  }

  if (check.verdict === "notMet") {
    return {
      ...step,
      title: CheckStepText.notMet,
      state: "failed",
      meta: Option.some(
        check.note ??
          (check.exit === null ? "No exit code" : `Exit ${String(check.exit)}`)
      ),
    };
  }

  if (check.verdict === "notRun") {
    return { ...step, title: CheckStepText.notRun, state: "stopped" };
  }

  // `pending`: nothing has been checked yet.
  return step;
};

/** The fields of a committed model message the answer reads. */
const ModelMessage = Schema.Struct({
  role: Schema.String,
  stopReason: Schema.optionalKey(Schema.String),
});

const decodeModelMessage = Schema.decodeUnknownOption(ModelMessage);

/** Stop reasons of a model message that ends its run with nothing left to call. */
const ANSWER_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length"]);

/**
 * Whether the transcript's last run ended on an answer: its last user or assistant message is an
 * assistant one that stopped with nothing left to call. A message that called a tool (`toolUse`),
 * was cut off (`aborted`) or failed is not one, nor is an input with no reply after it. None when
 * the entries hold neither.
 */
export const lastRunAnsweredIn = (
  entries: ReadonlyArray<Entry>
): Option.Option<boolean> =>
  Array.findLast(entries, (entry) =>
    Option.flatMap(
      Option.flatMap(Option.fromUndefinedOr(entry.model), Array.head),
      decodeModelMessage
    ).pipe(
      Option.filter(
        (message) => message.role === "user" || message.role === "assistant"
      ),
      Option.map(
        (message) =>
          message.role === "assistant" &&
          ANSWER_STOP_REASONS.has(message.stopReason ?? "")
      )
    )
  );

/**
 * True when the row says its latest run completed: a completion no older than its start. A stop
 * also ends a run, so this is only the fallback while the transcript is not at hand.
 */
const completedLatestRun = (row: ChildStepsRow): boolean =>
  Option.exists(row.latestRunCompletedAt, (completed) =>
    Option.match(row.latestRunStartedAt, {
      onNone: () => true,
      onSome: (started) => !DateTime.isLessThan(completed, started),
    })
  );

/** Statuses in which the child still has its work in hand. */
const LIVE: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>([
  "approval",
  "go",
  "input",
  "asking-parent",
  "working",
  "waiting",
  "limited",
]);

/** What holds a live child other than its work: "Approval", "Asked its parent", "Limited". */
const holdWordOf = (status: ThreadStatus): Option.Option<string> =>
  status === "ready" || status === "working"
    ? Option.none()
    : Option.some(THREAD_LABELS[status].word);

/** The child's steps in order, from its row and its records. */
export const childStepsOf = (
  row: ChildStepsRow,
  context: ChildStepsContext
): ReadonlyArray<ChildStep> => {
  const status = threadStatus(row, context.request);
  const isLive = LIVE.has(status);

  const hasStarted =
    Option.isSome(row.latestRunStartedAt) ||
    (isLive && row.activity !== "preparing" && row.activity !== "idle");

  const hasAnswered =
    context.hasReport ||
    Option.getOrElse(context.answered, () => completedLatestRun(row));

  let working: ChildStepState = "todo";

  if (status === "failed") {
    working = "failed";
  } else if (hasStarted && isLive) {
    working = "now";
  } else if (hasStarted) {
    working = hasAnswered ? "done" : "stopped";
  }

  let started: ChildStepState = "todo";

  if (hasStarted) {
    started = "done";
  } else if (isLive) {
    started = "now";
  }

  const reported: ChildStepState = working === "done" ? "done" : "todo";

  return [
    {
      kind: "go",
      title: "You said go",
      state: "done",
      meta: Option.none(),
    },
    {
      kind: "started",
      title: Option.isSome(row.worktreePath)
        ? "Started, in a worktree"
        : "Started, in the project's checkout",
      state: started,
      meta: Option.none(),
    },
    {
      kind: "working",
      title: "Working on it",
      state: working,
      meta: working === "now" ? holdWordOf(status) : Option.none(),
    },
    {
      kind: "reported",
      title: "Said what it did",
      state: reported,
      meta: Option.none(),
    },
    ...Option.toArray(
      Option.map(context.check, (check) => checkedStep(check, reported))
    ),
  ];
};

/** How many of the steps are done. */
export const doneStepCount = (steps: ReadonlyArray<ChildStep>): number =>
  steps.filter((step) => step.state === "done").length;
