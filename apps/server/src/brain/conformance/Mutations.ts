// Deliberately broken harnesses, to prove the conformance suite can fail (ADR 0024's gate): each
// mutation breaks one promise of the seam, and wrapped around either implementation it must make
// scenarios fail.
//
// - drop_run_terminal: the completion signal never arrives.
// - reorder_events: every two events swap places.
// - lose_queued_input: every second input on a thread is acknowledged but never admitted.
// - skip_snapshot: a thread stream starts with ops instead of its snapshot.

import { SubmissionId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option, Predicate, Stream } from "effect";

import type { HarnessEvent, HarnessSeam } from "../HarnessSeam.ts";

/** One way to break the seam. */
export type Mutation =
  | "drop_run_terminal"
  | "reorder_events"
  | "lose_queued_input"
  | "skip_snapshot";

/** Every mutation. */
export const MUTATIONS: ReadonlyArray<Mutation> = [
  "drop_run_terminal",
  "reorder_events",
  "lose_queued_input",
  "skip_snapshot",
];

const isRunTerminal = Predicate.isTagged("RunTerminal");

/** Swaps each pair of events: a, b, c, d becomes b, a, d, c; an odd one out waits for its pair. */
const swapPairs = (events: Stream.Stream<HarnessEvent>) =>
  events.pipe(
    Stream.mapAccum(
      () => Option.none<HarnessEvent>(),
      (held, event) =>
        Option.match(held, {
          onNone: () => [Option.some(event), []] as const,
          onSome: (first) =>
            [Option.none<HarnessEvent>(), [event, first]] as const,
        })
    )
  );

/** What the mutations count across the instances of one run. */
export interface MutationState {
  /** Inputs seen per thread. */
  readonly inputs: Map<ThreadId, number>;
}

/** `seam` with `mutations` applied; `state` lives as long as the scenario. */
export const breakSeam = (
  seam: HarnessSeam["Service"],
  mutations: ReadonlySet<Mutation>,
  state: MutationState
): HarnessSeam["Service"] => {
  const { inputs } = state;

  let { events } = seam;

  if (mutations.has("drop_run_terminal")) {
    events = events.pipe(Stream.filter((event) => !isRunTerminal(event)));
  }

  if (mutations.has("reorder_events")) {
    events = swapPairs(events);
  }

  const submit: HarnessSeam["Service"]["submit"] = (threadId, input) => {
    const count = (inputs.get(threadId) ?? 0) + 1;

    inputs.set(threadId, count);

    if (mutations.has("lose_queued_input") && count % 2 === 0) {
      return Effect.succeed({
        submissionId: SubmissionId.make(1),
        status: "queued" as const,
      });
    }

    return seam.submit(threadId, input);
  };

  const watch: HarnessSeam["Service"]["watch"] = (threadId) =>
    mutations.has("skip_snapshot")
      ? seam.watch(threadId).pipe(Stream.drop(1))
      : seam.watch(threadId);

  return { ...seam, events, submit, watch };
};
