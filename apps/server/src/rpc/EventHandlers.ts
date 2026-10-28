// `workflow.eventStatus`: each durable event reactor's lag, last success and last failure, for the
// settings page (ADR 0033). A brain that is reopening or closing answers `Unavailable`, as does a
// read cut off by the Harness closing; any other failed read is `Internal`.

import { Internal, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect } from "effect";

import { EventReactors } from "../brain/EventReactors.ts";

/** `workflow.eventStatus`. Needs `EventReactors`. */
export const EventHandlers = CairnRpcs.toLayerHandler(
  "workflow.eventStatus",
  EventReactors.useSync(
    (reactors) => () =>
      reactors.status.pipe(
        Effect.catchTags({
          BrainUnavailable: (failure) =>
            Effect.fail(new Unavailable({ message: failure.message })),
          DurableCallError: (failure) =>
            Effect.fail(
              failure.closed
                ? new Unavailable({
                    message:
                      "The event log could not be read because the brain is closing. Try again in a moment.",
                  })
                : new Internal({
                    message: `Reading the event reactors' status failed: ${failure.message}. Nothing changed; retry, and check the brain's log if it repeats.`,
                  })
            ),
        })
      )
  )
);
