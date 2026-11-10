// `spend.get` (ADR 0036): what a thread and its lineage subtree, a goal, a workflow run or the whole
// brain spent, by model, for the detail panel. Dollar figures are list prices with their basis, and
// unpriced tokens are counted apart, never as zero. A scope naming a thread or run the brain does
// not hold answers `NotFound`; a ledger that cannot be read is logged and answers `Internal`.
//
// `budget.declare` (ADR 0047): the user's budget on a thread and its lineage subtree, from the usage
// page, through the budget guard, so a thread already past the new line is stopped and told so at
// once. It is a `stop` scope: at its line every thread in it stops. A thread the shell does not hold
// (or no longer does) answers `NotFound`; one the brain has not started yet, or a store that cannot
// be reached, `Unavailable` with the guard's words; a ledger that cannot be read, `Internal`.

import { Internal, NotFound, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type { BudgetDeclareInput, SpendGetInput } from "@cairn/protocol/Spend";
import { Effect, Layer, Option } from "effect";

import { isLiveThread, ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetGuard } from "../usage/BudgetGuard.ts";
import { SpendLedger } from "../usage/SpendLedger.ts";
import { publicText } from "./PublicText.ts";

/** `spend.get`'s answer from the ledger, its failures as public errors. */
export const answerSpend = (
  ledger: SpendLedger["Service"],
  input: SpendGetInput
) =>
  ledger.rollup(input.scope).pipe(
    Effect.catchTags({
      SpendScopeNotFound: (missing) =>
        Effect.fail(
          new NotFound({
            message: publicText(missing.message),
            resource: missing.resource,
            id: missing.id,
          })
        ),
      SpendLedgerError: (failure) =>
        Effect.logError("spend not read").pipe(
          Effect.annotateLogs({
            event: "spend_get_failed",
            error: failure.message,
          }),
          Effect.andThen(
            Effect.fail(
              new Internal({
                message:
                  "Reading the spend ledger failed. Nothing changed; retry, and check the brain's log (spend_get_failed) if it repeats.",
              })
            )
          )
        ),
    })
  );

/** `budget.declare`'s answer: the thread's own budget, declared through the guard. */
export const declareBudget = (
  guard: BudgetGuard["Service"],
  rows: ThreadRows["Service"],
  input: BudgetDeclareInput
) =>
  Effect.gen(function* () {
    const row = yield* rows.get(input.threadId);

    if (Option.isNone(Option.filter(row, isLiveThread))) {
      return yield* new NotFound({
        message: `Thread ${input.threadId} is not in the shell, so no budget was set.`,
        resource: "thread",
        id: input.threadId,
      });
    }

    return yield* guard.declare(input.threadId, input.budget, "stop");
  }).pipe(
    Effect.catchTags({
      BudgetSourceError: (failure) =>
        Effect.fail(new Unavailable({ message: publicText(failure.message) })),
      ShellStoreError: (failure) =>
        Effect.logError("budget not declared").pipe(
          Effect.annotateLogs({
            event: "budget_declare_failed",
            error: failure.message,
          }),
          Effect.andThen(
            Effect.fail(
              new Internal({
                message:
                  "Reading the thread failed, so no budget was set. Retry, and check the brain's log (budget_declare_failed) if it repeats.",
              })
            )
          )
        ),
      SpendLedgerError: (failure) =>
        Effect.logError("budget declared, standing not read").pipe(
          Effect.annotateLogs({
            event: "budget_declare_failed",
            error: failure.message,
          }),
          Effect.andThen(
            Effect.fail(
              new Internal({
                message:
                  "The budget was set, but its spend could not be read yet; the guard reads it again with the next spend. Check the brain's log (budget_declare_failed) if it repeats.",
              })
            )
          )
        ),
    })
  );

/** `spend.get` and `budget.declare`. Needs `SpendLedger`, `BudgetGuard` and `ThreadRows`. */
export const SpendHandlers = Layer.mergeAll(
  CairnRpcs.toLayerHandler(
    "spend.get",
    SpendLedger.useSync((ledger) => (input) => answerSpend(ledger, input))
  ),
  CairnRpcs.toLayerHandler(
    "budget.declare",
    Effect.gen(function* () {
      const guard = yield* BudgetGuard;
      const rows = yield* ThreadRows;

      return (input) => declareBudget(guard, rows, input);
    })
  )
);
