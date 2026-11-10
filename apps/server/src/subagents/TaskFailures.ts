// One seam for an orchestration task whose phase throws (review finding O-3). pi-durable 1.5 ends a
// task whose phase throws `faulted`, for good, and only reports it (`task_faulted`, which
// `Brain.report` logs). Each of Cairn's orchestration tasks holds a promise to someone that such an
// end breaks silently: a Go'd brief's start (the parent was told "waiting for Go"), the tell of a
// brief that started nothing, a subagent's reporter (its result reaches the parent), a workflow's
// watcher (its node or run row ends) and its budget stopper (no node runs past the line).
//
// So every phase of those tasks runs through `failsVisibly`, as the judge run's does since I09: a
// throw that is not the task's abort is reported (`runtime.report`, logged by `Brain.report`), and
// one commit ends the task with what its `recover` writes, which leaves the failure where the row
// and the parent see it and the work recoverable (say, a failed settlement the parent reads, so it
// can send the child its work again). An abort, or a closing Harness, rethrows: the abort handler or
// the next boot owns it. A `recover` commit that throws too faults the task as before, and pi-durable
// reports that.
//
// Recovery happens inside the phase's invocation, so a crash before its commit reruns the phase,
// which judges again whether it throws.

import type {
  ConversationId,
  NextTaskState,
  PhaseHandler,
  Tx,
} from "@earendil-works/pi-durable";

import { errorText, isClosedError } from "../brain/Durable.ts";

/** What a recovery knows of the phase that threw. */
export interface FailedPhase<I, S> {
  readonly conversationId: ConversationId;
  readonly taskId: number;
  readonly input: I;
  /** The checkpoint the phase that threw ran from. */
  readonly checkpoint: S;
  /** The throw, in words. */
  readonly why: string;
  /** The Harness clock when it threw. */
  readonly at: number;
}

/** What a task writes when a phase threw, in the commit that ends it (or puts it to sleep). */
export type Recovery<I, S, R> = (
  tx: Tx,
  failed: FailedPhase<I, S>
) => Promise<NextTaskState<S, R>>;

/**
 * `phase`, ending in `recover`'s commit when it throws anything but the task's abort or a closing
 * Harness. The one place an orchestration task's throw is caught (O-3).
 */
export const failsVisibly =
  <I, S extends { phase: string }, R, H extends object>(
    recover: Recovery<I, S, R>
  ) =>
  <P extends S>(
    phase: PhaseHandler<I, P, S, R, H>
  ): PhaseHandler<I, P, S, R, H> =>
  async (task, runtime, context) => {
    try {
      await phase(task, runtime, context);
    } catch (error) {
      if (runtime.signal.aborted || isClosedError(error)) {
        throw error;
      }

      runtime.report(error);

      const failed: FailedPhase<I, S> = {
        conversationId: runtime.conversationId,
        taskId: Number(runtime.taskId),
        input: task.input,
        checkpoint: task.state.checkpoint,
        why: errorText(error),
        at: runtime.now(),
      };

      await runtime.commit(async (tx) => await recover(tx, failed), context);
    }
  };
