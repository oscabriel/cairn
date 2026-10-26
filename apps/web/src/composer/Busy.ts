// The typing judge's load knob, kept from the S2 spike: `?busy=<ms>` makes every update spend that
// long, the load that exposed Foldkit 0.168's dropped keystrokes. Without the query parameter it
// costs one query-string lookup per update.

import { Clock, Effect } from "effect";

const MAX_BUSY_MS = 100;

/** The busy budget a page's query string asks for, clamped to 0 to 100 ms. */
export const busyMsFromSearch = (search: string): number => {
  const requested = Number(new URLSearchParams(search).get("busy") ?? 0);

  return Number.isFinite(requested)
    ? Math.max(0, Math.min(MAX_BUSY_MS, Math.floor(requested)))
    : 0;
};

/** Spends this page's busy budget. Called once at the top of the root update. */
export const burnBusyBudget = (): void => {
  const ms = busyMsFromSearch(globalThis.location.search);

  if (ms === 0) {
    return;
  }

  // Spin on Effect's clock: the point is to occupy the main thread for `ms`.
  Effect.runSync(
    Effect.gen(function* () {
      const until = (yield* Clock.currentTimeMillis) + ms;

      while ((yield* Clock.currentTimeMillis) < until) {
        yield* Effect.void;
      }
    })
  );
};
