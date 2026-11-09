// How long the brain's supervisor lets one reopen of its Session take. A reopen holds the brain's
// shutdown until it ends (`Brain.ts`), so an open that hangs would hold it for good; past this the
// attempt fails, its open is cancelled, and the supervisor retries, or stops if the brain closes.
// Production and dev never change it; a test gives it a fraction of a second.

import { Context, Duration } from "effect";

/** How long one reopen of the brain's Session may take; thirty seconds unless a test says less. */
export const BrainOpenTimeout = Context.Reference<Duration.Duration>(
  "cairn/server/brain/BrainOpenTimeout",
  { defaultValue: () => Duration.seconds(30) }
);
