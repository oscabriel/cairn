// `executor.status` and `executor.signIn`: thin calls into the Executor link. A sign-in that
// cannot start (no grant, the grant still works, Executor down) is `Unavailable` with the reason in
// its message, carrying the RPC request id.
import { Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";

/** `executor.status`: where the link to Executor stands. */
export const ExecutorStatusHandler = CairnRpcs.toLayerHandler(
  "executor.status",
  Effect.gen(function* () {
    const link = yield* ExecutorLink;

    return () => link.status;
  })
);

/** `executor.signIn`: Executor's consent page for a new grant. */
export const ExecutorSignInHandler = CairnRpcs.toLayerHandler(
  "executor.signIn",
  Effect.gen(function* () {
    const link = yield* ExecutorLink;

    return (_input, { requestId }) =>
      link.signIn.pipe(
        Effect.map((authorizeUrl) => ({ authorizeUrl })),
        Effect.mapError(
          (failure) =>
            new Unavailable({
              message: failure.message.slice(0, 4096),
              requestId: Option.some(String(requestId)),
            })
        )
      );
  })
);

/** Every handler this module owns. Needs `ExecutorLink`. */
export const ExecutorHandlers = Layer.mergeAll(
  ExecutorStatusHandler,
  ExecutorSignInHandler
);
