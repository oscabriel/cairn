// A brief's `done_when` check (V-9, ADR 0055): when a child's run completes, Cairn runs the
// command its parent named, as an outside judge, before the result's note reaches the parent.
//
// The reporter's commit that settles the run creates one check task (`cairn.subagent-check`) in the
// child's conversation, so the command runs through the child's own arms in the child's folder (its
// worktree, or its parent's checkout for a shared child), and the reporter waits on it in its
// `check` phase. The task runs the command once, as a goal's command judge does
// (`verdicts/CommandRun.ts`: the exit code, the output's tail, `HEAD`), within the brief's timeout;
// a timeout is not met, its note saying it timed out. It does not run the command when the child's
// mode asks before a command (Supervised or Auto-accept edits, unless the thread allowed `bash`),
// since the child itself could not have run it unasked; the check then reads "not run" and says
// why.
//
// Crashes: the task commits a mark (a task memo) right before the command starts. A rerun that
// finds the mark (the brain died while the command ran) does not run it again, since a command may
// not be safe to run twice, and the check reads "not run", saying the brain restarted. So a crash
// never loses the verdict and never runs the command twice; a crash before the mark runs it once on
// the rerun. The reporter that waits on the task is a kept wait (`CrashLimit.ts`), and the task
// itself is not: a rerun after the mark only commits.

import { runtimeModePresentation } from "@cairn/client-logic/RuntimeMode";
import type { Brief, RuntimeMode } from "@cairn/protocol/Policy";
import { SubagentCheck } from "@cairn/protocol/Subagents";
import type { SettlementOutcome } from "@cairn/protocol/Subagents";
import type { DocumentState } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord/json";
import type { TaskOutcome } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Option, Predicate, Schema } from "effect";

import { errorText } from "../brain/Durable.ts";
import { callAsks, readPermissions } from "../brain/Permissions.ts";
import { plainCopy } from "../brain/SubagentDocs.ts";
import { runCommand } from "../verdicts/CommandRun.ts";

/** The check task's name. */
export const CHECK_TASK = "cairn.subagent-check";

/** The memo the check commits right before its command starts. Prefixed: memos are the task's. */
const STARTED = "cairn.check-started";

/** A check as a checkpoint, a note's `data` and `cairn.child` hold it: the protocol's. */
export type CheckState = DocumentState<typeof SubagentCheck>;

/** A brief's `done_when` command, as the check runs it. */
export interface CheckCommand {
  [key: string]: JsonValue;
  argv: Array<string>;
  expectExit: number;
  timeoutSec: number;
}

/** The command a brief's `doneWhen` names, if it names one (ADR 0055: at most one). */
export const doneWhenCommandOf = (brief: Brief): Option.Option<CheckCommand> =>
  Option.fromUndefinedOr(
    brief.doneWhen.flatMap((criterion) =>
      criterion.judge.kind === "command"
        ? [
            {
              argv: [...criterion.judge.argv],
              expectExit: criterion.judge.expectExit,
              timeoutSec: criterion.judge.timeoutSec,
            },
          ]
        : []
    )[0]
  );

/** Why a check was not run, in the words the parent's note and the work panel read. */
export const CheckWhy = {
  outcome: (outcome: Exclude<SettlementOutcome, "completed">) =>
    `the child's run ${outcome === "stopped" ? "was stopped" : "failed"}, so there was no finished work to check`,
  mode: (mode: RuntimeMode) =>
    `the child runs in ${runtimeModePresentation[mode].label} mode, where a command asks first, so Cairn did not run it unasked`,
  noFolder: "the child has no folder to run it in",
  restarted:
    "the brain restarted while the command ran, and Cairn never runs it twice; run it to check",
  threw: (why: string) => `the check failed before it finished (${why})`,
  aborted: "the check was stopped before it finished",
} as const;

/** A check that was not run, and why. */
export const checkNotRun = (
  command: CheckCommand,
  why: string,
  at: number
): CheckState => ({
  verdict: "notRun",
  argv: [...command.argv],
  expectExit: command.expectExit,
  why,
  at,
});

const decodeCheck = Schema.decodeUnknownOption(SubagentCheck);

/** The check a settled check task left: its result, or why there is none. */
export const checkOfOutcome = (
  outcome: TaskOutcome<unknown>,
  command: CheckCommand,
  at: number
): CheckState => {
  if (outcome.status === "completed") {
    return Option.match(decodeCheck(outcome.result), {
      onNone: () =>
        checkNotRun(command, CheckWhy.threw("it left no verdict"), at),
      onSome: (check) => plainCopy(check),
    });
  }

  if (outcome.status === "aborted") {
    return checkNotRun(command, CheckWhy.aborted, at);
  }

  return checkNotRun(
    command,
    CheckWhy.threw(
      outcome.status === "orphaned" ? outcome.reason : outcome.error.message
    ),
    at
  );
};

/** Whether a rejection is an aborted `exec`: the task is being aborted, or the brain is closing. */
const isAborted = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "code") && cause.code === "aborted";

/** The check task: runs a brief's command once in its child's folder, and completes with its check. */
export const CheckTask = defineTask<CheckCommand, { phase: "run" }, CheckState>(
  {
    name: CHECK_TASK,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const command = task.input;

        const judge = async (): Promise<CheckState> => {
          if ((await runtime.memo<number>(STARTED, context)) !== undefined) {
            return checkNotRun(command, CheckWhy.restarted, runtime.now());
          }

          const permissions = await readPermissions(runtime, context);

          if (callAsks(permissions, "bash", "command")) {
            return checkNotRun(
              command,
              CheckWhy.mode(permissions.mode),
              runtime.now()
            );
          }

          await runtime.memo(STARTED, runtime.now(), context);

          const ran = await runCommand(runtime, command, context);

          return Option.match(ran, {
            onNone: () =>
              checkNotRun(command, CheckWhy.noFolder, runtime.now()),
            onSome: (found): CheckState => ({
              verdict: found.exit === command.expectExit ? "met" : "notMet",
              argv: [...command.argv],
              expectExit: command.expectExit,
              exit: found.exit,
              tail: found.tail === "" ? null : found.tail,
              sha: Option.getOrNull(found.sha),
              note: Option.getOrNull(found.note),
              at: runtime.now(),
            }),
          });
        };

        let check: CheckState;

        try {
          check = await judge();
        } catch (error) {
          // An abort settles through the abort path, and a closing brain's rerun finds the mark.
          if (runtime.signal.aborted || isAborted(error)) {
            throw error;
          }

          check = checkNotRun(
            command,
            CheckWhy.threw(errorText(error)),
            runtime.now()
          );
        }

        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: check },
          }),
          context
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  }
);
