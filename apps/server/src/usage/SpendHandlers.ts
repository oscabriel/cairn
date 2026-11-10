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
//
// `budget.get` (ADR 0047): the line a thread's own scope stands at now, read from the documents, so
// the usage page's form starts from it and a save never drops a limit the user did not see. A
// thread the shell does not hold answers `NotFound`; a store that cannot be reached, `Unavailable`.

import { Internal, NotFound, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type {
  BudgetDeclareInput,
  BudgetGetInput,
  SpendGetInput,
} from "@cairn/protocol/Spend";
import { Effect, Layer, Option } from "effect";

import { publicText } from "../rpc/PublicText.ts";
import { isLiveThread, ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetGuard } from "./BudgetGuard.ts";
import { SpendLedger } from "./SpendLedger.ts";

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

/** Fails `NotFound`, naming what was not done, unless the shell holds `threadId` live. */
const liveThread = (
  rows: ThreadRows["Service"],
  threadId: BudgetGetInput["threadId"],
  undone: string
) =>
  rows.get(threadId).pipe(
    Effect.flatMap((row) =>
      Option.isSome(Option.filter(row, isLiveThread))
        ? Effect.void
        : Effect.fail(
            new NotFound({
              message: `Thread ${threadId} is not in the shell, so ${undone}.`,
              resource: "thread",
              id: threadId,
            })
          )
    )
  );

/** `budget.get`'s answer: the line the thread's own scope stands at, through the guard. */
export const readBudget = (
  guard: BudgetGuard["Service"],
  rows: ThreadRows["Service"],
  input: BudgetGetInput
) =>
  Effect.gen(function* () {
    yield* liveThread(rows, input.threadId, "its budget was not read");

    return { budget: yield* guard.line(input.threadId) };
  }).pipe(
    Effect.catchTags({
      BudgetSourceError: (failure) =>
        Effect.fail(new Unavailable({ message: publicText(failure.message) })),
      ShellStoreError: (failure) =>
        Effect.logError("budget not read").pipe(
          Effect.annotateLogs({
            event: "budget_get_failed",
            error: failure.message,
          }),
          Effect.andThen(
            Effect.fail(
              new Internal({
                message:
                  "Reading the thread failed, so its budget was not read. Retry, and check the brain's log (budget_get_failed) if it repeats.",
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
    yield* liveThread(rows, input.threadId, "no budget was set");

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

/**
 * `spend.get`, `budget.declare` and `budget.get`. Needs `SpendLedger`, `BudgetGuard` and
 * `ThreadRows`.
 */
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
  ),
  CairnRpcs.toLayerHandler(
    "budget.get",
    Effect.gen(function* () {
      const guard = yield* BudgetGuard;
      const rows = yield* ThreadRows;

      return (input) => readBudget(guard, rows, input);
    })
  )
);
