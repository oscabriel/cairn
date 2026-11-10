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
// One check at a time per child: a new check stops each earlier check of its child still live, and
// starts its command only once they ended, so two copies of the command never run at once in one
// folder. An earlier check stopped this way reads "not run", a later run having superseded it.
// `subagent_stop` stops a child's live checks the same way, and each reads "not run", the child
// having been stopped. A check is stopped through its own `cairn.check-stop` task document, which it
// watches while its command runs (pi-durable's `Tx` cannot abort a task, and a check runs in the
// child's conversation, which no reporter owns): the command is killed, and the check completes.
//
// Crashes: the task commits a mark (a task memo) right before the command starts. A rerun that
// finds the mark (the brain died while the command ran) does not run it again, since a command may
// not be safe to run twice, and the check reads "not run", saying the brain restarted. So a crash
// never loses the verdict and never runs the command twice; a crash before the mark runs it once on
// the rerun. The reporter that waits on the task is a kept wait (`CrashLimit.ts`), and the task
// itself is not: a rerun after the mark only commits.
//
// Every text a check stores fits the protocol's `DisplayText` (4,096 characters): its `note` and its
// `why` are cut, so an over-long argv or error still leaves a verdict the panel can read.

import { runtimeModePresentation } from "@cairn/client-logic/RuntimeMode";
import type { Brief, RuntimeMode } from "@cairn/protocol/Policy";
import { SubagentCheck } from "@cairn/protocol/Subagents";
import type { SettlementOutcome } from "@cairn/protocol/Subagents";
import type { DocumentState } from "@cairn/protocol/Thread";
import { withCancel } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationId,
  DocumentWatch,
  TaskOutcome,
  Tx,
  WatchCall,
} from "@earendil-works/pi-durable";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import { Option, Predicate, Schema } from "effect";

import { documentCall, errorText, handOff } from "../brain/Durable.ts";
import { callAsks, readPermissions } from "../brain/Permissions.ts";
import { plainCopy } from "../brain/SubagentDocs.ts";
import type { SubagentCrashPoint } from "../brain/SubagentFaults.ts";
import { runCommand } from "../verdicts/CommandRun.ts";
import { taskOf } from "./Delivery.ts";

/** The check task's name. */
export const CHECK_TASK = "cairn.subagent-check";

/** The memo the check commits right before its command starts. Prefixed: memos are the task's. */
const STARTED = "cairn.check-started";

/** The longest text a check stores: the protocol's `DisplayText`. */
const DISPLAY_TEXT_LIMIT = 4096;

/** `text` cut to fit `DisplayText`, marked when cut. */
const displayCut = (text: string): string =>
  text.length > DISPLAY_TEXT_LIMIT
    ? `${text.slice(0, DISPLAY_TEXT_LIMIT - 1)}…`
    : text;

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
  superseded: "a later run of the child superseded it",
  stopped: "the child was stopped",
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
  why: displayCut(why),
  at,
});

/** Why a check was told to stop, by a later check of its child or a `subagent_stop`; null until then. */
interface StopState {
  [key: string]: JsonValue;
  why: string | null;
}

/**
 * `cairn.check-stop` on a check task: why the check must stop, written by whoever stops it. Server
 * only, never on the wire; it retires with its task.
 */
const StopDoc = defineDoc<StopState>({
  kind: "cairn.check-stop",
  version: 1,
  scope: "task",
  initial: () => ({ why: null }),
  // One field: every change is stored whole.
  checkpointWhen: () => true,
});

/** How many live checks of one child a scan reads; a child has at most a few. */
const CHECK_SCAN = 64;

/**
 * The live check tasks of `child`'s conversation, oldest first, below `below` when given (table
 * reads, so the caller makes them before its first table write).
 */
const liveChecks = async (
  tx: Tx,
  child: ConversationId,
  below: Option.Option<number>
): Promise<ReadonlyArray<number>> => {
  const found: Array<number> = [];

  for (const status of ["pending", "running"] as const) {
    // oxlint-disable-next-line no-await-in-loop -- two reads, before any write
    const page = await tx.scanTasks(
      { conversationId: child, kind: CHECK_TASK, status },
      CHECK_SCAN
    );

    for (const task of page.items) {
      const id = Number(task.id);

      if (
        Option.match(below, { onNone: () => true, onSome: (at) => id < at })
      ) {
        found.push(id);
      }
    }
  }

  return found.toSorted((a, b) => a - b);
};

