// The user's side of a goal (ADR 0026, briefs note section 3), from the host: `setCriteria` binds a
// thread's objective and criteria directly (`goal.setCriteria`, `decidedBy` user), and `mark` records
// the user's own verdict on a criterion a `user` judge decides. Both commit through the verdict
// writer (`Verdicts.ts`) in one host commit on the thread's conversation.
//
// The rules the model's `goal_criteria` keeps hold here too: a subagent's thread has no goal (its
// brief's done-when judges it), `verification` judges wait for phase 4, and a `model` judge must
// resolve now to a model of another family than the thread's (`ModelJudge.ts`), which the user
// would otherwise only learn when the judge refused to run.

import type { ThreadId } from "@cairn/protocol/Ids";
import { ConversationId as ProtocolConversationId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import type {
  CriterionProposal,
  SetCriteriaInput,
} from "@cairn/protocol/Policy";
import { AgentDoc } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { Brain } from "../brain/Brain.ts";
import type { BrainSession } from "../brain/Brain.ts";
import { ThreadReceipt } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { ChildDoc, isLinked } from "../subagents/SubagentDocs.ts";
import { judgeModelRefusal } from "./ModelJudge.ts";
import {
  BindOutcome,
  bindCriteria,
  markByUser,
  MAX_CRITERIA,
} from "./Verdicts.ts";
import type { MarkOutcome } from "./Verdicts.ts";

/** A goal change failed; `reason` says what the caller can do. */
export class GoalError extends Schema.TaggedError<GoalError>()("GoalError", {
  message: Schema.String,
  threadId: Schema.String,
  reason: Schema.Literals([
    "thread_not_found",
    "criterion_not_found",
    "invalid_input",
    "unavailable",
    "store_failed",
  ]),
  /** The input field at fault, for `invalid_input`. */
  field: Schema.OptionFromNullOr(Schema.String),
}) {}

/** The user's mark on one criterion a `user` judge decides. */
export interface MarkInput {
  readonly threadId: ThreadId;
  readonly criterionId: string;
  readonly ok: boolean;
  readonly note: Option.Option<string>;
}

const failure = (
  threadId: ThreadId,
  reason: GoalError["reason"],
  message: string,
  field: Option.Option<string> = Option.none()
) => new GoalError({ message, threadId, reason, field });

/** A store call failed: unavailable while the Harness closes, a store failure otherwise. */
const storeFailed = (threadId: ThreadId) => (cause: DurableCallError) =>
  failure(
    threadId,
    cause.closed ? "unavailable" : "store_failed",
    `Changing the goal of thread ${threadId} failed: ${cause.message}. Nothing changed; retry.`
  );

/** The goal service the RPC handlers call. */
export class GoalBook extends Context.Service<
  GoalBook,
  {
    /** Binds the thread's criteria as the user gave them, replacing the goal's list. */
    setCriteria(input: SetCriteriaInput): Effect.Effect<void, GoalError>;
    /** Records the user's verdict on a criterion its user judge decides. */
    mark(input: MarkInput): Effect.Effect<MarkOutcome, GoalError>;
  }
>()("cairn/server/verdicts/GoalBook") {
  /** Over the root's `Brain` and `RoleAliases`. */
  static readonly layerNoDeps = Layer.effect(
    GoalBook,
    Effect.gen(function* () {
      const brain = yield* Brain;
      const roles = yield* RoleAliases;

      const sessionFor = (threadId: ThreadId) =>
        brain.session.pipe(
          Effect.mapError((down) =>
            failure(
              threadId,
              "unavailable",
              `${down.message} Nothing changed; retry once the brain is up.`
            )
          )
        );

      /** The thread's conversation, its subagent link and its model. */
      const threadOf = Effect.fn("GoalBook.threadOf")(function* (
        session: BrainSession,
        threadId: ThreadId
      ) {
        const found = yield* durable("goal.read-thread", async (context) => {
          const receipt = await session.harness.snapshot(
            ThreadReceipt,
            threadId,
            context
          );

          if (receipt === undefined || receipt.conversationId < 1) {
            return Option.none();
          }

          const conversationId = piConversationId(
            ProtocolConversationId.make(receipt.conversationId)
          );

          const link = await session.harness.snapshot(
            ChildDoc,
            conversationId,
            context
          );

          const agent = await session.harness.snapshot(
            AgentDoc,
            conversationId,
            context
          );

          return Option.some({
            conversationId,
            child: isLinked(link),
            model: Option.fromUndefinedOr(agent?.model),
          });
        }).pipe(Effect.mapError(storeFailed(threadId)));

        if (Option.isNone(found)) {
          return yield* failure(
            threadId,
            "thread_not_found",
            `Thread ${threadId} does not exist in the brain. Refresh and pick a thread that does.`
          );
        }

        if (found.value.child) {
          return yield* failure(
            threadId,
            "invalid_input",
            `Thread ${threadId} is a subagent: its brief's done-when criteria judge it, so it has no goal of its own. Give the goal to the thread that owns it.`
          );
        }

        return found.value;
      });

      /** Refuses a judge that cannot run: verification, or a model judge that does not resolve or shares the thread's family. */
      const checkJudge = Effect.fn("GoalBook.checkJudge")(function* (
        threadId: ThreadId,
        model: Option.Option<ModelRef>,
        proposal: CriterionProposal,
        index: number
      ) {
        const field = Option.some(`criteria[${String(index)}].judge`);

        if (proposal.judge.kind === "verification") {
          return yield* failure(
            threadId,
            "invalid_input",
            "Verification recipes arrive in phase 4. Judge this criterion by a command, by you or by a model of another family.",
            field
          );
        }

        if (proposal.judge.kind !== "model") {
          return yield* Effect.void;
        }

        const resolved = yield* roles
          .resolve(proposal.judge.spec, Option.none())
          .pipe(
            Effect.catchTags({
              RoleError: (error) =>
                Effect.fail(
                  failure(threadId, "invalid_input", error.message, field)
                ),
              RoleAliasesUnavailable: (error) =>
                Effect.fail(
                  failure(
                    threadId,
                    "unavailable",
                    `${error.message} Nothing changed; retry.`
                  )
                ),
            })
          );

        const refusal = judgeModelRefusal(model, resolved.model);

        if (Option.isSome(refusal)) {
          return yield* failure(
            threadId,
            "invalid_input",
            refusal.value,
            field
          );
        }

        return yield* Effect.void;
      });

      const setCriteria = Effect.fn("GoalBook.setCriteria")(function* (
        input: SetCriteriaInput
      ) {
        const session = yield* sessionFor(input.threadId);
        const thread = yield* threadOf(session, input.threadId);

        for (const [index, proposal] of input.criteria.entries()) {
          yield* checkJudge(input.threadId, thread.model, proposal, index);
        }

        const outcome = yield* durable(
          "goal.set-criteria",
          async (context) =>
            await session.harness.commit(
              async (tx) =>
                await bindCriteria(
                  tx,
                  thread.conversationId,
                  {
                    objective: input.objective,
                    criteria: input.criteria,
                    mode: "replace",
                  },
                  brain.now()
                ),
              context
            )
        ).pipe(Effect.mapError(storeFailed(input.threadId)));

        if (BindOutcome.$is("TooMany")(outcome)) {
          return yield* failure(
            input.threadId,
            "invalid_input",
            `A goal holds at most ${String(MAX_CRITERIA)} criteria; this would hold ${String(outcome.total)}. Bind fewer.`,
            Option.some("criteria")
          );
        }

        return yield* Effect.void;
      });

      const mark = Effect.fn("GoalBook.mark")(function* (input: MarkInput) {
        const session = yield* sessionFor(input.threadId);
        const thread = yield* threadOf(session, input.threadId);

        const outcome = yield* durable(
          "goal.mark",
          async (context) =>
            await session.harness.commit(
              async (tx) =>
                await markByUser(tx, thread.conversationId, {
                  criterionId: input.criterionId,
                  ok: input.ok,
                  note: input.note,
                  at: brain.now(),
                }),
              context
            )
        ).pipe(Effect.mapError(storeFailed(input.threadId)));

        if (outcome === "not_found") {
          return yield* failure(
            input.threadId,
            "criterion_not_found",
            `Criterion ${input.criterionId} is not on thread ${input.threadId}'s goal. Refresh the goal; it may have changed.`
          );
        }

        if (outcome === "not_user_judge") {
          return yield* failure(
            input.threadId,
            "invalid_input",
            `Criterion ${input.criterionId} is decided by its judge's run, not by hand. Ask the thread to check it.`,
            Option.some("criterionId")
          );
        }

        return outcome;
      });

      return GoalBook.of({ setCriteria, mark });
    })
  );

  /** Over `RoleAliases.layerNoDeps`; the root gives `Brain` and the role table's sources. */
  static readonly layer = GoalBook.layerNoDeps.pipe(
    Layer.provide(RoleAliases.layerNoDeps)
  );

  /** For brains with no pi-durable Harness (the scripted dev brain), which hold no goals. */
  static readonly layerOff = Layer.succeed(
    GoalBook,
    GoalBook.of({
      setCriteria: (input) =>
        Effect.fail(
          failure(
            input.threadId,
            "unavailable",
            `Thread ${input.threadId} cannot take a goal: this brain holds no goals.`
          )
        ),
      mark: (input) =>
        Effect.fail(
          failure(
            input.threadId,
            "unavailable",
            `Thread ${input.threadId} cannot take a mark: this brain holds no goals.`
          )
        ),
    })
  );
}
