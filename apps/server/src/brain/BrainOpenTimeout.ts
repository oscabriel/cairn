// How long the brain's supervisor waits for one reopen of its Session. Past this it gives the open
// up (`Brain.ts`): the open is cancelled, what it opened is closed as it lands, and the supervisor
// retries, or stops if the brain closes. Production and dev never change it; a test gives it a
// fraction of a second.

import { Context, Duration } from "effect";

/** How long one reopen of the brain's Session may take; thirty seconds unless a test says less. */
export const BrainOpenTimeout = Context.Reference<Duration.Duration>(
  "cairn/server/brain/BrainOpenTimeout",
  { defaultValue: () => Duration.seconds(30) }
);
