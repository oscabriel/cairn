// The goal tools (briefs note section 3) as one extension, `cairn.goals`: `goal_criteria` proposes
// criteria, `goal_check` lists the goal or queues a criterion's judge, and the `cairn.judge-run`
// task judges. Both tools are the model's only (`callers: ["model"]`) and replay-safe.
//
// - `goal_criteria` writes a `criteria` approval (`call-<task id>`, so a rerun finds it) and returns
//   at once: the user binds the criteria by accepting it, in the answering commit
//   (`Verdicts.criteriaAnswered`), never the model. It refuses a model judge that does not resolve
//   or shares the thread model's family. It always asks, whatever the thread's mode.
// - `goal_check {criterion}` creates the judge run in one commit that also indexes it under the
//   tool's task in `cairn.judge-runs`, so a rerun of the tool finds its run, and a criterion whose
//   run is still going is not queued again. It returns "queued", never a verdict. Without a
//   criterion it lists the goal. A `user` judge is the user's to mark; nothing is queued.
//
// A subagent's work is judged by its brief's `doneWhen`, so both tools refuse in a child: goals
// live on the threads the user talks to, the project thread first among them (2026-10-29).

import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Option, Result } from "effect";

import { approvalLedger } from "../brain/CairnDocs.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { ChildDoc, isLinked } from "../subagents/SubagentDocs.ts";
import {
  CRITERIA_TTL_MILLIS,
  criteriaSummary,
  GOAL_CHECK_TOOL,
  GOAL_CRITERIA_TOOL,
  goalListing,
  judgeLine,
  MAX_CRITERION_TEXT,
  MAX_PROPOSED,
  MAX_RUBRIC,
  proposalsOf,
} from "./GoalCriteria.ts";
import { GoalDoc, judgeState, JudgeRunsDoc, NO_GOAL } from "./GoalDocs.ts";
import { judgeRunId, judgeRunTask } from "./JudgeRun.ts";
import type { JudgeFaults, JudgeModels } from "./JudgeRun.ts";
import { judgeModelRefusal } from "./ModelJudge.ts";
import { MAX_CRITERIA } from "./Verdicts.ts";

/** The extension's name in pi-durable's registry. */
export const GOALS_EXTENSION = "cairn.goals";

/**
 * Where `cairn.goals` installs: after the workflows (660), before the bridge's cwd (700). The
 * integrator moves it into `ExtensionOrder` as `goals`.
 */
export const GOALS_ORDER = 670;

const BACKGROUND = {
  ownership: { kind: "conversation" },
  background: true,
} as const;

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  isError,
});

const IN_A_CHILD =
  "Goals live on the threads the user talks to. A subagent's result is judged by its brief's done-when criteria; report your result instead.";

const checkParameters = Type.Object({
  criterion: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        "The id of the criterion to judge, such as c2. Leave it out to list the goal and its criteria.",
    })
  ),
});

const criteriaParameters = Type.Object({
  criteria: Type.Array(
    Type.Object({
      text: Type.String({
        minLength: 1,
        maxLength: MAX_CRITERION_TEXT,
        description: "The condition, stated so a judge can check it.",
      }),
      judge: Type.Union(
        [Type.Literal("command"), Type.Literal("user"), Type.Literal("model")],
        {
          description:
            "command: a command whose exit code decides; user: the user marks it; model: a model of another family reads the transcript.",
        }
      ),
      argv: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: 64,
          description:
            'command judges: the command as an argv list, run without a shell in the thread\'s folder, e.g. ["npm", "test"].',
        })
      ),
      expect_exit: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 255,
          description:
            "command judges: the exit code that means met. Default 0.",
        })
      ),
      timeout_sec: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 3600,
          description:
            "command judges: seconds before the run is cut off. Default 600.",
        })
      ),
      model: Type.Optional(
        Type.String({
          description:
            "model judges: a role such as @judge, or provider/modelId, of another family than this thread's model.",
        })
      ),
      rubric: Type.Optional(
        Type.String({
          maxLength: MAX_RUBRIC,
          description: "model judges: what evidence meets the criterion.",
        })
      ),
    }),
    { minItems: 1, maxItems: MAX_PROPOSED }
  ),
});

/** Whether the calling conversation is a subagent. */
const inChild = async (
  api: ToolExecutionApi,
  context: Parameters<ToolExecutionApi["agent"]>[0]
) => isLinked(await api.snapshot(ChildDoc, api.conversationId, context));