/** Tells each check in `ids` to stop, saying `why`, unless something told it first (writes only). */
const tellStop = async (
  tx: Tx,
  ids: ReadonlyArray<number>,
  why: string
): Promise<void> => {
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- one document per live check
    const stop = await tx.doc(StopDoc, taskOf(id));

    stop.why ??= why;
  }
};

/**
 * Stops every live check of `child` (`subagent_stop`): each kills its command if it runs, and
 * reads "not run", the child having been stopped. Table reads first, then writes; the caller's
 * commit holds nothing else.
 */
export const stopChecks = async (
  tx: Tx,
  child: ConversationId
): Promise<void> => {
  await tellStop(
    tx,
    await liveChecks(tx, child, Option.none()),
    CheckWhy.stopped
  );
};

/** A check as a checkpoint, a note's `data` and `cairn.child` hold it: the protocol's. */
export type CheckState = DocumentState<typeof SubagentCheck>;

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

/**
 * The check task: runs a brief's command once in its child's folder, after every earlier check of
 * the child ended, and completes with its check. `crashAt` is where a test or a judge brain breaks
 * it (`SubagentCrashes`); production's does nothing.
 */
export const checkTaskWith = (crashAt: (point: SubagentCrashPoint) => void) =>
  defineTask<CheckCommand, { phase: "run" }, CheckState>({
    name: CHECK_TASK,
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const command = task.input;
        const self = Number(runtime.taskId);

        // Why the check was told to stop, once it was.
        let stopped: string | null = null;

        const judge = async (): Promise<CheckState> => {
          if ((await runtime.memo<number>(STARTED, context)) !== undefined) {
            return checkNotRun(command, CheckWhy.restarted, runtime.now());
          }

          // The check's own stop document, and the earlier checks of its child it supersedes.
          let earlier: ReadonlyArray<number> = [];

          await runtime.commit(async (tx) => {
            earlier = await liveChecks(
              tx,
              runtime.conversationId,
              Option.some(self)
            );

            await tellStop(tx, earlier, CheckWhy.superseded);
            await tx.doc(StopDoc, runtime.taskId);
          }, context);

          // Their commands end before this one starts.
          for (const id of earlier) {
            // oxlint-disable-next-line no-await-in-loop -- one at a time, oldest first
            await runtime.waitForTask(taskOf(id), context);
          }

          const watch: DocumentWatch<StopState> | undefined =
            await runtime.watchDoc(StopDoc, runtime.taskId, context);

          try {
            stopped = watch?.value.why ?? null;

            if (stopped !== null) {
              return checkNotRun(command, stopped, runtime.now());
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

            // A stop kills the command: the run's own cancel, besides the task's abort.
            const cancellable = withCancel(context);

            watch?.start(
              handOff((call: WatchCall<Readonly<StopState>>) => {
                for (const value of Option.toArray(documentCall(call))) {
                  if (value !== null && value.why !== null) {
                    stopped = value.why;
                    cancellable.cancel();
                  }
                }
              })
            );

            const ran = await runCommand(runtime, command, cancellable.context);

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
                note: Option.getOrNull(Option.map(found.note, displayCut)),
                at: runtime.now(),
              }),
            });
          } finally {
            await watch?.stop();
          }
        };

        let check: CheckState;

        try {
          check = await judge();
        } catch (error) {
          if (stopped !== null && !runtime.signal.aborted) {
            // A stop killed the command: the check reads why it was stopped.
            check = checkNotRun(command, stopped, runtime.now());
          } else if (runtime.signal.aborted || isAborted(error)) {
            // An abort settles through the abort path, and a closing brain's rerun finds the mark.
            throw error;
          } else {
            check = checkNotRun(
              command,
              CheckWhy.threw(errorText(error)),
              runtime.now()
            );
          }
        }

        crashAt("check-judged");

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
  });

/** The check task's definition, as the reporter creates it. */
export type CheckTaskDefinition = ReturnType<typeof checkTaskWith>;
