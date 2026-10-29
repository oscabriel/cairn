// `roles.check`: the brief card's preview of each role a brief or workflow plan names (ADR 0035),
// resolved against the table, the catalog, provider health and the plan windows as they are now.
// Writes nothing. A failed read of the table or the catalog answers `Unavailable`, carrying the
// request id. A launch card passes its role overrides, which apply before the table.

import { Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Option } from "effect";

import { RoleAliases } from "../models/RoleAliases.ts";

/** `roles.check`, over `RoleAliases`. Needs `RoleAliases`. */
export const RoleHandlers = CairnRpcs.toLayerHandler(
  "roles.check",
  Effect.gen(function* () {
    const roles = yield* RoleAliases;

    return (input, { requestId }) =>
      roles.check(input.specs, Option.fromUndefinedOr(input.overrides)).pipe(
        Effect.mapError(
          (failure) =>
            new Unavailable({
              message: failure.message,
              requestId: Option.some(String(requestId)),
            })
        )
      );
  })
);
