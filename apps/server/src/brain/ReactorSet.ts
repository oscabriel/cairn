// The durable event reactors the brain runs (integration seam, like `ExtensionSet.ts`). A package
// that adds a reactor hands off its source to be listed here at the end of its wave; the list order
// is the status page's order and nothing else, since reactors run independently. A reactor that
// creates pi-durable tasks registers their definitions through its own extension's `tasks`.
//
// A reactor added in a later deploy starts where its `from` says (`ReactorStart` in `Events.ts`):
// `now` handles only what is emitted after it, `start` also replays this UTC month's events so far.
// Any reactor whose tasks reach outside (pushes, child starts) takes `now`.
//
// A dead letter (an event a reactor passed without handling, ADR 0033 as amended) is pushed through
// `WorkflowPushes.layer`, the reference `AppLayer` drains through `WorkflowBudgetPush`, so the memo
// map builds one outbox for the soft line's pushes and the dead letters.

import { Effect, Layer } from "effect";

import { workflowBudgetReactor } from "../workflows/WorkflowBudget.ts";
import { WorkflowPushes } from "../workflows/WorkflowPushes.ts";
import { EventReactors } from "./EventReactors.ts";
import type { DeadLetterPush } from "./EventReactors.ts";
import type { Reactor } from "./Events.ts";

const production: ReadonlyArray<Effect.Effect<Reactor>> = [
  Effect.succeed(workflowBudgetReactor),
];

/** Each dead letter's push, into the notifier's outbox. */
const deadLetterPush = WorkflowPushes.useSync(
  (outbox): DeadLetterPush =>
    (letter) =>
      outbox.sendDeadLetter({
        reactor: letter.reactor,
        eventId: letter.eventId,
        kind: letter.kind,
        error: letter.error,
      })
);

/** The reactor host over the production reactors, plus any a composition root adds (judges). */
export const ReactorSet = {
  layer: EventReactors.fromSources(production, deadLetterPush).pipe(
    Layer.provide(WorkflowPushes.layer)
  ),
  /** The production reactors plus `extra`, for judge brains and tests. */
  withExtra: (extra: ReadonlyArray<Reactor>) =>
    EventReactors.fromSources(
      [...production, ...extra.map((reactor) => Effect.succeed(reactor))],
      deadLetterPush
    ).pipe(Layer.provide(WorkflowPushes.layer)),
};
