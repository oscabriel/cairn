// A subagent's steps in the work panel (surfaces note S7, "per-subagent steps"): a closed set read
// from the child's own records, never from model text. A child thread exists only once the user
// said Go, so that step is always done; then it starts (in a worktree or the project's checkout),
// works, and says what it did. Pure, so the panel, the header's pill and the judges read a row
// alike.
//
// The sketch's two further steps, "Checked by an outside judge" and "Leave the merge to you", have
// no record on a child yet (judges bind to goals, ADR 0026, and integration is phase 3), so they
// are not shown rather than shown as never done.

import type { ThreadShell } from "@cairn/protocol/Shell";
import type { Entry } from "@cairn/protocol/Thread";
import { Array, DateTime, Option, Schema } from "effect";

import type { SubagentRequest } from "./SubagentRollup.ts";
import type { ThreadStateRow, ThreadStatus } from "./ThreadState.ts";
import { THREAD_LABELS, threadStatus } from "./ThreadState.ts";

/** Which step: Go, the start, the work, the answer. */
export type ChildStepKind = "go" | "started" | "working" | "reported";

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
}

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
  "parked",
  "limited",
]);

/** What holds a live child other than its work: "Approval", "Asked its parent", "Parked". */
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
      state: working === "done" ? "done" : "todo",
      meta: Option.none(),
    },
  ];
};

/** How many of the steps are done. */
export const doneStepCount = (steps: ReadonlyArray<ChildStep>): number =>
  steps.filter((step) => step.state === "done").length;
