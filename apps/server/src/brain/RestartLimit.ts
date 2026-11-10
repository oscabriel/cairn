// The `restartLimit` the brain opens its Harness with (ADR 0046): infinite, so pi-durable never ends
// a task because crashes cut it off, and boot's crash accounting (`CrashLimit.ts`) decides instead.
// Production, dev and tests never change it; a judge's broken control sets pi-durable's own default
// to show what that limit does to an approval left pending across crashes.

import { Context } from "effect";

/** The Harness's `restartLimit`; infinite unless a judge's control says otherwise. */
export const RestartLimit = Context.Reference<number>(
  "cairn/server/brain/RestartLimit",
  { defaultValue: () => Number.POSITIVE_INFINITY }
);
