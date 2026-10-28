// The close hooks, in the order SIGTERM runs them (after the listener has closed every socket). A
// package hands off a `shutdownHook(...)` entry and it is listed here, so the order is decided in
// one place: the bridge's `beginClosing`, so no Claude child is opened while the brain closes, then
// `stopEventReactors`, so no reactor commits while the Harness closes. The Harness is not a hook: `Brain.ts` closes it as its scope ends, with its 5 s
// timeout, and SQLite closes after that, as its own layer ends.

import { stopEventReactors } from "./brain/EventReactors.ts";
import type { EventReactors } from "./brain/EventReactors.ts";
import { bridgeClosingHook } from "./models/BridgeProvider.ts";
import type { ShutdownHook } from "./Shutdown.ts";

/** Every close hook, in order. */
export const shutdownHooks: ReadonlyArray<ShutdownHook<EventReactors>> = [
  bridgeClosingHook,
  stopEventReactors,
];
