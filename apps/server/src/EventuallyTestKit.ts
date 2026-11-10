// What every test that waits on the live clock shares: the test slack (`CAIRN_TEST_SLACK`) every
// test deadline scales by, and `eventually`, the one polling helper with the one deadline. The gate
// (`tools/check.ts`) sets the slack from the machine's load when it starts, and `vitest.config.ts`
// sets it the same way for a run outside the gate, so a deadline that holds on a quiet machine
// still holds when other work shares it. A deadline only decides how long a failing test takes to
// say so: a passing one returns as soon as its condition holds. Never imported by production code.

import { Clock, Duration, Effect, Function, Option } from "effect";

/**
 * The factor every test deadline scales by, at least 1: `CAIRN_TEST_SLACK` as the gate or
 * `vitest.config.ts` set it from the load average, 1 when it is unset or not a number.
 */
export const TEST_SLACK = Math.max(
  1,
  Number(process.env.CAIRN_TEST_SLACK ?? "1") || 1
);

/** `base`, scaled by the test slack: the deadline a quiet machine needs, stretched for this one. */
export const slackened = (base: Duration.Input): Duration.Duration =>
  Duration.times(Duration.fromInputUnsafe(base), TEST_SLACK);

/** How long `eventually` polls before it gives up: ten seconds on a quiet machine. */
export const EVENTUALLY_WITHIN = slackened(Duration.seconds(10));

/** How often `eventually` reads again. */
const POLL = Duration.millis(20);

/**
 * Reads `read` until `check` holds of what it gave, and returns that value. Polls every 20 ms on
 * the clock in context (so only in `it.live`), and dies naming `what` once `EVENTUALLY_WITHIN`
 * passes without it holding; a failure of `read` fails at once.
 */
export const eventually = Effect.fnUntraced(function* <A, E, R>(
  read: Effect.Effect<A, E, R>,
  check: (value: A) => boolean,
  what = "the condition"
) {
  const deadline =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(EVENTUALLY_WITHIN);

  let value = yield* read;

  while (!check(value)) {
    if ((yield* Clock.currentTimeMillis) > deadline) {
      return yield* Effect.die(
        `eventually: ${what} did not hold within ${Duration.format(EVENTUALLY_WITHIN)} (CAIRN_TEST_SLACK ${TEST_SLACK})`
      );
    }

    yield* Effect.sleep(POLL);
    value = yield* read;
  }

  return value;
});

/** `eventually` for a read that finds something or nothing: the thing it found. */
export const eventuallySome = <A, E, R>(
  find: Effect.Effect<Option.Option<A>, E, R>,
  what = "the search"
) => eventually(find, Option.isSome, what).pipe(Effect.map(Option.getOrThrow));

/** `eventually` for a check that answers yes or no: `true`, once it does. */
export const eventuallyTrue = <E, R>(
  done: Effect.Effect<boolean, E, R>,
  what = "the check"
) => eventually(done, Function.identity, what);
