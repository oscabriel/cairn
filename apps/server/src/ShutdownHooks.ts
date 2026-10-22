// The close hooks, in the order SIGTERM runs them (after the listener has closed every socket).
// This list is a seam: packages hand off a `shutdownHook(...)` entry and the integrator adds it here,
// so the order is decided in one place. Planned order: the bridge's `Claude.beginClosing()`, watches
// and task-graph watches, then `harness.close(context)` with its 5 s timeout. SQLite closes after
// these, as its own layer ends.
import type { ShutdownHook } from "./Shutdown.ts";

/** Every close hook, in order. */
export const shutdownHooks: ReadonlyArray<ShutdownHook<never>> = [];
