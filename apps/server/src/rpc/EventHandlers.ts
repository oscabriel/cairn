// `workflow.eventStatus`: each durable event reactor's lag, last success and last failure, for the
// settings page (ADR 0033). A brain that is reopening or closing answers `Unavailable`, as does a
// read cut off by the Harness closing; any other failed read is logged and answers `Internal`,
// without pi-durable's text.

import { Internal, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect } from "effect";

import { EventReactors } from "../brain/EventReactors.ts";

/** `workflow.eventStatus`'s answer: the host's status, its failures as public errors. */
export const answerEventStatus = (status: EventReactors["Service"]["status"]) =>
  status.pipe(
    Effect.catchTags({
      BrainUnavailable: (failure) =>
        Effect.fail(new Unavailable({ message: failure.message })),
      DurableCallError: (failure) =>
        failure.closed
          ? Effect.fail(
              new Unavailable({
                message:
                  "The event conversation could not be read because the brain is closing. Try again in a moment.",
              })
            )
          : Effect.logError("event reactor status not read").pipe(
              Effect.annotateLogs({
                event: "event_status_failed",
                error: failure.message,
              }),
              Effect.andThen(
                Effect.fail(
                  new Internal({
                    message:
                      "Reading the event reactors' status failed. Nothing changed; retry, and check the brain's log (event_status_failed) if it repeats.",
                  })
                )
              )
            ),
    })
  );

/** `workflow.eventStatus`. Needs `EventReactors`. */
export const EventHandlers = CairnRpcs.toLayerHandler(
  "workflow.eventStatus",
  EventReactors.useSync((reactors) => () => answerEventStatus(reactors.status))
);
