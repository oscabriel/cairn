// The glue between the Executor link's status and the notifier: one push per lapse into
// needs-sign-in, a cleared claim on the way back to connected, nothing for other states.
import type { ExecutorStatus } from "@cairn/protocol/Executor";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, SubscriptionRef } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { ExecutorSignInPush } from "./ExecutorSignInPush.ts";
import { Notifier } from "./Notifier.ts";

const statusOf = (state: ExecutorStatus["state"]): ExecutorStatus => ({
  state,
  detail: Option.none(),
  checkedAt: Option.none(),
});

describe("the Executor sign-in push", () => {
  it.effect("pushes once per lapse and clears the claim on sign-in", () =>
    Effect.gen(function* () {
      const status = yield* SubscriptionRef.make(statusOf("connected"));
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);

      const note = (call: string) => Ref.update(calls, (all) => [...all, call]);

      const link = Layer.succeed(ExecutorLink, {
        call: () => Effect.die("not used"),
        status: SubscriptionRef.get(status),
        statusChanges: SubscriptionRef.changes(status),
        signIn: Effect.die("not used"),
        callback: () => Effect.die("not used"),
      });

      const notifier = Layer.succeed(Notifier, {
        sendToAll: () => Effect.succeed([]),
        handleEvent: () => Effect.void,
        executorNeedsSignIn: note("needs"),
        executorSignedIn: note("signed-in"),
        settle: Effect.void,
      });

      yield* Effect.gen(function* () {
        for (const state of [
          "needs-sign-in",
          "needs-sign-in",
          "unreachable",
          "connected",
          "needs-sign-in",
        ] as const) {
          yield* Effect.yieldNow;
          yield* SubscriptionRef.set(status, statusOf(state));
        }

        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      }).pipe(
        Effect.provide(
          ExecutorSignInPush.pipe(Layer.provide(Layer.merge(link, notifier)))
        )
      );

      assert.deepStrictEqual(yield* Ref.get(calls), [
        "signed-in",
        "needs",
        "signed-in",
        "needs",
      ]);
    })
  );
});
