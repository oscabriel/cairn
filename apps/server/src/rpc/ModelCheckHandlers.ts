// `models.check`: the brief card's and the launch card's preview of each model a brief or a
// workflow's launch names (ADR 0043), checked against the catalog, provider health and the plan
// windows as they are now. Writes nothing. A failed read of the catalog answers `Unavailable`,
// carrying the request id.

import { Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Option } from "effect";

import { ModelSpecs } from "../models/ModelSpecs.ts";

/** `models.check`, over `ModelSpecs`. Needs `ModelSpecs`. */
export const ModelCheckHandlers = CairnRpcs.toLayerHandler(
  "models.check",
  Effect.gen(function* () {
    const specs = yield* ModelSpecs;

    return (input, { requestId }) =>
      specs.check(input.specs).pipe(
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
