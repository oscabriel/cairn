// The Executor link's status into the notifier (wave 3 integration glue between 3D and 3G): a move
// into `needs-sign-in` pushes "Executor needs sign-in" once, and a move back to `connected` clears
// the claim so the next lapse pushes again.
import { Effect, Layer, Stream } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { Notifier } from "./Notifier.ts";

/** Watches the link's status for as long as the app runs. Needs `ExecutorLink` and `Notifier`. */
export const ExecutorSignInPush = Layer.effectDiscard(
  Effect.gen(function* () {
    const link = yield* ExecutorLink;
    const notifier = yield* Notifier;

    yield* link.statusChanges.pipe(
      Stream.map((status) => status.state),
      Stream.changes,
      Stream.runForEach((state) => {
        if (state === "needs-sign-in") {
          return notifier.executorNeedsSignIn;
        }

        return state === "connected" ? notifier.executorSignedIn : Effect.void;
      }),
      Effect.forkScoped
    );
  })
);
