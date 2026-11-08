// A refused Codex turn reaches the Codex meter at once. A run that failed on Codex's usage limit
// (`RunTerminal` with the `usage_limit` class and the `codex` plan, from `classifyRunFailure`) marks
// the window it names spent in `CodexUsage`, resetting when the failure said, and starts one read;
// without it the meter would learn of the limit only from the endpoint's own `limit_reached`, at the
// next tick. The limit belongs to the Codex login held when the refusal arrives, the one the turn
// ran on: a run's failure names no account, and the last read may have been for an account signed
// out since. A Claude or OpenCode Go limit is not Codex's (`ClaudeSignals` takes Claude's).
//
// The `CodexUsage` here must be the one `UsageFeed` reads, so `UsageFeed.layer` builds one
// `CodexUsage.layer` and gives it to both.

import { DateTime, Effect, Layer, Option, Predicate, Stream } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { CodexAccess } from "../models/CodexAccess.ts";
import { CodexUsage } from "./CodexUsage.ts";

/** The reset a failed run names when it failed on Codex's usage limit; none for any other run. */
export const codexLimitOf = (
  event: HarnessEvent
): Option.Option<Option.Option<number>> => {
  if (!Predicate.isTagged(event, "RunTerminal")) {
    return Option.none();
  }

  if (event.status !== "failed") {
    return Option.none();
  }

  return Option.flatMap(event.failure, (failure) =>
    failure.class === "usage_limit" && Option.contains(failure.plan, "codex")
      ? Option.some(Option.map(failure.resetAt, DateTime.toEpochMillis))
      : Option.none()
  );
};

/**
 * Feeds Codex usage-limit failures to `CodexUsage` for the layer's life. Needs `HarnessSeam` and
 * the `CodexAccess` the reader uses.
 */
export const CodexSignals: Layer.Layer<
  never,
  never,
  HarnessSeam | CodexUsage | CodexAccess
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const harness = yield* HarnessSeam;
    const usage = yield* CodexUsage;
    const access = yield* CodexAccess;

    // A login that cannot be read leaves the limit to the next read's account.
    const account = access.credential.pipe(
      Effect.map(Option.map((credential) => credential.accountId)),
      Effect.catchTag("CodexAccessError", (failure) =>
        Effect.logWarning("the Codex login was not read for a refusal").pipe(
          Effect.annotateLogs({
            event: "codex_limit_account_unread",
            reason: failure.reason,
          }),
          Effect.as(Option.none<string>())
        )
      )
    );

    yield* harness.events.pipe(
      Stream.map(codexLimitOf),
      Stream.filter(Option.isSome),
      Stream.runForEach((limit) =>
        Effect.gen(function* () {
          yield* usage.observeLimit(limit.value, yield* account);
        })
      ),
      Effect.forkScoped({ startImmediately: true })
    );
  })
);
