// The durable event reactors the brain runs (integration seam, like `ExtensionSet.ts`). A package
// that adds a reactor hands off its source to be listed here at the end of its wave; the list order
// is the status page's order and nothing else, since reactors run independently. A reactor that
// creates pi-durable tasks registers their definitions through its own extension's `tasks`.

import { Effect } from "effect";

import { EventReactors } from "./EventReactors.ts";
import type { Reactor } from "./Events.ts";

const production: ReadonlyArray<Effect.Effect<Reactor>> = [];

/** The reactor host over the production reactors, plus any a composition root adds (judges). */
export const ReactorSet = {
  layer: EventReactors.fromSources(production),
  /** The production reactors plus `extra`, for judge brains and tests. */
  withExtra: (extra: ReadonlyArray<Reactor>) =>
    EventReactors.fromSources([
      ...production,
      ...extra.map((reactor) => Effect.succeed(reactor)),
    ]),
};
