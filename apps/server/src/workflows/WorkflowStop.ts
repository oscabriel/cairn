// Stopping a workflow or one of its nodes (ADR 0012 as amended, workflows note W6), and the abort
// polling every node tool runs so a stop lands at once.
//
// - Whole workflow (`workflow.stop`). A `running` workflow's script call is aborted
//   (`abortTask` on its `codemode` task). The abort flows down to every node it owns; each node's
//   watcher records it `stopped`, the script call's watcher records the workflow `stopped` with
//   `partial: stopped`, and the launching thread's run goes on with the call's aborted result.
//   Settled results stay. An `approved` workflow (Go given, the `codemode` call not made yet) is
//   ended `stopped` in one commit, so `workflow_begin` and the gate refuse its script later. A
//   `proposed` one has not started: its launch card's Decline is the way to end it.
// - One node (`workflow.stopNode`). The node's own nested task is aborted (the row keeps its id).
//   The script's `await` rejects, the prelude turns that into `null` and the script goes on; the
//   watcher records the row `stopped` with a receipt of what its child used, so the stopped node's
//   spend still counts against the budget. A node is never restarted: a rerun is a new call, which
//   a journaled script cannot make.
// - Both are idempotent: a stop of an ended workflow or node changes nothing. pi-durable commits
//   the abort mark before it waits, so a `kill -9` after the mark still stops the task on the next
//   life, and nothing reruns (the probe's `mark-kill`).
// - Abort polling. `abortTask` waits for the aborted tool's invocation to end, so a node tool that
//   waits on something deaf to its signal (a role resolve, a judge's hold) keeps the stop pending.
//   Every such wait in a node tool goes through `untilStopped`, and each tool checks
//   `throwIfStopped` between its steps.
//
// The RPC shape (a stop answers once the stop is marked, and says `not-running` rather than
// failing for work that is not running) follows t3code's `stopWorkflow`
// (github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ThreadManagementService.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92). Ideas only; the code is Cairn's.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software. THE
// SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import {
  Conflict,
  Internal,
  NotFound,
  Unavailable,
} from "@cairn/protocol/Errors";
import type { ThreadId } from "@cairn/protocol/Ids";
import type {
  WorkflowState,
  WorkflowStopInput,
  WorkflowStopNodeInput,
} from "@cairn/protocol/Workflows";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { Context, Duration, Effect, Exit, Layer, Option } from "effect";