/** The goals extension over `models` (the model judge's resolver and caller) and `faults`. */
export const goalsExtension = (
  models: JudgeModels,
  faults: JudgeFaults
): CairnExtension => {
  const JudgeRun = judgeRunTask(models, faults);

  const check = defineTool({
    name: GOAL_CHECK_TOOL,
    description:
      "Queue an outside judge for one of this thread's goal criteria, or list the goal. The judge runs in the background and its verdict arrives as a note; this tool never returns a verdict, and only a judge can mark a criterion met.",
    parameters: checkParameters,
    replay: "safe",
    callers: ["model"],
    execute: async (args, api, context) => {
      if (await inChild(api, context)) {
        return text(IN_A_CHILD, true);
      }

      const goal = await api.snapshot(GoalDoc, api.conversationId, context);
      const criteria = goal?.criteria ?? [];

      if (args.criterion === undefined || goal === undefined) {
        return text(
          goal === undefined ? goalListing(NO_GOAL()) : goalListing(goal),
          args.criterion !== undefined
        );
      }

      const wanted = args.criterion.trim();
      const criterion = criteria.find((item) => item.id === wanted);

      if (criterion === undefined) {
        const ids = criteria.map((item) => item.id).join(", ");

        return text(
          `criterion: ${wanted} is not one of this goal's criteria${ids === "" ? " (it has none yet)" : ` (${ids})`}. Call goal_check without a criterion to list them.`,
          true
        );
      }

      if (
        criterion.judge.kind === "user" ||
        criterion.judge.kind === "verification"
      ) {
        return text(
          criterion.judge.kind === "user"
            ? `${criterion.id} is judged by the user, who marks it met or not on the goal. Ask them to when the work is ready; nothing was queued.`
            : `${criterion.id} names a verification recipe, which arrives in phase 4; nothing can run it yet.`,
          true
        );
      }

      if (criterion.judge.kind === "model") {
        const resolved = await models.resolve(criterion.judge.spec);

        if (Result.isFailure(resolved)) {
          return text(`${criterion.id}: ${resolved.failure}`, true);
        }

        const agent = await api.agent(context);

        const refusal = judgeModelRefusal(
          Option.fromUndefinedOr(agent.model),
          resolved.success
        );

        if (Option.isSome(refusal)) {
          return text(`${criterion.id}: ${refusal.value}`, true);
        }
      }

      const queued = await api.commit(async (tx) => {
        const runs = await tx.doc(JudgeRunsDoc, api.conversationId);
        const mine = runs.items[String(api.taskId)];

        if (mine !== undefined) {
          return { taskId: mine.taskId, fresh: false };
        }

        const live = Object.values(runs.items).find(
          (item) => item.criterionId === criterion.id && item.settledAt === null
        );

        if (live !== undefined) {
          return { taskId: live.taskId, fresh: false };
        }

        const taskId = await tx.createTask(
          JudgeRun,
          {
            criterionId: criterion.id,
            changedAt: criterion.changedAt,
            toolTaskId: api.taskId,
          },
          { ...BACKGROUND, conversationId: api.conversationId }
        );

        runs.items[String(api.taskId)] = {
          taskId,
          criterionId: criterion.id,
          queuedAt: api.now(),
          settledAt: null,
        };

        return { taskId, fresh: true };
      }, context);

      faults.at("queued");

      const runId = judgeRunId(queued.taskId);

      return text(
        queued.fresh
          ? `Queued judge run ${runId} for ${criterion.id} (${judgeLine(criterion.judge)}). Its verdict arrives as a note in this thread; this tool returns no verdict.`
          : `Judge run ${runId} for ${criterion.id} is already queued or running. Its verdict arrives as a note.`
      );
    },
  });

  const propose = defineTool({
    name: GOAL_CRITERIA_TOOL,
    description:
      "Propose criteria for this thread's goal, each bound to the outside judge that decides it. The user reads and approves them before they bind; this returns at once.",
    parameters: criteriaParameters,
    replay: "safe",
    callers: ["model"],
    execute: async (args, api, context) => {
      if (await inChild(api, context)) {
        return text(IN_A_CHILD, true);
      }

      const proposals = proposalsOf(args.criteria);

      if (Result.isFailure(proposals)) {
        return text(proposals.failure, true);
      }

      const goal = await api.snapshot(GoalDoc, api.conversationId, context);
      const held = goal?.criteria.length ?? 0;

      if (held + proposals.success.length > MAX_CRITERIA) {
        return text(
          `criteria: this goal holds ${String(held)} criteria and takes at most ${String(MAX_CRITERIA)}. Propose fewer.`,
          true
        );
      }

      const agent = await api.agent(context);

      for (const [index, proposal] of proposals.success.entries()) {
        if (proposal.judge.kind !== "model") {
          continue;
        }

        // oxlint-disable-next-line no-await-in-loop -- one role at a time, refusing at the first
        const resolved = await models.resolve(proposal.judge.spec);
        const at = `criteria[${String(index)}].model`;

        if (Result.isFailure(resolved)) {
          return text(`${at}: ${resolved.failure}`, true);
        }

        const refusal = judgeModelRefusal(
          Option.fromUndefinedOr(agent.model),
          resolved.success
        );

        if (Option.isSome(refusal)) {
          return text(`${at}: ${refusal.value}`, true);
        }
      }

      const ledger = approvalLedger(api);

      const asked = await Effect.runPromise(
        ledger
          .ask({
            tool: GOAL_CRITERIA_TOOL,
            kind: "criteria",
            summary: criteriaSummary(proposals.success),
            ttlMillis: CRITERIA_TTL_MILLIS,
            payload: Option.some({
              type: "criteria",
              criteria: proposals.success.map((proposal) => ({
                text: proposal.text,
                judge: judgeState(proposal.judge),
              })),
            }),
            acceptedBy: Option.none(),
          })
          .pipe(Effect.result),
        { signal: context.abortSignal }
      );

      if (Result.isFailure(asked)) {
        return text(asked.failure.message, true);
      }

      const record = asked.success;

      return text(
        record.status === "pending"
          ? `Criteria proposal ${record.id} is waiting for the user's approval. Once approved the criteria bind to this thread's goal; then judge each with goal_check.`
          : `Criteria proposal ${record.id} was ${record.status}.`
      );
    },
  });

  return {
    order: GOALS_ORDER,
    extension: defineExtension({
      name: GOALS_EXTENSION,
      tools: [check, propose],
      tasks: [JudgeRun],
    }),
  };
};
