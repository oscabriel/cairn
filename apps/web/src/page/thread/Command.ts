// The thread page's own Command: the wait before a fresh subscription, after a stream ended with
// a failure or with NotFound while the thread's launch was still on its way to the brain.

import { Duration, Effect, Schema } from "effect";
import { Command } from "foldkit";

import { Message } from "./Message.ts";

/** The waits before each resubscribe since the last snapshot; later attempts keep the last. */
const RESUBSCRIBE_DELAYS_MS: ReadonlyArray<number> = [250, 1000, 5000];

/** How long to wait before resubscribe attempt `attempt` (0 for the first since a snapshot). */
export const resubscribeDelayMs = (attempt: number): number =>
  RESUBSCRIBE_DELAYS_MS[Math.min(attempt, RESUBSCRIBE_DELAYS_MS.length - 1)] ??
  0;

/** Waits out the delay of `attempt`, then answers with the stamp of the stream that ended. */
export const WaitToResubscribe = Command.define("WaitToResubscribe", {
  args: { epoch: Schema.Int, watch: Schema.Int, attempt: Schema.Int },
  messages: [Message.ElapsedResubscribeWait],
  execute: ({ attempt, epoch, watch }) =>
    Effect.sleep(Duration.millis(resubscribeDelayMs(attempt))).pipe(
      Effect.as(Message.ElapsedResubscribeWait({ epoch, watch }))
    ),
});
