// The boot sweep (ADR 0013): before the Harness resumes, every
// Executor request the brain recorded (`apr_` id on a `started` approval) and never finished is
// declined at Executor, so a late accept on the same grant can never run it (spike 3 showed one
// would). The tool's own rerun then finds `started` and reports "may have run".
//
// The sweep waits at most `SWEEP_WAIT` for Executor, so an Executor that is down never holds boot.
// A decline that could not be sent is retried in the background with a doubling delay (5 s to
// 60 s) until Executor's own approval window has passed, after which the request has expired there
// anyway. It runs only over pi-durable; the scripted harness records no Executor requests.
//
// Ported from cairn-v1, apps/server/src/Executor.ts at 1a5cd4a (`sweep`, `sweepRow`, `retryLater`),
// re-cut to the ledger's records: there is no Cairn-side state to settle, because the rerun of the
// tool settles it.

import { Context, Duration, Effect, Layer, Option, Schedule } from "effect";

import { Brain } from "../brain/Brain.ts";
import { unfinishedExecutorRequests } from "./ExecutorExtension.ts";
import type { UnfinishedRequest } from "./ExecutorExtension.ts";
import { ExecutorLink } from "./ExecutorLink.ts";
import { declineOutcome } from "./ExecutorReply.ts";

/** How long boot waits on Executor before it leaves the rest to the background. */
const SWEEP_WAIT = Duration.seconds(5);

/** Executor's approval window: past it, an unanswered request has expired there. */
const EXECUTOR_APPROVAL_WINDOW = Duration.minutes(10);

/** What the sweep did, for the log and the tests. */
export interface SweepReport {
  readonly found: number;
  readonly declined: number;
  /** Left to the background retry. */
  readonly deferred: number;
}

/** Declines the Executor requests a restart left unfinished. */
export class ExecutorSweep extends Context.Service<
  ExecutorSweep,
  {
    /** Declines the brain's unfinished requests; none without a pi-durable brain. Never fails. */
    readonly sweep: Effect.Effect<SweepReport>;
    /** Declines `requests`. Never fails. */
    declineEach(
      requests: ReadonlyArray<UnfinishedRequest>
    ): Effect.Effect<SweepReport>;
  }
>()("cairn/server/executor/ExecutorSweep") {
  /** Needs `ExecutorLink`; reads the records through `Brain` when the brain is pi-durable. */
  static readonly layerNoDeps = Layer.effect(
    ExecutorSweep,
    Effect.gen(function* () {
      const link = yield* ExecutorLink;
      const brain = yield* Effect.serviceOption(Brain);
      const layerScope = yield* Effect.scope;

      // Logged once, so a composition that lost `Brain` shows in the journal instead of every
      // boot quietly declining nothing (T61).
      yield* Effect.logInfo("Executor sweep mode").pipe(
        Effect.annotateLogs({
          event: "executor_sweep_mode",
          mode: Option.isSome(brain) ? "brain" : "none",
        })
      );

      // True once Executor answered the decline (whatever it said): nothing more to send.
      const decline = (request: UnfinishedRequest) =>
        link
          .call("resume", {
            requestId: request.requestId,
            response: { action: "decline" },
          })
          .pipe(
            Effect.map((reply) => declineOutcome(reply.structured)),
            Effect.tap((outcome) =>
              Effect.logInfo("Executor request declined at boot").pipe(
                Effect.annotateLogs({
                  event: "executor_sweep_declined",
                  requestId: request.requestId,
                  approvalId: request.approvalId,
                  outcome,
                })
              )
            ),
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          );

      const retryLater = (request: UnfinishedRequest) =>
        decline(request).pipe(
          Effect.filterOrFail((done) => done),
          Effect.retry(
            Schedule.min([
              Schedule.exponential(Duration.seconds(5)),
              Schedule.spaced(Duration.minutes(1)),
            ]).pipe(Schedule.upTo({ duration: EXECUTOR_APPROVAL_WINDOW }))
          ),
          Effect.ignore
        );

      const declineEach = Effect.fn("ExecutorSweep.declineEach")(function* (
        found: ReadonlyArray<UnfinishedRequest>
      ): Effect.fn.Return<SweepReport> {
        if (found.length === 0) {
          return { found: 0, declined: 0, deferred: 0 };
        }

        yield* Effect.logWarning(
          "Executor requests left by a restart are being declined"
        ).pipe(
          Effect.annotateLogs({
            event: "executor_sweep",
            count: found.length,
          })
        );

        const results = yield* Effect.forEach(
          found,
          (request) =>
            decline(request).pipe(
              Effect.timeoutOption(SWEEP_WAIT),
              Effect.map((done) => ({
                request,
                done: Option.getOrElse(done, () => false),
              }))
            ),
          { concurrency: "unbounded" }
        );

        const deferred = results.filter((result) => !result.done);

        for (const { request } of deferred) {
          yield* retryLater(request).pipe(Effect.forkIn(layerScope));
        }

        return {
          found: found.length,
          declined: found.length - deferred.length,
          deferred: deferred.length,
        };
      });

      const unfinished = Option.match(brain, {
        onNone: () => Effect.succeed<ReadonlyArray<UnfinishedRequest>>([]),
        onSome: (service) =>
          unfinishedExecutorRequests.pipe(
            Effect.provideService(Brain, service),
            Effect.tapError((failure) =>
              Effect.logWarning(
                "the Executor sweep could not read approvals"
              ).pipe(
                Effect.annotateLogs({
                  event: "executor_sweep_failed",
                  cause: failure.message,
                })
              )
            ),
            Effect.orElseSucceed((): ReadonlyArray<UnfinishedRequest> => [])
          ),
      });

      const sweep = Effect.flatMap(unfinished, declineEach).pipe(
        Effect.withSpan("ExecutorSweep.sweep")
      );

      return ExecutorSweep.of({ sweep, declineEach });
    })
  );
}

/**
 * The boot repair's effect. `BootRepairs.ts` lists it as
 * `bootRepair("executor-sweep", sweepUnfinishedExecutorRequests)`, before the parked approval waits
 * are retried.
 */
export const sweepUnfinishedExecutorRequests = ExecutorSweep.use(
  (sweeper) => sweeper.sweep
);
