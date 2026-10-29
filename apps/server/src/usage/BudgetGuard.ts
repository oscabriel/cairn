// The budget guard (ADR 0036, models note section 4, enforcement point c): a fiber on the spend
// ledger's changes that evaluates every scope covering the threads whose spend moved, and acts once
// on each scope whose state moved.
//
// - Past the warning line: a `budget_warning` notice in the scope's thread and a push.
// - At the line: in `stop` mode every thread of the scope's subtree is stopped, queue cleared (its
//   children are in the subtree, so each is stopped by itself); in `drain` mode nothing running is
//   touched, and the gate and `Budgets.admit` refuse new subagent work. Then a `budget_stopped`
//   notice ("stopped at $X of $Y"), a pending `budget_raise` approval proposing each reached limit
//   raised to the larger of double the line and what was spent plus one more line, and a push. The row's `budget` word follows through the ledger.
// - A raise answered (`budget-raise-*` settled) re-reads that scope from its documents; accepted,
//   the scope stands below its line again and its children can be sent work again. A raise accepted
//   that leaves the scope at its line (more was spent than it added) is a new epoch at the line, so
//   the guard acts again: a new notice and a new raise.
// - A child that starts (`SubagentUpdated` working) is read as a scope of its own (its brief's).
//
// The guard acts on a scope at its line once per epoch (its count of accepted raises), and records
// the epoch in the book when it has; an evaluation that finds a scope at its line at an epoch not
// acted on reports it again, so a declared scope or a failed step is acted on by the next one.
// Each notice is written once under a request id keyed by the epoch, and the push goes out only
// when this guard wrote the notice: a crash between the two loses the push, never doubles it. Stops
// are idempotent.
//
// The ledger's changes are coalesced: while the guard works, the threads of every change that
// arrives are gathered, and the next pass evaluates them once, so a burst of responses costs one
// lineage read and one roll-up per scope, and the guard never falls behind the line.
//
// `boot` is the boot repair, run after the spend reconcile and before any repair that can start
// scheduling (pi-durable's `retryTask` resumes it: the parked approval waits and subagent tasks) and
// before the Harness resumes: it rebuilds the book from the documents and, for each scope at its
// line in `stop` mode, marks its runs aborted, withdraws their queued inputs and cancels the
// approvals they held, without starting scheduling, so a guard killed while stopping does not let
// a stopped child run again after the restart, and the gate has a full book from the first call.

import { badgeOf } from "@cairn/client-logic/Badge";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { Budget } from "@cairn/protocol/Spend";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Stream,
} from "effect";

import { BudgetSources } from "../brain/BudgetSources.ts";
import type { BudgetSourceError } from "../brain/BudgetSources.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { cutText, Notifier } from "../push/Notifier.ts";
import type { PushMessage } from "../push/Notifier.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetBook } from "./BudgetBook.ts";
import type {
  BudgetMode,
  Parents,
  ScopeLimit,
  ScopeStanding,
} from "./BudgetBook.ts";
import {
  Budgets,
  limitText,
  raisedBudget,
  stoppedText,
  warningText,
} from "./Budgets.ts";
import type { Transition } from "./Budgets.ts";
import { SpendLedger } from "./SpendLedger.ts";
import type { SpendLedgerError } from "./SpendLedger.ts";

/** The prefix of the request id a raise's approval carries. */
const RAISE_PREFIX = "budget-raise-";

/** How long a push's title and body may be. */
const TITLE_LIMIT = 80;

const BODY_LIMIT = 240;

/** The request id of a scope's notice of `reason` at `epoch`. */
export const noticeIdOf = (reason: "warning" | "stopped", epoch: number) =>
  `budget-${reason}-${epoch}`;

/** Every thread under `root` by `parents`, `root` first; a cycle is cut where it closes. */
export const membersOf = (
  root: ThreadId,
  parents: Parents
): ReadonlyArray<ThreadId> => {
  const children = new Map<ThreadId, Array<ThreadId>>();

  for (const [child, parent] of parents) {
    const list = children.get(parent) ?? [];

    list.push(child);
    children.set(parent, list);
  }

  const seen = new Set<ThreadId>([root]);
  const order = [root];

  // The loop reaches what it appends: an array iterator reads the length at each step.
  for (const node of order) {
    for (const child of children.get(node) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        order.push(child);
      }
    }
  }

  return order;
};

/** What the guard does next for one event: evaluate threads, or re-read one scope. */
export type Work =
  | { readonly kind: "evaluate"; readonly threads: ReadonlyArray<ThreadId> }
  | { readonly kind: "refresh"; readonly threadId: ThreadId };

/**
 * One pass over a batch of work: each scope to re-read once, then every thread to evaluate,
 * together.
 */
