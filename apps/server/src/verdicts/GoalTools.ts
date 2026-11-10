// The goal tools (briefs note section 3) as one extension, `cairn.goals`: `goal_criteria` proposes
// criteria, `goal_check` lists the goal or queues a criterion's judge, and the `cairn.judge-run`
// task judges. Both tools are the model's only (`callers: ["model"]`) and replay-safe.
//
// - `goal_criteria` writes a `criteria` approval (`call-<task id>`, so a rerun finds it) and returns
//   at once: the user binds the criteria by accepting it, in the answering commit
//   (`Verdicts.criteriaAnswered`), never the model. It refuses a model judge that cannot run: a
//   named model that is not ready, or the Claude bridge, and a judge on the thread's own model,
//   named or by naming none, which only the user may pick (ADR 0055). It always asks, whatever the
//   thread's mode.
// - `goal_check {criterion}` creates the judge run in one commit that also indexes it under the
//   tool's task in `cairn.judge-runs`, so a rerun of the tool finds its run, and a criterion whose
//   run is still going is not queued again. It returns "queued", never a verdict. Without a
//   criterion it lists the goal. A `user` judge is the user's to mark; nothing is queued.
//
// A subagent's result goes to its parent, which accepts it (its brief's `done_when` command is shown
// and given to the child, not run, ADR 0055), so both tools refuse in a child: goals
// live on the threads the user talks to, the project thread first among them (2026-10-29).

import type { ModelRef } from "@cairn/protocol/Models";
import type { ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Option, Result } from "effect";
import { Type } from "typebox";

import { approvalLedger } from "../approvals/ApprovalLedger.ts";
import type { DurableRunner } from "../brain/Durable.ts";
import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { ChildDoc, isLinked } from "../brain/SubagentDocs.ts";
import { taskOf } from "../subagents/Delivery.ts";
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
import type { JudgeRunItemState } from "./GoalDocs.ts";
import { judgeRunId, judgeRunTask } from "./JudgeRun.ts";
import type { JudgeFaults, JudgeModels } from "./JudgeRun.ts";
import { judgeModelRefusal, judgeSpecOf } from "./ModelJudge.ts";
import { MAX_CRITERIA } from "./Verdicts.ts";

/** The extension's name in pi-durable's registry. */
export const GOALS_EXTENSION = "cairn.goals";

const BACKGROUND = {
  ownership: { kind: "conversation" },
  background: true,
} as const;

const text = (value: string, isError = false) => ({
  output: [{ type: "text" as const, text: value }],
  isError,
});

const IN_A_CHILD =
  "Goals live on the threads the user talks to. A subagent's result goes to its parent, which accepts it; report your result instead.";

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
            "command: a command whose exit code decides; user: the user marks it; model: a model reads the transcript (this thread's own unless model names another).",
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
            "model judges: the model that judges, provider/modelId[:level]; call models to see what is available. Leave it out to judge on this thread's own model; name another only when the user asks for one.",
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

/**
 * The first of `items` (unsettled index items of one criterion) whose judge run can still settle
 * it. An item whose task is gone, or ended without its completing commit (a fault, or boot's crash
 * accounting, `CrashLimit.ts`), can never settle on its own: it is settled here at `now`, in the asking commit,
 * so the criterion is queued afresh rather than waiting on it for good. Table reads: call it
 * before the commit's first table write.
 */
const liveRunOf = async (
  tx: Tx,
  items: ReadonlyArray<JudgeRunItemState>,
  now: number
): Promise<Option.Option<JudgeRunItemState>> => {
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- one task read per unsettled item, in order
    const task = await tx.task(taskOf(item.taskId));

    const live =
      task !== undefined &&
      task.state.status !== "completing" &&
      task.state.status !== "terminal";

    if (live) {
      return Option.some(item);
    }

    item.settledAt = now;
  }

  return Option.none();
};

/**
 * The goals extension over `models` (the model judge's resolver and caller) and `faults`, running
 * its Effects through `run`.
 */
export const goalsExtension = (
  models: JudgeModels,
  faults: JudgeFaults,
  run: DurableRunner
): CairnExtension => {
  const JudgeRun = judgeRunTask(models, faults, run);

  /**
   * Why a model judge cannot run on a thread on `threadModel`; none when it can. A named model must
   * be ready and may not be the Claude bridge; one naming none would run on the thread's own and is
   * refused (ADR 0055). `by` says who named the model:
   * the thread's model may not propose itself, while a bound criterion's model is the user's pick.
   */
  const judgeCannotRun = async (
    spec: string | null,
    threadModel: Option.Option<ModelRef>,
    by: "proposed" | "user"
  ): Promise<Option.Option<string>> => {
    const named = judgeSpecOf(spec);

    const resolved = await Option.match(named, {
      onNone: async () =>
        await Promise.resolve(
          Option.match(threadModel, {
            onNone: () =>
              Result.fail(
                "this thread runs on no model a judge can use. Name the judge's model as provider/modelId."
              ),
            onSome: (model) => Result.succeed(model),
          })
        ),
      onSome: async (found) => await models.resolve(found),
    });

    return Result.match(resolved, {
      onFailure: (why) => Option.some(why),
      onSuccess: (model) =>
        judgeModelRefusal(
          model,
          Option.isSome(named) ? by : "none",
          threadModel
        ),
    });
  };

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
        const agent = await api.agent(context);

        const refusal = await judgeCannotRun(
          criterion.judge.spec,
          Option.fromUndefinedOr(agent.model),
          "user"
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

        const live = await liveRunOf(
          tx,
          Object.values(runs.items).filter(
            (item) =>
              item.criterionId === criterion.id &&
              (item.changedAt === undefined ||
                item.changedAt === criterion.changedAt) &&
              item.settledAt === null
          ),
          api.now()
        );

        if (Option.isSome(live)) {
          return { taskId: live.value.taskId, fresh: false };
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
          changedAt: criterion.changedAt,
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

        // oxlint-disable-next-line no-await-in-loop -- one judge at a time, refusing at the first
        const refusal = await judgeCannotRun(
          proposal.judge.spec,
          Option.fromUndefinedOr(agent.model),
          "proposed"
        );

        if (Option.isSome(refusal)) {
          return text(
            `criteria[${String(index)}].model: ${refusal.value}`,
            true
          );
        }
      }

      const ledger = approvalLedger(api);

      const asked = await run.promise(
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
    order: ExtensionOrder.goals,
    extension: defineExtension({
      name: GOALS_EXTENSION,
      tools: [check, propose],
      tasks: [JudgeRun],
    }),
  };
};
