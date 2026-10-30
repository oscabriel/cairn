// A judge run (briefs note section 3): the durable task `goal_check` queues for one criterion
// (`cairn.judge-run`, conversation-owned, background). It judges, then records in one completing
// commit: the verdict (through the verdict writer), the run's place in `cairn.judge-runs`, and a
// note telling the thread's model what the judge said. The model reads that note on its next turn;
// the tool that asked returned "queued" and never a result.
//
// Judges:
// - `command` runs `argv` (no shell) in the goal thread's folder, through the thread's own arms,
//   with the judge's timeout, and records the exit code, the output's tail and `HEAD`'s sha; met
//   when the exit code is the one expected.
// - `model` resolves its spec now (ADR 0035), refuses a model of the thread model's family
//   (`ModelJudge.ts`), and asks it once over the transcript's end; it records the model and reply.
// - `user` and `verification` never run here: a user's mark is the user's (`Goals.ts`), and a
//   verification recipe waits for phase 4.
//
// Replay: the run is safe to rerun (a command judge reruns its command, a model judge asks again),
// and nothing is written before the completing commit, so a `kill -9` anywhere before it reruns the
// judge and still records one verdict; a kill after it finds the task terminal. The run's id is
// `judge-<task id>`, stable across reruns, and the writer records a run once (`duplicate`). A run
// whose criterion changed since it was queued records nothing (`stale`) and says so.

import { ThreadId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  NextTaskState,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Data, Match, Option, Result, Schema } from "effect";

import { ThreadMeta } from "../brain/CairnDocs.ts";
import { applyNote, noteEntry, readNote } from "../brain/NoteAdmission.ts";
import { GoalDoc, JudgeRunsDoc } from "./GoalDocs.ts";
import type {
  CriterionStateDoc,
  GoalState,
  JudgeRefState,
  VerdictState,
} from "./GoalDocs.ts";
import {
  judgeModelRefusal,
  MODEL_JUDGE_SYSTEM,
  modelJudgePrompt,
  modelText,
  parseModelVerdict,
} from "./ModelJudge.ts";
import { recordVerdict } from "./Verdicts.ts";
import type { VerdictOutcome } from "./Verdicts.ts";

/** The judge-run task's name. */
export const JUDGE_RUN_TASK = "cairn.judge-run";

/** The entry kind of the note a run leaves for the thread's model. */
export const VERDICT_NOTE = "cairn.verdict";

/** How much of a command's output a verdict keeps, from its end. */
export const TAIL_LIMIT = 4000;

/** How much of that tail the note quotes to the model. */
const NOTE_TAIL_LIMIT = 1500;

/** How long reading `HEAD` may take. */
const SHA_TIMEOUT_SEC = 10;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** How much of one message the model judge reads. */
const MESSAGE_LIMIT = 2000;

/** The run id of the task `taskId`. */
export const judgeRunId = (taskId: number): string => `judge-${String(taskId)}`;

/** The request id of a run's note, so a rerun lands it once. */
export const verdictNoteId = (taskId: number): string =>
  `verdict-${String(taskId)}`;

/** One judge run's input, written by `goal_check`'s commit. */
export interface JudgeRunInput {
  [key: string]: JsonValue;
  criterionId: string;
  /** The criterion's `changedAt` when queued: a later change makes the run stale. */
  changedAt: number;
  /** The `goal_check` tool task that queued it, its key in `cairn.judge-runs`. */
  toolTaskId: number;
}

/** The run's one checkpoint. */
export interface JudgeRunState {
  [key: string]: JsonValue;
  phase: "judge";
}

/** The model a judge resolves to, or why it does not. */
export type JudgeModelResolver = (
  spec: string
) => Promise<Result.Result<ModelRef, string>>;

/** One request to a judge model: its reply's text, or why there is none. */
export type JudgeModelCall = (
  model: ModelRef,
  system: string,
  prompt: string,
  call: { readonly runId: string; readonly threadId: Option.Option<ThreadId> }
) => Promise<Result.Result<string, string>>;

/** What the model judge needs from outside pi-durable (S43). */
export interface JudgeModels {
  readonly resolve: JudgeModelResolver;
  readonly ask: JudgeModelCall;
}

/**
 * Where the kill judge kills the brain: `queued` after `goal_check`'s commit created the run and
 * before the tool's result; `judged` after judging, before the run's completing commit.
 */
