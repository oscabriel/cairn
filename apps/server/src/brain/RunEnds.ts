// When a thread's run ended, as the harness committed it, for the boot reconcile. A run whose end a
// crash cut off from the shell row (a kill between the harness's commit and the projector's flush)
// is ended by the reconcile; dated by its own end, the row reads as the projector would have
// written it, so a later boot never reads the turn's end checkpoint, captured after that end, as
// one the brain missed (the checkpoint repair's `missedRunEnd`). A reference whose default knows
// no end: a harness that keeps no run end times (the scripted harness, test fakes) leaves the
// reconcile dating the end by its own time, as before. `PiDurableHarness` provides the real one.

import type { RunId, ThreadId } from "@cairn/protocol/Ids";
import { Context, Effect } from "effect";
import type { DateTime, Option } from "effect";

/** Reads when a run ended. */
export interface RunEndReader {
  /**
   * When `threadId`'s run `runId` ended, as the harness committed it: none while it runs, when the
   * harness keeps no such time, or when the read fails.
   */
  readonly endOf: (
    threadId: ThreadId,
    runId: RunId
  ) => Effect.Effect<Option.Option<DateTime.Utc>>;
}

const UNKNOWN: RunEndReader = { endOf: () => Effect.succeedNone };

/** The harness's run ends; none known unless the harness provides them. */
export class RunEnds extends Context.Reference<RunEndReader>(
  "cairn/server/brain/RunEnds",
  { defaultValue: () => UNKNOWN }
) {}