export const coalesce = (batch: ReadonlyArray<Work>) => {
  const refresh = new Set<ThreadId>();
  const evaluate = new Set<ThreadId>();

  for (const work of batch) {
    if (work.kind === "refresh") {
      refresh.add(work.threadId);
    } else {
      for (const threadId of work.threads) {
        evaluate.add(threadId);
      }
    }
  }

  return { refresh: [...refresh], evaluate: [...evaluate] };
};

/** The work an event asks for, if any. */
const workOf = (event: HarnessEvent): Option.Option<Work> => {
  if (
    Predicate.isTagged(event, "RuntimeRequestUpdated") &&
    event.id.startsWith(RAISE_PREFIX) &&
    event.status !== "pending"
  ) {
    return Option.some({ kind: "refresh", threadId: event.threadId });
  }

  return Predicate.isTagged(event, "SubagentUpdated") &&
    event.status === "working"
    ? Option.some({ kind: "refresh", threadId: event.child })
    : Option.none();
};

/** Acts on budgets crossing their lines. */
export class BudgetGuard extends Context.Service<
  BudgetGuard,
  {
    /** The boot repair (module header). Logs its failures; never fails boot. */
    readonly boot: Effect.Effect<void>;
    /** Acts on scopes whose state moved; `live` stops through the seam, otherwise it halts. */
    act(
      transitions: ReadonlyArray<Transition>,
      live: boolean
    ): Effect.Effect<void>;
    /**
     * Gives `threadId`'s subtree a budget of its own (`Budgets.declare`, a goal's) and acts at once
     * on where it stands: a scope declared already past its line is stopped and told so.
     */
    declare(
      threadId: ThreadId,
      budget: Budget,
      mode: BudgetMode
    ): Effect.Effect<void, BudgetSourceError | SpendLedgerError>;
  }
