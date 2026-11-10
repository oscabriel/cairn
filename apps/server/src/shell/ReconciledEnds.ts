// Run ends the boot reconcile dated itself (server-edges.V5). A run that ended while nothing
// watched it (its end event was lost to a crash) and left no time behind ends at the reconcile's
// own `now`, so the time from its start to that end counts the downtime in and says nothing about
// how long it ran. The projector records each such end here before it commits it; the notifier
// asks before it words a run end's push, and never words one of these as "Finished after <time>".
//
// In memory, for the life of the process: the notifier reads each end soon after the reconcile
// commits it and claims its push key then (`notified_runs`), so only a second crash in between
// loses the record. One end per thread is kept, the newest; an older one is never pushed again.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Context, DateTime, Effect, Layer } from "effect";

/** The run ends the boot reconcile dated itself, newest per thread. */
export class ReconciledEnds extends Context.Service<
  ReconciledEnds,
  {
    /** The boot reconcile ended `threadId`'s run at `endedAt`, its own time. */
    record(threadId: ThreadId, endedAt: DateTime.Utc): Effect.Effect<void>;
    /** Whether `threadId`'s run end at `endedAt` is one the boot reconcile dated itself. */
    has(threadId: ThreadId, endedAt: DateTime.Utc): Effect.Effect<boolean>;
  }
>()("cairn/server/shell/ReconciledEnds") {
  static readonly layer = Layer.sync(ReconciledEnds, () => {
    const ends = new Map<ThreadId, number>();

    return ReconciledEnds.of({
      record: (threadId, endedAt) =>
        Effect.sync(() => {
          ends.set(threadId, DateTime.toEpochMillis(endedAt));
        }),
      has: (threadId, endedAt) =>
        Effect.sync(
          () => ends.get(threadId) === DateTime.toEpochMillis(endedAt)
        ),
    });
  });
}
