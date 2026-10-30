// The user's side of a goal (ADR 0026, briefs note section 3), from the host: `setCriteria` binds a
// thread's objective and criteria directly (`goal.setCriteria`, `decidedBy` user), and `mark` records
// the user's own verdict on a criterion a `user` judge decides (`goal.mark`). Both commit through the
// verdict writer (`Verdicts.ts`) in one host commit on the thread's conversation.
//
// The rules the model's `goal_criteria` keeps hold here too: a subagent's thread has no goal (its
// brief's done-when judges it), `verification` judges wait for phase 4, and a `model` judge must
// resolve now to a model of another family than the thread's (`ModelJudge.ts`), which the user
// would otherwise only learn when the judge refused to run.
//
// The rules live once, over a goal host: pi-durable's store (the deployed brain), or the scripted
// harness's goals (`ScriptedGoals`), so a judge over the scripted brain binds, refuses and marks as
// the deployed brain does, through the same verdict writer.

import type { ThreadId } from "@cairn/protocol/Ids";
import { ConversationId as ProtocolConversationId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import type {
  CriterionProposal,
  SetCriteriaInput,
} from "@cairn/protocol/Policy";
import type { RoleSpec } from "@cairn/protocol/Roles";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect";

import { Brain } from "../brain/Brain.ts";
import { ThreadReceipt } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { ScriptedGoals } from "../brain/ScriptedHarness.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { ChildDoc, isLinked } from "../subagents/SubagentDocs.ts";
import { judgeModelRefusal } from "./ModelJudge.ts";
import {
  applyBind,
  applyMark,
  BindOutcome,
  bindCriteria,
  markByUser,
  MAX_CRITERIA,
} from "./Verdicts.ts";
import type { BindInput, MarkOutcome } from "./Verdicts.ts";

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

/** A thread the brain does not hold. */
const missing = (threadId: ThreadId) =>
  failure(
    threadId,
    "thread_not_found",
    `Thread ${threadId} does not exist in the brain. Refresh and pick a thread that does.`
  );

/** A thread as its goal reads it: whether it is a subagent, and the model it runs on. */
interface GoalThread<Key> {
  /** Where the host finds the thread's goal again. */
  readonly key: Key;
  readonly child: boolean;
  readonly model: Option.Option<ModelRef>;
}

/** Where goals live: pi-durable's store, or the scripted harness's. */
interface GoalHost<Key> {
  /** The thread; none when the brain does not hold it. */
  readonly threadOf: (
    threadId: ThreadId
  ) => Effect.Effect<Option.Option<GoalThread<Key>>, GoalError>;
  /** The model a model judge's spec resolves to now, or why not, in the role table's words. */
  readonly resolveJudge: (
    threadId: ThreadId,
    spec: RoleSpec
  ) => Effect.Effect<Result.Result<ModelRef, string>, GoalError>;
  /** Binds criteria in one commit, through the verdict writer. */
  readonly bind: (
    threadId: ThreadId,
    key: Key,
    input: BindInput
  ) => Effect.Effect<BindOutcome, GoalError>;
  /** Records the user's mark in one commit, through the verdict writer. */
  readonly mark: (
    input: MarkInput,
    key: Key
  ) => Effect.Effect<MarkOutcome, GoalError>;
}

/** The goal service's rules over a host. */
const bookOver = <Key>(host: GoalHost<Key>): GoalBook["Service"] => {
  /** The thread, refused when the brain does not hold it or it is a subagent. */
  const threadOf = Effect.fn("GoalBook.threadOf")(function* (
    threadId: ThreadId
  ) {
    const found = yield* host.threadOf(threadId);

    if (Option.isNone(found)) {
      return yield* missing(threadId);
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

    const resolved = yield* host.resolveJudge(threadId, proposal.judge.spec);

    if (Result.isFailure(resolved)) {
      return yield* failure(threadId, "invalid_input", resolved.failure, field);
    }

    const refusal = judgeModelRefusal(model, resolved.success);

    if (Option.isSome(refusal)) {
      return yield* failure(threadId, "invalid_input", refusal.value, field);
    }

    return yield* Effect.void;
  });

  const setCriteria = Effect.fn("GoalBook.setCriteria")(function* (
    input: SetCriteriaInput
  ) {
    const thread = yield* threadOf(input.threadId);

    for (const [index, proposal] of input.criteria.entries()) {
      yield* checkJudge(input.threadId, thread.model, proposal, index);
    }

    const outcome = yield* host.bind(input.threadId, thread.key, {
      objective: input.objective,
      criteria: input.criteria,
      mode: "replace",
    });

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
    const thread = yield* threadOf(input.threadId);
    const outcome = yield* host.mark(input, thread.key);

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

  return { setCriteria, mark };
};

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
      const threadOf = Effect.fn("GoalBook.readThread")(function* (
        threadId: ThreadId
      ) {
        const session = yield* sessionFor(threadId);

        return yield* durable("goal.read-thread", async (context) => {
          const receipt = await session.harness.snapshot(
            ThreadReceipt,
            threadId,
            context
          );

          if (receipt === undefined || receipt.conversationId < 1) {
            return Option.none<GoalThread<ConversationId>>();
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

          return Option.some<GoalThread<ConversationId>>({
            key: conversationId,
            child: isLinked(link),
            model: Option.fromUndefinedOr(agent?.model),
          });
        }).pipe(Effect.mapError(storeFailed(threadId)));
      });

      const resolveJudge = (
        threadId: ThreadId,
        spec: RoleSpec
      ): Effect.Effect<Result.Result<ModelRef, string>, GoalError> =>
        roles.resolve(spec, Option.none()).pipe(
          Effect.map((resolved) => Result.succeed(resolved.model)),
          Effect.catchTags({
            RoleError: (error) => Effect.succeed(Result.fail(error.message)),
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

      const bind = Effect.fn("GoalBook.bind")(function* (
        threadId: ThreadId,
        conversationId: ConversationId,
        input: BindInput
      ) {
        const session = yield* sessionFor(threadId);

        return yield* durable(
          "goal.set-criteria",
          async (context) =>
            await session.harness.commit(
              async (tx) =>
                await bindCriteria(tx, conversationId, input, brain.now()),
              context
            )
        ).pipe(Effect.mapError(storeFailed(threadId)));
      });

      const mark = Effect.fn("GoalBook.recordMark")(function* (
        input: MarkInput,
        conversationId: ConversationId
      ) {
        const session = yield* sessionFor(input.threadId);

        return yield* durable(
          "goal.mark",
          async (context) =>
            await session.harness.commit(
              async (tx) =>
                await markByUser(tx, conversationId, {
                  criterionId: input.criterionId,
                  ok: input.ok,
                  note: input.note,
                  at: brain.now(),
                }),
              context
            )
        ).pipe(Effect.mapError(storeFailed(input.threadId)));
      });

      return bookOver<ConversationId>({ threadOf, resolveJudge, bind, mark });
    })
  );

  /** Over `RoleAliases.layerNoDeps`; the root gives `Brain` and the role table's sources. */
  static readonly layer = GoalBook.layerNoDeps.pipe(
    Layer.provide(RoleAliases.layerNoDeps)
  );

  /**
   * Over the scripted harness's goals (`ScriptedGoals`): the same rules and the same verdict
   * writer, a model judge resolved through the scripted role table. For the judges' scripted brains.
   */
  static readonly layerScripted = Layer.effect(
    GoalBook,
    Effect.gen(function* () {
      const goals = yield* ScriptedGoals;

      /** One change through the verdict writer; a thread gone since it was read is missing. */
      const change = <A>(
        threadId: ThreadId,
        apply: (goal: Parameters<typeof applyBind>[0], at: number) => A
      ) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;

          const outcome = yield* goals.change(threadId, (goal) =>
            apply(goal, at)
          );

          if (Option.isNone(outcome)) {
            return yield* missing(threadId);
          }

          return outcome.value;
        });

      return bookOver<ThreadId>({
        threadOf: (threadId) =>
          Effect.map(goals.thread(threadId), (found) =>
            Option.map(found, (thread) => ({
              key: threadId,
              child: thread.child,
              model: Option.some(thread.model),
            }))
          ),
        resolveJudge: (_threadId, spec) =>
          Effect.succeed(goals.resolveJudge(spec)),
        bind: (threadId, key, input) =>
          change(key, (goal, at) => applyBind(goal, input, at)),
        mark: (input, key) =>
          change(key, (goal, at) =>
            applyMark(goal, {
              criterionId: input.criterionId,
              ok: input.ok,
              note: input.note,
              at,
            })
          ),
      });
    })
  );

  /** For brains with no goals at all, which refuse every change as unavailable. */
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
