// When the turns a judge started have ended, read from the brain's shell snapshot: each launched
// thread's row says a run completed and no run is live, and two reads in a row show the same rows.
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
 * none while any is missing or still has a run live.
 */
export const endedRows = (
  snapshot: ShellSnapshot,
  threadIds: ReadonlyArray<ThreadId>
): Option.Option<string> =>
  Option.flatMap(
    Option.all(
      threadIds.map((threadId) =>
        Array.findFirst(snapshot.threads, (row) => row.id === threadId)
      )
    ),
    (rows) =>
      rows.every(hasEnded)
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
