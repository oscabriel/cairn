// Deliberately broken harnesses, to prove the conformance suite can fail (ADR 0024's gate): each
// mutation breaks one promise of the seam, and wrapped around either implementation it must make
// scenarios fail.
//
// - drop_run_terminal: the completion signal never arrives.
// - reorder_events: every two events swap places.
// - lose_queued_input: every second input on a thread is acknowledged but never admitted.
// - skip_snapshot: a thread stream starts with ops instead of its snapshot.
//
// The subagent mutations break delivery inside the harness, where no seam wrapper reaches, so
// they travel to the target as SubagentFaults (see that module): drop_note, deliver_twice,
// wake_stopped_parent, route_approval_to_parent. Each must fail at least two subagent scenarios.
//
// The read mutations break one of the seam's reads, and each must fail at least two of the
// scenarios that make that read (`READ_LINES`):
//
// - drop_history_entry: a history page loses its newest entry.
// - hide_pending_record: `inspect` leaves out each thread's oldest pending record.
// - read_neighbour_entry: `entry` and `entryImage` read the entry before the one asked for.

import { SubmissionId } from "@cairn/protocol/Ids";
import type { EntryId, ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option, Predicate, Stream } from "effect";

import type { HarnessEvent, HarnessSeam } from "../HarnessSeam.ts";
import type { SubagentFaultSet } from "../SubagentFaults.ts";
import type { TranscriptLine } from "./Transcript.ts";

/** One way to break the seam from outside. */
export type SeamMutation =
  | "drop_run_terminal"
  | "reorder_events"
  | "lose_queued_input"
  | "skip_snapshot";

/** One way to break subagent delivery from inside the harness. */
export type SubagentMutation =
  | "drop_note"
  | "deliver_twice"
  | "wake_stopped_parent"
  | "route_approval_to_parent";

/** One way to break the seam's history, entry or inspection reads from outside. */
export type ReadMutation =
  | "drop_history_entry"
  | "hide_pending_record"
  | "read_neighbour_entry";

/** Any mutation. */
export type Mutation = SeamMutation | SubagentMutation | ReadMutation;

/** Every seam mutation. */
export const MUTATIONS: ReadonlyArray<SeamMutation> = [
  "drop_run_terminal",
  "reorder_events",
  "lose_queued_input",
  "skip_snapshot",
];

/** Every subagent mutation. */
export const SUBAGENT_MUTATIONS: ReadonlyArray<SubagentMutation> = [
  "drop_note",
  "deliver_twice",
  "wake_stopped_parent",
  "route_approval_to_parent",
];

/** Every read mutation. */
export const READ_MUTATIONS: ReadonlyArray<ReadMutation> = [
  "drop_history_entry",
  "hide_pending_record",
  "read_neighbour_entry",
];

/** The lines whose scenarios a read mutation is judged on: those that make the read it breaks. */
export const READ_LINES: Readonly<
  Record<ReadMutation, ReadonlyArray<TranscriptLine["type"]>>
> = {
  drop_history_entry: ["expect_history"],
  hide_pending_record: ["expect_inspect"],
  read_neighbour_entry: ["expect_entry", "expect_entry_image"],
};

/** The delivery faults a set of mutations plants. */
export const faultsOf = (
  mutations: ReadonlySet<Mutation>
): SubagentFaultSet => ({
  dropNote: mutations.has("drop_note"),
  deliverTwice: mutations.has("deliver_twice"),
  // A kill judge's fault: without a crash it delivers once, so no scenario can catch it.
  freshIds: false,
  // The kill judge's steer control; a mutation of its own is not needed for the scenarios.
  seamOwnIds: false,
  wakeStoppedParent: mutations.has("wake_stopped_parent"),
  routeApprovalToParent: mutations.has("route_approval_to_parent"),
  // The kill judge's question control: without a crash it routes once.
  freshQuestionIds: false,
});

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

  const history: HarnessSeam["Service"]["history"] = (threadId, query) =>
    mutations.has("drop_history_entry")
      ? Effect.map(seam.history(threadId, query), (page) => ({
          ...page,
          entries: page.entries.slice(0, -1),
        }))
      : seam.history(threadId, query);

  const inspect: HarnessSeam["Service"]["inspect"] = mutations.has(
    "hide_pending_record"
  )
    ? Effect.map(seam.inspect, (live) =>
        live.map((thread) => ({
          ...thread,
          pendingApprovals: thread.pendingApprovals
            .toSorted((a, b) => a.askedAt - b.askedAt)
            .slice(1),
        }))
      )
    : seam.inspect;

  // The entry just before `entryId`, as one history page of one entry finds it; the entry itself
  // when it is the first.
  const neighbour = (threadId: ThreadId, entryId: EntryId) =>
    Effect.map(seam.history(threadId, { before: entryId, limit: 1 }), (page) =>
      Option.getOrElse(
        Option.map(
          Option.fromUndefinedOr(page.entries[0]),
          (entry) => entry.id
        ),
        () => entryId
      )
    );

  const entry: HarnessSeam["Service"]["entry"] = (threadId, entryId) =>
    mutations.has("read_neighbour_entry")
      ? Effect.flatMap(neighbour(threadId, entryId), (read) =>
          seam.entry(threadId, read)
        )
      : seam.entry(threadId, entryId);

  const entryImage: HarnessSeam["Service"]["entryImage"] = (
    threadId,
    entryId,
    index
  ) =>
    mutations.has("read_neighbour_entry")
      ? Effect.flatMap(neighbour(threadId, entryId), (read) =>
          seam.entryImage(threadId, read, index)
        )
      : seam.entryImage(threadId, entryId, index);

  return {
    ...seam,
    events,
    submit,
    watch,
    history,
    entry,
    entryImage,
    inspect,
  };
};