export type JudgeFaultPoint = "queued" | "judged";

/**
 * Planted faults; production has none. `split` is the kill judge's broken control: the verdict is
 * recorded in a commit of its own under a run id minted per attempt, before the run ends in a
 * second commit, so a kill between them records a second verdict on the rerun.
 */
export interface JudgeFaults {
  at(point: JudgeFaultPoint): void;
  readonly control: "none" | "split";
}

/** No faults. */
export const NO_JUDGE_FAULTS: JudgeFaults = {
  at: () => {
    // Production plants nothing.
  },
  control: "none",
};

/** What judging found: a verdict to record, or a reason there is none. */
type Judged = Data.TaggedEnum<{
  Verdict: { readonly verdict: VerdictState };
  None: { readonly why: string };
}>;

const Judged = Data.taggedEnum<Judged>();

/** The verdict a judging found, if it found one. */
const verdictOf = (judged: Judged): Option.Option<VerdictState> =>
  Judged.$match(judged, {
    Verdict: ({ verdict }) => Option.some(verdict),
    None: () => Option.none(),
  });

const completed = <S>(): NextTaskState<S, null> => ({
  status: "terminal",
  outcome: { status: "completed", result: null },
});

/** The end of `text`, cut to `limit` characters. */
const tailOf = (text: string, limit: number): string =>
  text.length > limit ? text.slice(-limit) : text;

/** `argv` as one line for a note. */
const argvText = (argv: ReadonlyArray<string>): string => argv.join(" ");

/** A message as one block of transcript text. */
const messageText = (message: Message): string => {
  if (message.role === "user") {
    const text = Array.isArray(message.content)
      ? message.content
          .map((part) => (part.type === "text" ? part.text : "[image]"))
          .join("")
      : message.content;

    return `user: ${text.slice(0, MESSAGE_LIMIT)}`;
  }

  if (message.role === "assistant") {
    const parts = message.content.map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      return part.type === "toolCall"
        ? `[tool ${part.name} ${JSON.stringify(part.arguments).slice(0, 300)}]`
        : "";
    });

    return `assistant: ${parts.join("").slice(0, MESSAGE_LIMIT)}`;
  }

  if (message.role !== "toolResult") {
    return "";
  }

  const output = message.content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("");

  return `tool result (${message.toolName}): ${tailOf(output, MESSAGE_LIMIT)}`;
};

/** The verdict a command's run made. */
const commandVerdict = (
  judge: Extract<JudgeRefState, { kind: "command" }>,
  runId: string,
  at: number,
  exit: number | null,
  tail: string,
  sha: Option.Option<string>,
  note: Option.Option<string>
): VerdictState => ({
  at,
  ok: exit === judge.expectExit,
  judge,
  evidence: {
    exit,
    tail: tail === "" ? null : tail,
    sha: Option.getOrNull(sha),
    model: null,
    note: Option.getOrNull(note),
  },
  runId,
});

/** The note's words for what a run did. */
const noteText = (
  runId: string,
  criterion: Option.Option<CriterionStateDoc>,
  judged: Judged,
  outcome: VerdictOutcome | "none"
): string => {
  const name = Option.match(criterion, {
    onNone: () => "the criterion",
    onSome: (found) => `${found.id} ("${found.text}")`,
  });

  if (Judged.$is("None")(judged)) {
    return `Judge run ${runId} recorded no verdict for ${name}: ${judged.why}`;
  }

  if (outcome === "stale") {
    return `Judge run ${runId} recorded nothing: ${name} changed or was removed after the check was queued. Call goal_check again for the criterion as it stands.`;
  }

  const { verdict } = judged;
  const { evidence } = verdict;
  const said = verdict.ok ? "is met" : "is not met";

  const detail =
    verdict.judge.kind === "command"
      ? [
          `exit ${evidence.exit === null ? "none" : String(evidence.exit)}, expected ${String(verdict.judge.expectExit)}`,
          ...Option.toArray(Option.fromNullOr(evidence.note)),
          ...Option.toArray(
            Option.map(
              Option.fromNullOr(evidence.tail),
              (tail) => `output ends:\n${tailOf(tail, NOTE_TAIL_LIMIT)}`
            )
          ),
        ].join("; ")
      : `${evidence.model ?? "the model"} replied: ${evidence.note ?? ""}`;

  return `Judge run ${runId}: ${name} ${said} (${detail}).`;
};

