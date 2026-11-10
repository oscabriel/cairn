// When the turns a judge started have ended, read from the brain's shell snapshot: each launched
// thread's row says a run completed and no run is live, and the reads agree for long enough.
// A quiet stretch of the shell's sequence is no proof: the dev brain's demo thread is sent a message
// every few seconds (`apps/server/src/DevDemo.ts`), and a stalled brain is quiet mid-turn. Rows of
// threads the judge did not launch are ignored.

import type { ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { Array, Option, Schema } from "effect";

const encodeRow = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ThreadShell))
);

/** True when the row's last run ended (completed or failed) and none is live. */
export const hasEnded = (row: ThreadShell): boolean =>
  Option.isSome(row.latestRunCompletedAt) &&
  (row.activity === "idle" || row.activity === "failed");

/**
 * The rows of `threadIds` in `snapshot`, as wire JSON in that order, once every one has ended;
 * none while any is missing or still has a run live. The rows in `idleOnly` must have ended idle: a
 * thread no kill touched has no reason to fail, so its failure is not an end the judge waits for.
 */
export const endedRows = (
  snapshot: ShellSnapshot,
  threadIds: ReadonlyArray<ThreadId>,
  idleOnly: ReadonlyArray<ThreadId> = []
): Option.Option<string> =>
  Option.flatMap(
    Option.all(
      threadIds.map((threadId) =>
        Array.findFirst(snapshot.threads, (row) => row.id === threadId)
      )
    ),
    (rows) =>
      rows.every(
        (row) =>
          hasEnded(row) &&
          (row.activity === "idle" || !idleOnly.includes(row.id))
      )
        ? Option.some(`[${rows.map((row) => encodeRow(row)).join(",")}]`)
        : Option.none()
  );

/** True when two reads in a row found every turn ended, with nothing on their rows changed. */
export const isSettled = (
  previous: Option.Option<string>,
  current: Option.Option<string>
): boolean =>
  Option.isSome(previous) &&
  Option.isSome(current) &&
  previous.value === current.value;

/**
 * How many reads in a row must agree (`isSettled`) before the brain counts as settled: row writes
 * that trail a run's end are debounced at 50 ms, so one 250 ms gap is too thin a margin on a loaded
 * machine. Four agreeing reads hold about a second, as the old settle on the shell's sequence did.
 */
export const SETTLED_READS = 4;