import { Brain } from "../brain/Brain.ts";
import type { BrainUnavailable } from "../brain/Brain.ts";
import { ThreadReceipt } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import { emit } from "../brain/Events.ts";
import { conversationOf, taskOf } from "../subagents/Delivery.ts";
import {
  isNodeEnded,
  isWorkflowEnded,
  resultRefOf,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";

// Abort polling.

/** Rejects with the signal's reason when it has aborted; a step boundary in a node tool. */
export const throwIfStopped = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

/**
 * Settles as `work` does, or rejects with the signal's reason as soon as it aborts. `work` itself
 * is not cancelled: what it does after the stop cannot commit (pi-durable rejects a run
 * invocation's commit once its task carries an abort mark), and a late rejection of it is held by
 * the abandoned wait, never left unhandled.
 */
export const untilStopped = async <A>(
  signal: AbortSignal | undefined,
  work: Promise<A>
): Promise<A> => {
  if (signal === undefined) {
    return await work;
  }

  // The signal interrupts the wait (and only the wait) the moment it aborts.
  const exit = await Effect.runPromiseExit(
    Effect.promise(async () => await work),
    { signal }
  );

  throwIfStopped(signal);

  // Settled before any stop: its value, or its own rejection again.
  return Exit.isSuccess(exit) ? exit.value : await work;
};

// Stopping, over a pi-durable Harness.

/** What a stop did. */
export type StopOutcome =
  /** The workflow, or the node, is not in the thread's ledger. */
  | { readonly kind: "not_found"; readonly resource: "workflow" | "node" }
  /** The workflow is `proposed`: nothing started, its launch card is still open. */
  | { readonly kind: "not_started" }
  /** It had ended already; nothing changed. */
  | { readonly kind: "ended"; readonly state: string }
  /** An `approved` workflow ended `stopped` before its script ran. */
  | { readonly kind: "stopped_before_start" }
  /**
   * The task was aborted: `terminal` when pi-durable saw it end, `marked` when the mark is
   * committed and the task ends on its own (its abort handler runs after its owned work ended).
   */
  | {
      readonly kind: "aborted";
      readonly taskId: number;
      readonly result: "marked" | "terminal";
    };

/** The Harness calls a stop makes. */
export type StopHarness = Pick<Harness, "commit" | "abortTask" | "snapshot">;

/** What the deciding commit found: an outcome, or a task to abort outside the commit. */
type Decision =
  | { readonly kind: "done"; readonly outcome: StopOutcome }
  | { readonly kind: "abort"; readonly taskId: number };

const done = (outcome: StopOutcome): Decision => ({ kind: "done", outcome });

/** Aborts the decided task outside any commit (spec 12: never wait inside one). */
const settle = async (
  harness: StopHarness,
  decision: Decision,
  context: ChordContext
): Promise<StopOutcome> => {
  if (decision.kind === "done") {
    return decision.outcome;
  }

  const result = await harness.abortTask(taskOf(decision.taskId), context);

  return { kind: "aborted", taskId: decision.taskId, result };
};

/**
 * Stops a whole workflow of the thread in `conversation`. Decides in one commit (an `approved` row
 * ends there), then aborts a running one's script call outside it.
 */
export const stopWorkflowIn = async (
  harness: StopHarness,
  conversation: ConversationId,
  workflowId: string,
  now: number,
  context: ChordContext
): Promise<StopOutcome> => {
  const decision = await harness.commit(async (tx): Promise<Decision> => {
    const ledger = await tx.doc(WorkflowsDoc, conversation);
    const row = ledger.items[workflowId];

    if (row === undefined) {
      return done({ kind: "not_found", resource: "workflow" });
    }

    if (isWorkflowEnded(row.state)) {
      return done({ kind: "ended", state: row.state });
    }

    if (row.state === "proposed") {
      return done({ kind: "not_started" });
    }

    if (row.state === "running" && row.codemodeTaskId !== null) {
      return { kind: "abort", taskId: row.codemodeTaskId };
    }

    // Approved: Go was given and nothing runs yet. Ended here, `workflow_begin` refuses it.
    const stopped: WorkflowState = "stopped";

    row.state = stopped;
    row.outcome = { kind: "partial", reason: "stopped" };
    row.endedAt = now;
    row.result =
      row.codemodeTaskId === null ? null : resultRefOf(row.codemodeTaskId);

    await emit(tx, {
      name: "workflow.finished",
      data: {
        workflowId: row.id,
        state: row.state,
        outcome: { kind: "partial", reason: "stopped" },
      },
      at: now,
      context: Option.none(),
    });

    return done({ kind: "stopped_before_start" });
  }, context);

  return await settle(harness, decision, context);
};

/** Stops one node of a workflow of the thread in `conversation`: its nested task is aborted. */
export const stopNodeIn = async (
  harness: StopHarness,
  conversation: ConversationId,
  workflowId: string,
  nodeId: string,
  context: ChordContext
): Promise<StopOutcome> => {
  const decision = await harness.commit(async (tx): Promise<Decision> => {
    const ledger = await tx.doc(WorkflowsDoc, conversation);
    const row = ledger.items[workflowId];

    if (row === undefined) {
      return done({ kind: "not_found", resource: "workflow" });
    }

    const node = row.nodes[nodeId];

    if (node === undefined) {
      return done({ kind: "not_found", resource: "node" });
    }

    if (isNodeEnded(node.state) || node.nestedTaskId === null) {
      return done({ kind: "ended", state: node.state });
    }

    return { kind: "abort", taskId: node.nestedTaskId };
  }, context);

  return await settle(harness, decision, context);
};

// The service behind the RPCs.

/**
 * How long a stop's answer waits for the aborted task to end. The mark is committed before the
 * wait, so a stop that outlasts it still lands; the answer just does not wait for it.
 */
export const STOP_ANSWER_WAIT = Duration.seconds(10);

/** The public errors a stop answers with (the RPCs' `Change` union). */
export type StopError = Unavailable | Internal | NotFound | Conflict;

const brainDown = (failure: BrainUnavailable) =>
  new Unavailable({ message: failure.message });

/** A failed pi-durable call as a public error: the brain closing is `Unavailable`, else logged. */
const fromDurable =
  (operation: string) =>
  (failure: DurableCallError): Effect.Effect<never, Unavailable | Internal> =>
    failure.closed
      ? Effect.fail(
          new Unavailable({
            message:
              "The brain is closing, so the stop was not made. Try again in a moment.",
          })
        )
      : Effect.logError("workflow stop failed").pipe(
          Effect.annotateLogs({
            event: "workflow_stop_failed",
            operation,
            error: failure.message,
          }),
          Effect.andThen(
            Effect.fail(
              new Internal({
                message:
                  "Stopping the workflow failed inside the brain. Retry; check the brain's log (workflow_stop_failed) if it repeats.",
              })
            )
          )
        );

/** The public answer to a stop's outcome: success, or the error that names why nothing changed. */
const answerOf = (
  outcome: StopOutcome,
  input: WorkflowStopInput | WorkflowStopNodeInput
): Effect.Effect<void, StopError> => {
  if (outcome.kind === "not_found") {
    const id =
      outcome.resource === "node" && "nodeId" in input
        ? input.nodeId
        : input.workflowId;

    return Effect.fail(
      new NotFound({
        message: `${outcome.resource === "node" ? "Node" : "Workflow"} ${id} is not in thread ${input.threadId}'s ledger.`,
        resource: outcome.resource,
        id,
      })
    );
  }

  if (outcome.kind === "not_started") {
    return Effect.fail(
      new Conflict({
        message: `Workflow ${input.workflowId} has not started: its launch is still waiting for an answer. Decline it on the launch card instead.`,
        reason: "stale_state",
      })
    );
  }

  // Stopped, being stopped, or ended already: a stop is idempotent.
  return Effect.void;
};

/** Whole-workflow and single-node stop, by thread. */
export class WorkflowStops extends Context.Service<
  WorkflowStops,
  {
    /** `workflow.stop`: stops a whole workflow; settled results stay. */
    stop(input: WorkflowStopInput): Effect.Effect<void, StopError>;
    /** `workflow.stopNode`: stops one node; the script sees `null` for it. */
    stopNode(input: WorkflowStopNodeInput): Effect.Effect<void, StopError>;
  }
>()("cairn/server/workflows/WorkflowStops") {
  /**
   * Over the open Harness `harness` gives. `now` is the Harness clock, for the commit that ends an
   * approved workflow.
   */
  static readonly make = (
    harness: Effect.Effect<StopHarness, BrainUnavailable>,
    now: () => number
  ) => {
    const conversationOfThread = Effect.fn("WorkflowStops.conversation")(
      function* (open: StopHarness, threadId: ThreadId) {
        const receipt = yield* durable(
          "receipt.read",
          async (context) =>
            await open.snapshot(ThreadReceipt, threadId, context)
        ).pipe(Effect.catchTag("DurableCallError", fromDurable("receipt")));

        if (receipt === undefined || receipt.conversationId < 1) {
          return yield* new NotFound({
            message: `Thread ${threadId} does not exist in the brain.`,
            resource: "thread",
            id: threadId,
          });
        }

        return conversationOf(receipt.conversationId);
      }
    );

    /** Runs one stop; the answer waits at most `STOP_ANSWER_WAIT` for the task to end. */
    const run = Effect.fn("WorkflowStops.run")(function* (
      input: WorkflowStopInput | WorkflowStopNodeInput,
      operation: string,
      stopIn: (
        open: StopHarness,
        conversation: ConversationId,
        context: ChordContext
      ) => Promise<StopOutcome>
    ) {
      const open = yield* harness.pipe(Effect.mapError(brainDown));
      const conversation = yield* conversationOfThread(open, input.threadId);

      const outcome = yield* durable(
        operation,
        async (context) => await stopIn(open, conversation, context)
      ).pipe(
        Effect.catchTag("DurableCallError", fromDurable(operation)),
        Effect.timeoutOption(STOP_ANSWER_WAIT)
      );

      // Timed out: the mark is committed (pi-durable commits it before it waits), and the task
      // ends on its own.
      if (Option.isNone(outcome)) {
        yield* Effect.logInfo("workflow stop still ending").pipe(
          Effect.annotateLogs({
            event: "workflow_stop_pending",
            threadId: input.threadId,
            workflowId: input.workflowId,
          })
        );

        return;
      }

      yield* answerOf(outcome.value, input);
    });

    return WorkflowStops.of({
      stop: (input) =>
        run(
          input,
          "workflow.stop",
          async (open, conversation, context) =>
            await stopWorkflowIn(
              open,
              conversation,
              input.workflowId,
              now(),
              context
            )
        ),
      stopNode: (input) =>
        run(
          input,
          "workflow.stopNode",
          async (open, conversation, context) =>
            await stopNodeIn(
              open,
              conversation,
              input.workflowId,
              input.nodeId,
              context
            )
        ),
    });
  };

  /** Over the root's `Brain`. */
  static readonly layer = Layer.effect(
    WorkflowStops,
    Brain.useSync((brain) =>
      WorkflowStops.make(
        Effect.map(brain.session, (session) => session.harness),
        () => brain.now()
      )
    )
  );

  /** For brains with no pi-durable Harness (the scripted dev brain), which run no workflows. */
  static readonly layerOff = Layer.succeed(
    WorkflowStops,
    WorkflowStops.of({
      stop: (input) =>
        Effect.fail(
          new NotFound({
            message: `Workflow ${input.workflowId} is not in thread ${input.threadId}'s ledger: this brain runs no workflows.`,
            resource: "workflow",
            id: input.workflowId,
          })
        ),
      stopNode: (input) =>
        Effect.fail(
          new NotFound({
            message: `Workflow ${input.workflowId} is not in thread ${input.threadId}'s ledger: this brain runs no workflows.`,
            resource: "workflow",
            id: input.workflowId,
          })
        ),
    })
  );
}
