// The brain's boot order (plan section 1, "Boot and shutdown"). The layers below `Boot` already did
// steps 1 to 4 by the time it runs: `cairn.sqlite` is open and migrated, the brain store was backed
// up if pi-durable changed, the models are registered, the extension set is installed and the
// Harness is open but not resumed, and the shell projector has subscribed to the harness events.
// Boot then:
//
// 5. runs the boot repairs in their listed order (`BootRepairs.ts`);
// 6. resumes the harness, then reconciles every thread row from `inspect()` (the feed never
//    replays across a restart, so this is how a lost event is repaired);
// 7. marks the brain ready: `/_cairn/health` says so and `/ws` stops answering 503.
//
// Each step is logged with its milliseconds (`boot_step`), and the last line is `ready` with the
// total, which deploy scripts and judges wait for. A step still running after `BOOT_SLOW_AFTER` logs
// `boot_slow` naming it, so a boot that never ends says where it stopped (T6). The listener answers static files from the first
// moment; only `/ws` waits for step 7.
import { Clock, Duration, Effect, Fiber, Layer } from "effect";

import type { BootRepair } from "./BootRepairs.ts";
import { HarnessSeam } from "./brain/HarnessSeam.ts";
import { Health } from "./http/Health.ts";
import { ShellProjector } from "./shell/ShellProjector.ts";
import type { ReconcileReport } from "./shell/ShellProjector.ts";

/** What boot runs that the composition root chooses: the repairs and how the harness resumes. */
export interface BootSteps<Repairs, Resume> {
  /** The boot repairs, in order (`runBootRepairs`). Failures are logged by each repair. */
  readonly repairs: Effect.Effect<void, never, Repairs>;
  /** Starts the harness's work: `HarnessBoot.resume` (pi-durable does not resume on open). */
  readonly resume: Effect.Effect<void, never, Resume>;
}

/** How long each step took, in milliseconds, and what the reconcile changed. */
export interface BootReport {
  readonly repairsMs: number;
  readonly resumeMs: number;
  readonly reconcileMs: number;
  readonly totalMs: number;
  readonly reconcile: ReconcileReport;
}

/** How long a boot step runs before it is logged as slow. */
export const BOOT_SLOW_AFTER = Duration.seconds(30);

const timed = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    const watchdog = yield* Effect.logWarning(`boot ${step} is slow`).pipe(
      Effect.annotateLogs({
        event: "boot_slow",
        step,
        afterMs: Duration.toMillis(BOOT_SLOW_AFTER),
      }),
      Effect.delay(BOOT_SLOW_AFTER),
      Effect.forkChild
    );

    const value = yield* effect.pipe(
      Effect.ensuring(Fiber.interrupt(watchdog))
    );

    const ms = (yield* Clock.currentTimeMillis) - started;

    yield* Effect.logInfo(`boot ${step} ${ms}`).pipe(
      Effect.annotateLogs({ event: "boot_step", step, ms })
    );

    return [value, ms] as const;
  });

/**
 * Runs steps 5 to 7 and returns their timings. The brain is ready when this returns, and not
 * before: a step that never ends keeps `/ws` answering 503.
 */
export const runBoot = Effect.fn("Boot.run")(function* <Repairs, Resume>(
  steps: BootSteps<Repairs, Resume>
) {
  const health = yield* Health;
  const projector = yield* ShellProjector;
  const started = yield* Clock.currentTimeMillis;

  yield* Effect.logInfo("boot").pipe(
    Effect.annotateLogs({ event: "boot_started" })
  );

  const [, repairsMs] = yield* timed("repairs", steps.repairs);
  const [, resumeMs] = yield* timed("resume", steps.resume);

  const [reconcile, reconcileMs] = yield* timed(
    "reconcile",
    projector.reconcile
  );

  yield* health.markReady;

  const totalMs = (yield* Clock.currentTimeMillis) - started;

  yield* Effect.logInfo("ready").pipe(
    Effect.annotateLogs({
      event: "ready",
      ms: totalMs,
      threads: reconcile.threads,
      live: reconcile.live,
      patched: reconcile.patched,
    })
  );

  return { repairsMs, resumeMs, reconcileMs, totalMs, reconcile };
});

/**
 * Boot as a layer: built beside the HTTP listener (`Layer.mergeAll`), it finishes when the brain is
 * ready. Needs `Health`, the `ShellProjector` (built before it, so its subscription precedes the
 * resume) and whatever the steps need.
 */
export const BootLayer = <Repairs, Resume>(steps: BootSteps<Repairs, Resume>) =>
  Layer.effectDiscard(Effect.asVoid(runBoot(steps)));

/**
 * The boot repair for approval waits the crash-loop guard parked: a task that waits on a pending
 * approval commits nothing while it waits, so five crashes park it, and it must run again to keep
 * waiting (spikes/4-approvals). Every parked task of a thread with a pending approval is retried.
 */
export const retryParkedApprovalWaits: BootRepair<HarnessSeam> = {
  name: "retry-parked-approval-waits",
  repair: Effect.gen(function* () {
    const harness = yield* HarnessSeam;
    const live = yield* harness.inspect;
    let retried = 0;

    for (const state of live) {
      if (state.pendingApprovals.length > 0) {
        for (const taskId of state.parkedTaskIds) {
          yield* harness.retry(taskId).pipe(
            Effect.tapError((failure) =>
              Effect.logWarning("parked approval wait was not retried").pipe(
                Effect.annotateLogs({
                  event: "boot_retry_failed",
                  threadId: state.threadId,
                  taskId,
                  error: failure.message,
                })
              )
            ),
            Effect.ignore
          );
          retried += 1;
        }
      }
    }

    yield* Effect.logInfo(`retried ${retried} parked approval waits`).pipe(
      Effect.annotateLogs({ event: "boot_retried_approvals", retried })
    );
  }).pipe(
    Effect.catchTag("HarnessError", (failure) =>
      Effect.logError("boot repair failed").pipe(
        Effect.annotateLogs({
          event: "boot_repair_failed",
          repair: "retry-parked-approval-waits",
          cause: failure.message,
        })
      )
    )
  ),
};
