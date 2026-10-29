// `portal.close` and `portal.start` (ADR 0038): the user's Close and Start on a portal row. Close
// stops the dev server and takes the name down for good; Start runs a stopped portal again with its
// own command, as `portal_open` would. A portal the brain does not hold answers `NotFound`; one
// closed for good, or a seventh open, answers `Conflict`; a server that did not answer, or a store
// or porch failure a retry may mend, answers `Unavailable`; systemd refusing, or porch refusing for
// good, is logged and answers `Internal`.

import {
  Conflict,
  Internal,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cairn/protocol/Errors";
import type { PortalInput } from "@cairn/protocol/Reach";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer } from "effect";

import type { PorchError } from "../reach/PorchClient.ts";
import { Portals } from "../reach/Portals.ts";
import type { PortalError } from "../reach/Portals.ts";
import { publicText } from "./PublicText.ts";

/** A public error for a portal the user's command cannot act on. */
type PortalPublicError =
  | Conflict
  | Internal
  | InvalidInput
  | NotFound
  | Unavailable;

/** A refused or failed portal command as the public error a client can act on. */
export const publicPortalError = (error: PortalError): PortalPublicError => {
  const message = publicText(error.message);

  if (error.reason === "not-found") {
    return new NotFound({ message, resource: "portal", id: error.portal });
  }

  if (error.reason === "removed" || error.reason === "taken") {
    return new Conflict({ message, reason: "stale_state" });
  }

  if (error.reason === "limit") {
    return new Conflict({ message, reason: "limit_reached" });
  }

  if (error.reason === "bad-input") {
    return new InvalidInput({ message });
  }

  return error.reason === "unit"
    ? new Internal({ message })
    : new Unavailable({ message });
};

/** A porch failure as a public error: retryable ones are `Unavailable`. */
export const publicPorchError = (error: PorchError): PortalPublicError => {
  const message = publicText(error.message);

  return error.retryable
    ? new Unavailable({ message })
    : new Internal({ message });
};

/** Logs a failure the page cannot explain by itself, so the journal has its cause. */
const logFailure = (operation: string, portalId: string, message: string) =>
  Effect.logError("portal command failed").pipe(
    Effect.annotateLogs({
      event: "portal_command_failed",
      operation,
      portal: portalId,
      error: message,
    })
  );

/** Runs one portal command and answers its failures as public errors. */
const answer = (
  operation: string,
  portalId: string,
  command: Effect.Effect<unknown, PortalError | PorchError>
) =>
  command.pipe(
    Effect.asVoid,
    Effect.catchTags({
      PortalError: (error) =>
        (error.reason === "unit" || error.reason === "store"
          ? logFailure(operation, portalId, error.message)
          : Effect.void
        ).pipe(Effect.andThen(Effect.fail(publicPortalError(error)))),
      PorchError: (error) =>
        logFailure(operation, portalId, error.message).pipe(
          Effect.andThen(Effect.fail(publicPorchError(error)))
        ),
    })
  );

/** `portal.close`'s answer. */
export const answerPortalClose = (
  portals: Portals["Service"],
  input: PortalInput
) => answer("close", input.portalId, portals.close(input.portalId));

/** `portal.start`'s answer. */
export const answerPortalStart = (
  portals: Portals["Service"],
  input: PortalInput
) => answer("start", input.portalId, portals.start(input.portalId));

/** `portal.close` and `portal.start`. Needs `Portals`. */
export const PortalHandlers = Layer.mergeAll(
  CairnRpcs.toLayerHandler(
    "portal.close",
    Portals.useSync((portals) => (input) => answerPortalClose(portals, input))
  ),
  CairnRpcs.toLayerHandler(
    "portal.start",
    Portals.useSync((portals) => (input) => answerPortalStart(portals, input))
  )
);