>()("cairn/server/usage/BudgetGuard") {
  /**
   * The guard and its fiber, for the layer's lifetime. Needs `Budgets`, `BudgetBook`,
   * `BudgetSources`, `SpendLedger`, `HarnessSeam`, `Notifier` and `ThreadRows`.
   */
  static readonly layerNoDeps = Layer.effect(
    BudgetGuard,
    Effect.gen(function* () {
      const budgets = yield* Budgets;
      const book = yield* BudgetBook;
      const sources = yield* BudgetSources;
      const ledger = yield* SpendLedger;
      const seam = yield* HarnessSeam;
      const notifier = yield* Notifier;
      const threadRows = yield* ThreadRows;

      const badge = threadRows.listLive.pipe(
        Effect.map((rows) => badgeOf(rows.map((row) => row.shell))),
        Effect.orElseSucceed(() => 0)
      );

      const push = Effect.fnUntraced(function* (
        threadId: ThreadId,
        body: string
      ) {
        const row = yield* threadRows
          .get(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));

        const title = Option.match(row, {
          onNone: () => "Budget",
          onSome: (found) => found.shell.title,
        });

        const message: PushMessage = {
          title: cutText(title, TITLE_LIMIT),
          body: cutText(body, BODY_LIMIT),
          tag: `budget:${threadId}`,
          url: `/t/${threadId}`,
          badge: yield* badge,
        };

        yield* notifier.sendToAll(message);
      });

      /** Writes one notice, and pushes it when this call wrote it. */
      const notify = Effect.fnUntraced(function* (
        limit: ScopeLimit,
        reason: "warning" | "stopped",
        text: string
      ) {
        const wrote = yield* sources.notice(
          limit.threadId,
          noticeIdOf(reason, limit.epoch),
          {
            reason: reason === "warning" ? "budget_warning" : "budget_stopped",
            text,
          }
        );

        if (wrote) {
          yield* push(limit.threadId, text);
        }
      });

      /** Stops every thread of a scope, in parallel; a thread that cannot be stopped is logged. */
      const stopAll = Effect.fnUntraced(function* (
        members: ReadonlyArray<ThreadId>
      ) {
        yield* Effect.forEach(
          members,
          (threadId) =>
            seam.stop(threadId, { clearQueue: true, subagents: "keep" }).pipe(
              Effect.catchTag("HarnessError", (failure) =>
                Effect.logWarning("budget stop did not reach a thread").pipe(
                  Effect.annotateLogs({
                    event: "budget_stop_failed",
                    threadId,
                    reason: failure.reason,
                  })
                )
              )
            ),
          { concurrency: "unbounded", discard: true }
        );
      });

      const reached = Effect.fnUntraced(function* (
        limit: ScopeLimit,
        standing: ScopeStanding,
        live: boolean
      ) {
        const members = membersOf(limit.threadId, yield* book.parents);

        yield* Effect.logInfo("budget reached").pipe(
          Effect.annotateLogs({
            event: "budget_reached",
            threadId: limit.threadId,
            mode: limit.mode,
            epoch: limit.epoch,
            members: members.length,
            listMicros: standing.spent.listMicros,
            tokens: standing.spent.tokens,
          })
        );

        if (limit.mode === "stop") {
          if (live) {
            yield* stopAll(members);
          } else {
            const marked = yield* sources.halt(members);

            yield* Effect.logInfo("budget scope halted at boot").pipe(
              Effect.annotateLogs({
                event: "budget_halted",
                threadId: limit.threadId,
                runs: marked,
              })
            );
          }
        }

        yield* notify(limit, "stopped", stoppedText(limit, standing));

        const to = raisedBudget(limit.budget, standing);

        const summary = `Raise the budget to ${limitText(
          to,
          Option.getOrElse(standing.reached, () => "tokens" as const)
        )}?`;

        yield* sources.askRaise(limit, to, summary);

        // Last, so a step that failed above is acted on again by the next evaluation.
        yield* book.markActed(limit.threadId, limit.epoch);
      });

      const act = Effect.fn("BudgetGuard.act")(
        function* (transitions: ReadonlyArray<Transition>, live: boolean) {
          for (const { limit, before, after } of transitions) {
            if (after.state === "exhausted") {
              yield* reached(limit, after, live);
            } else if (
              after.state === "warned" &&
              before.state !== "exhausted"
            ) {
              yield* notify(limit, "warning", warningText(limit, after));
            }
          }
        },
        Effect.catchTag("BudgetSourceError", (failure) =>
          Effect.logWarning("budget guard step failed").pipe(
            Effect.annotateLogs({
              event: "budget_guard_failed",
              operation: failure.operation,
              error: failure.message,
            })
          )
        )
      );

      const pass = (batch: ReadonlyArray<Work>) =>
        Effect.gen(function* () {
          const { refresh, evaluate } = coalesce(batch);

          for (const threadId of refresh) {
            yield* act(yield* budgets.refresh(threadId), true);
          }

          if (evaluate.length > 0) {
            yield* act(yield* budgets.evaluate(evaluate), true);
          }
        }).pipe(
          Effect.catchTags({
            SpendLedgerError: (failure) =>
              Effect.logWarning("budget evaluation failed").pipe(
                Effect.annotateLogs({
                  event: "budget_evaluate_failed",
                  error: failure.message,
                })
              ),
            BudgetSourceError: (failure) =>
              Effect.logWarning("budget scope not read").pipe(
                Effect.annotateLogs({
                  event: "budget_refresh_failed",
                  error: failure.message,
                })
              ),
          })
        );

      // The feed only gathers; the worker takes everything gathered at each pass (module header).
      const work = yield* Queue.unbounded<Work>();

      yield* Stream.merge(
        ledger.changes.pipe(
          Stream.map((threads): Work => ({ kind: "evaluate", threads }))
        ),
        seam.events.pipe(
          Stream.map(workOf),
          Stream.filter(Option.isSome),
          Stream.map((found) => found.value)
        )
      ).pipe(
        Stream.runForEach((item) => Queue.offer(work, item)),
        Effect.forkScoped
      );

      yield* Queue.takeAll(work).pipe(
        Effect.flatMap(pass),
        Effect.forever,
        Effect.forkScoped
      );

      const declare = Effect.fn("BudgetGuard.declare")(function* (
        threadId: ThreadId,
        budget: Budget,
        mode: BudgetMode
      ) {
        yield* act(yield* budgets.declare(threadId, budget, mode), true);
      });

      const boot = Effect.gen(function* () {
        const transitions = yield* budgets.load;

        yield* act(transitions, false);
      }).pipe(
        Effect.catchTags({
          SpendLedgerError: (failure) =>
            Effect.logWarning("budgets not loaded at boot").pipe(
              Effect.annotateLogs({
                event: "budgets_boot_failed",
                error: failure.message,
              })
            ),
          BudgetSourceError: (failure) =>
            Effect.logWarning("budgets not loaded at boot").pipe(
              Effect.annotateLogs({
                event: "budgets_boot_failed",
                error: failure.message,
              })
            ),
        }),
        Effect.withSpan("BudgetGuard.boot")
      );

      return BudgetGuard.of({ boot, act, declare });
    })
  );
}

/**
 * The boot repair `BootRepairs.ts` lists right after the spend reconcile, both ahead of
 * `cancel abandoned approvals` and every repair that retries parked tasks (module header).
 */
export const budgetBootRepair = BudgetGuard.use((guard) => guard.boot);
