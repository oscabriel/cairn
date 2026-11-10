// One run of a command judge (briefs note section 3): `argv` with no shell, in the folder of the
// conversation the running task belongs to, through that conversation's own arms, with the judge's
// timeout. It records the exit code, the output's tail and `HEAD`'s sha. A goal's judge run
// (`JudgeRun.ts`) runs a criterion's command this way, and a brief's `done_when` check
// (`subagents/DoneWhenCheck.ts`, ADR 0055) runs the brief's command this way in the child's
// conversation, so both record the same evidence.
//
// An `exec` the task's abort or the brain's close cut off rejects with its error (code `aborted`):
// nothing is recorded, and the caller decides what a rerun does.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { TaskRuntime } from "@earendil-works/pi-durable";
import { Option } from "effect";

/** How much of a command's output a run keeps, from its end. */
export const TAIL_LIMIT = 4000;

/** How long reading `HEAD` may take. */
const SHA_TIMEOUT_SEC = 10;

/** What a command judge runs: an argv list and how long it may take. */
export interface CommandToRun {
  readonly argv: ReadonlyArray<string>;
  readonly timeoutSec: number;
}

/** What one run found. */
export interface CommandRan {
  /** The exit code; null when the command timed out or could not start. */
  readonly exit: number | null;
  /** The output's last `TAIL_LIMIT` characters, both streams. */
  readonly tail: string;
  /** `HEAD`'s sha in the folder, when it is a git checkout. */
  readonly sha: Option.Option<string>;
  /** Why there is no exit code: it timed out, or could not run. */
  readonly note: Option.Option<string>;
}

/** The task operations a run needs: its conversation's agent (for the folder) and its arms. */
export type CommandRunner = Pick<
  TaskRuntime<unknown, unknown, unknown, object>,
  "agent" | "env"
>;

/** The end of `text`, cut to `limit` characters. */
export const tailOf = (text: string, limit: number): string =>
  text.length > limit ? text.slice(-limit) : text;

/** `argv` as one line for a note. */
export const argvText = (argv: ReadonlyArray<string>): string => argv.join(" ");

/**
 * Runs `command` in the folder of `runtime`'s conversation. None when the conversation has no
 * folder or no arms to run it in; rejects with the `exec` error when the run was aborted.
 */
export const runCommand = async (
  runtime: CommandRunner,
  command: CommandToRun,
  context: ChordContext
): Promise<Option.Option<CommandRan>> => {
  const agent = await runtime.agent(context);
  const env = await runtime.env(context);

  if (env === undefined || agent.cwd === undefined) {
    return Option.none();
  }

  let output = "";

  const result = await env.exec(
    command.argv,
    {
      cwd: agent.cwd,
      timeout: command.timeoutSec,
      onOutput: (text) => {
        output = tailOf(output + text, TAIL_LIMIT);
      },
    },
    context
  );

  if (!result.ok && result.error.code === "aborted") {
    // The task is being aborted or the brain is closing: nothing is recorded.
    throw result.error;
  }

  let head = "";

  const sha = await env.exec(
    ["git", "rev-parse", "HEAD"],
    {
      cwd: agent.cwd,
      timeout: SHA_TIMEOUT_SEC,
      onOutput: (text, _context, info) => {
        if (info.stream === "stdout") {
          head += text;
        }
      },
    },
    context
  );

  const headSha = Option.filter(Option.some(head.trim()), (found) =>
    sha.ok && sha.value.exitCode === 0 ? /^[0-9a-f]{7,64}$/u.test(found) : false
  );

  if (result.ok) {
    return Option.some({
      exit: result.value.exitCode,
      tail: output,
      sha: headSha,
      note: Option.none(),
    });
  }

  return Option.some({
    exit: null,
    tail: output,
    sha: headSha,
    note: Option.some(
      result.error.code === "timeout"
        ? `timed out after ${String(command.timeoutSec)} s`
        : `${argvText(command.argv)} could not run: ${result.error.message}`
    ),
  });
};
