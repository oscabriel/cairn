// Every RPC handler in one layer (a seam: the integrator adds each domain's handlers here). Later
// entries win, so a domain's handlers listed after `stubHandlers` replace its stubs. Handlers stay
// thin: they call services and return protocol values.
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect } from "effect";

import { sessionHandlers } from "./SessionHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

/** The handlers of `CairnRpcs`, as the layer each socket's RPC server reads. */
export const HandlersLayer = CairnRpcs.toLayer(
  Effect.gen(function* () {
    const session = yield* sessionHandlers;

    return CairnRpcs.of({
      ...stubHandlers,
      ...session,
    });
  })
);
