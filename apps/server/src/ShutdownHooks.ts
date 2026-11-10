// The close hooks, in the order SIGTERM runs them (after the listener has closed every socket): every
// feature's (`Features.ts`), in list order, then the brain's own. Today that is the bridge's
// `beginClosing`, so no Claude child is opened while the brain closes, then `stopPortalSweep`
// (every portal's unit keeps running through the restart), then `stopEventReactors`, so no reactor
// commits while the Harness closes. The Harness is not a hook: `Brain.ts` closes it as its scope
// ends, with its 5 s timeout, and SQLite closes after that, as its own layer ends.

import { stopEventReactors } from "./brain/EventReactors.ts";
import type { EventReactors } from "./brain/EventReactors.ts";
import type { Registered } from "./brain/Feature.ts";
import { FEATURES } from "./Features.ts";
import type { Feature } from "./Features.ts";
import type { ShutdownHook } from "./Shutdown.ts";

/** What the close hooks read, across every feature and the brain's own. */
type HookServices =
  | EventReactors
  | (Registered<Feature, "closeHooks"> extends ShutdownHook<infer R>
      ? R
      : never);

/** Every close hook of `features`, in list order, then the brain's own. */
export const closeHooksOf = (
  features: ReadonlyArray<Feature>
): ReadonlyArray<ShutdownHook<HookServices>> => [
  ...features.flatMap(
    (feature): ReadonlyArray<Registered<Feature, "closeHooks">> =>
      feature.closeHooks
  ),
  stopEventReactors,
];

/** Every close hook, in order. */
export const shutdownHooks = closeHooksOf(FEATURES);