/** Reads a goal's criterion and checks it is the one a run was queued for. */
const criterionOf = (
  goal: Readonly<GoalState> | undefined,
  input: JudgeRunInput
): Option.Option<CriterionStateDoc> =>
  Option.fromUndefinedOr(
    goal?.criteria.find(
      (criterion) =>
        criterion.id === input.criterionId &&
        criterion.changedAt === input.changedAt
    )
  );

/**
 * The judge-run task over `models` and `faults`. Defined per extension so its model calls run
 * through the layer's context; pi-durable runs a task by its registered name.
 */
export const judgeRunTask = (models: JudgeModels, faults: JudgeFaults) => {
  type Runtime = TaskRuntime<JudgeRunInput, JudgeRunState, null, object>;

  const runCommand = async (
    runtime: Runtime,
    judge: Extract<JudgeRefState, { kind: "command" }>,
    runId: string,
    context: ChordContext
  ): Promise<Judged> => {
    const agent = await runtime.agent(context);
    const env = await runtime.env(context);

    if (env === undefined || agent.cwd === undefined) {
      return Judged.None({
        why: "the thread has no folder to run the command in.",
      });
    }

    let output = "";

    const result = await env.exec(
      judge.argv,
      {
        cwd: agent.cwd,
        timeout: judge.timeoutSec,
        onOutput: (text) => {
          output = tailOf(output + text, TAIL_LIMIT);
        },
      },
      context
    );

    if (!result.ok && result.error.code === "aborted") {
      // The run is being aborted or the brain is closing: nothing is recorded, and a rerun judges
      // again.
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
      sha.ok && sha.value.exitCode === 0
        ? /^[0-9a-f]{7,64}$/u.test(found)
        : false
    );

    if (result.ok) {
      return Judged.Verdict({
        verdict: commandVerdict(
          judge,
          runId,
          runtime.now(),
          result.value.exitCode,
          output,
          headSha,
          Option.none()
        ),
      });
    }

    const note =
      result.error.code === "timeout"
        ? `timed out after ${String(judge.timeoutSec)} s`
        : `${argvText(judge.argv)} could not run: ${result.error.message}`;

    return Judged.Verdict({
      verdict: commandVerdict(
        judge,
        runId,
        runtime.now(),
        null,
        output,
        headSha,
        Option.some(note)
      ),
    });
  };

  const runModel = async (
    runtime: Runtime,
    judge: Extract<JudgeRefState, { kind: "model" }>,
    goal: Readonly<GoalState>,
    criterion: CriterionStateDoc,
    runId: string,
    context: ChordContext
  ): Promise<Judged> => {
    const resolved = await models.resolve(judge.spec);

    if (Result.isFailure(resolved)) {
      return Judged.None({ why: resolved.failure });
    }

    const agent = await runtime.agent(context);

    const refusal = judgeModelRefusal(
      Option.fromUndefinedOr(agent.model),
      resolved.success
    );

    if (Option.isSome(refusal)) {
      return Judged.None({ why: refusal.value });
    }

    const view = await runtime.context(runtime.conversationId, context);

    const meta = await runtime.snapshot(
      ThreadMeta,
      runtime.conversationId,
      context
    );

    const reply = await models.ask(
      resolved.success,
      MODEL_JUDGE_SYSTEM,
      modelJudgePrompt({
        objective: goal.objective,
        criterion: criterion.text,
        rubric: judge.rubric,
        transcript: view.messages
          .map(messageText)
          .filter((block) => block !== "")
          .join("\n\n"),
      }),
      {
        runId,
        threadId: Option.flatMap(
          Option.fromUndefinedOr(meta?.threadId),
          decodeThreadId
        ),
      }
    );

    if (Result.isFailure(reply)) {
      return Judged.None({ why: reply.failure });
    }

    const read = parseModelVerdict(reply.success);

    return Judged.Verdict({
      verdict: {
        at: runtime.now(),
        ok: read.ok,
        judge,
        evidence: {
          exit: null,
          tail: null,
          sha: null,
          model: modelText(resolved.success),
          note: read.understood
            ? read.reply
            : `The reply did not start with MET or NOT MET, so the criterion is not met: ${read.reply}`,
        },
        runId,
      },
    });
  };

  const judgeOnce = async (
    runtime: Runtime,
    goal: Readonly<GoalState>,
    criterion: CriterionStateDoc,
    runId: string,
    context: ChordContext
  ): Promise<Judged> => {
    const { judge } = criterion;

    return await Match.value(judge).pipe(
      Match.discriminatorsExhaustive("kind")({
        command: async (found) =>
          await runCommand(runtime, found, runId, context),
        model: async (found) =>
          await runModel(runtime, found, goal, criterion, runId, context),
        user: async () =>
          await Promise.resolve(
            Judged.None({
              why: "the user judges this criterion; ask them to mark it.",
            })
          ),
        verification: async () =>
          await Promise.resolve(
            Judged.None({
              why: "verification recipes arrive in phase 4; nothing can run this judge yet.",
            })
          ),
      })
    );
  };

  /** The completing commit: the verdict, the run's place in the index, the note, the end. */
  const complete = async (
    tx: Tx,
    conversationId: ConversationId,
    taskId: number,
    input: JudgeRunInput,
    criterion: Option.Option<CriterionStateDoc>,
    judged: Judged,
    at: number,
    recordedEarly: boolean
  ): Promise<NextTaskState<JudgeRunState, null>> => {
    const runId = judgeRunId(taskId);
    const requestId = verdictNoteId(taskId);
    // Table reads first: pi-durable refuses one after a table write.
    const reads = await readNote(tx, conversationId, requestId);

    const verdict = verdictOf(judged);

    let outcome: VerdictOutcome | "none" = "none";

    if (recordedEarly) {
      outcome = "recorded";
    } else if (Option.isSome(verdict)) {
      outcome = await recordVerdict(tx, conversationId, {
        criterionId: input.criterionId,
        changedAt: input.changedAt,
        verdict: verdict.value,
      });
    }

    const runs = await tx.doc(JudgeRunsDoc, conversationId);
    const item = runs.items[String(input.toolTaskId)];

    if (item !== undefined && item.settledAt === null) {
      item.settledAt = at;
    }

    // A rerun that finds its verdict already recorded leaves the note that commit admitted.
    if (outcome !== "duplicate") {
      await applyNote(
        tx,
        conversationId,
        requestId,
        reads,
        noteEntry({
          kind: VERDICT_NOTE,
          data: {
            runId,
            criterionId: input.criterionId,
            outcome,
            ok: Option.getOrNull(Option.map(verdict, (found) => found.ok)),
          },
          text: noteText(runId, criterion, judged, outcome),
          at,
        })
      );
    }

    return completed();
  };

  return defineTask<JudgeRunInput, JudgeRunState, null>({
    name: JUDGE_RUN_TASK,
    version: 1,
    initial: () => ({ phase: "judge" }),
    phases: {
      judge: async (task, runtime, context) => {
        const { conversationId } = runtime;
        const runId = judgeRunId(task.id);
        const goal = await runtime.snapshot(GoalDoc, conversationId, context);
        const criterion = criterionOf(goal, task.input);

        const judged: Judged =
          goal === undefined || Option.isNone(criterion)
            ? Judged.None({
                why: "the criterion changed or was removed after the check was queued. Call goal_check again for the criterion as it stands.",
              })
            : await judgeOnce(runtime, goal, criterion.value, runId, context);

        const early = Option.filter(
          verdictOf(judged),
          () => faults.control === "split"
        );

        // The broken control only: the verdict in a commit of its own, under a fresh run id.
        if (Option.isSome(early)) {
          await runtime.commit(async (tx) => {
            await recordVerdict(tx, conversationId, {
              criterionId: task.input.criterionId,
              changedAt: task.input.changedAt,
              verdict: {
                ...early.value,
                runId: `${runId}-${String(runtime.now())}`,
              },
            });
          }, context);
        }

        faults.at("judged");

        await runtime.commit(
          async (tx) =>
            await complete(
              tx,
              conversationId,
              task.id,
              task.input,
              criterion,
              judged,
              runtime.now(),
              Option.isSome(early)
            ),
          context
        );
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const runs = await tx.doc(JudgeRunsDoc, runtime.conversationId);
        const item = runs.items[String(task.input.toolTaskId)];

        if (item !== undefined && item.settledAt === null) {
          item.settledAt = runtime.now();
        }

        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
};

/** The judge-run task definition. */
export type JudgeRunTask = ReturnType<typeof judgeRunTask>;
