// What the chat header's diff toggle (`ToggleView.ts`) reads from its thread page: the newest turn
// a `cairn.checkpoint` entry recorded, which the toggle opens, and the inputs its view takes.

import { checkpointSummaryOf } from "@cairn/client-logic/DiffTree";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { Entry } from "@cairn/protocol/Thread";
import { Array, Option } from "effect";

/**
 * The newest turn a `cairn.checkpoint` entry recorded among `entries` (a thread view's entries and
 * the older ones paged in): what the toggle opens. None while the thread has no checkpoint.
 */
export const latestCheckpointTurn = (
  entries: ReadonlyArray<Entry>
): Option.Option<number> =>
  Array.reduce(entries, Option.none<number>(), (latest, entry) =>
    entry.kind === "cairn.checkpoint"
      ? Option.match(checkpointSummaryOf(entry.data), {
          onNone: () => latest,
          onSome: ({ turn }) =>
            Option.some(
              Math.max(
                turn,
                Option.getOrElse(latest, () => turn)
              )
            ),
        })
      : latest
  );

/** What the diff panel's own toggle view reads from its thread page. */
export interface ToggleViewInputs {
  readonly threadId: Option.Option<ThreadId>;
  /** The older entries paged in above the thread view. */
  readonly older: ReadonlyArray<Entry>;
  /** The thread view's entries. */
  readonly entries: ReadonlyArray<Entry>;
}
