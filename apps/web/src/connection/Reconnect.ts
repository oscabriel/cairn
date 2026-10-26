// The connection's state machine, owned by the Model. The socket never retries on its own: when it
// fails, every call and stream fails, the Model moves to `Backoff`, waits, and bumps the epoch, which
// releases the old client and acquires a fresh one (Connection.ts). States and timings follow the
// plan's client connection rules:
//
//   Connecting  the client for this epoch is being built
//   Syncing     the client exists; the shell stream has not delivered its snapshot or replay yet
//   Live        the shell is current; sends and the outbox run only here
//   Backoff     the last attempt failed; the next one starts after the delay for `attempt`
//
// The page is never `Live` before the shell stream of the current epoch said it was current, so a
// label or an outbox resend never runs on a socket that has not proven itself.

import { Match, Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** Where the connection is. `attempt` counts consecutive failures; it resets once `Live`. */
export const ConnectionState = defineTaggedUnion({
  Connecting: { attempt: Schema.Int },
  Syncing: { attempt: Schema.Int },
  Live: {},
  Backoff: { attempt: Schema.Int },
});

export type ConnectionState = typeof ConnectionState.Type;

/** The connection as the Model holds it: the epoch keys the client resource and every stream. */
export const Connection = Schema.Struct({
  epoch: Schema.Int,
  state: ConnectionState,
});

export type Connection = typeof Connection.Type;

/** The first connection of a page load. */
export const initialConnection: Connection = {
  epoch: 0,
  state: ConnectionState.Connecting({ attempt: 0 }),
};

/** Base delays before attempt 1, 2, 3, 4 and 5; every later attempt waits the last value. */
export const BACKOFF_STEPS_MS: ReadonlyArray<number> = [0, 100, 200, 400, 800];

/** The delay from the sixth attempt on. */
export const BACKOFF_CEILING_MS = 1000;

/** Each delay is moved by up to this share either way, so many tabs do not reconnect in step. */
export const BACKOFF_JITTER = 0.2;

/**
 * The wait before attempt `attempt` (1 is the first retry). `random` is in [0, 1); 0.5 gives the
 * base delay exactly.
 */
export const backoffDelayMs = (attempt: number, random: number): number => {
  const base = BACKOFF_STEPS_MS[attempt - 1] ?? BACKOFF_CEILING_MS;

  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random));
};

/** True while a client for the current epoch exists, so its streams may run. */
export const hasClient = (connection: Connection): boolean =>
  ConnectionState.match(connection.state, {
    Connecting: () => false,
    Syncing: () => true,
    Live: () => true,
    Backoff: () => false,
  });

/** True once the shell is current on this epoch. */
export const isLive = (connection: Connection): boolean =>
  ConnectionState.match(connection.state, {
    Connecting: () => false,
    Syncing: () => false,
    Live: () => true,
    Backoff: () => false,
  });

/** True while waiting before the next attempt; no client is wanted then. */
export const isBackingOff = (connection: Connection): boolean =>
  ConnectionState.match(connection.state, {
    Connecting: () => false,
    Syncing: () => false,
    Live: () => false,
    Backoff: () => true,
  });

/** The client for the current epoch was built: wait for the shell stream. */
export const acquired = (connection: Connection): Connection =>
  ConnectionState.match(connection.state, {
    Connecting: ({ attempt }) => ({
      ...connection,
      state: ConnectionState.Syncing({ attempt }),
    }),
    Syncing: () => connection,
    Live: () => connection,
    Backoff: () => connection,
  });

/** The shell stream of the current epoch is current: the connection is live. */
export const synchronized = (connection: Connection): Connection =>
  ConnectionState.match(connection.state, {
    Connecting: () => connection,
    Syncing: () => ({ ...connection, state: ConnectionState.Live() }),
    Live: () => connection,
    Backoff: () => connection,
  });

/** The attempt number the next try will be, counted from the failure that just happened. */
const nextAttempt = (state: ConnectionState): number =>
  ConnectionState.match(state, {
    Connecting: ({ attempt }) => attempt + 1,
    Syncing: ({ attempt }) => attempt + 1,
    Live: () => 1,
    Backoff: ({ attempt }) => attempt,
  });

/** The backoff wait to start: before attempt `attempt`, on epoch `epoch`. */
export interface BackoffWait {
  readonly epoch: number;
  readonly attempt: number;
}

/**
 * The current epoch failed. Moves to `Backoff` and says which wait to start; a second report of
 * the same failure (the shell stream and a call can both notice it) starts nothing.
 */
export const lost = (
  connection: Connection
): Readonly<{ connection: Connection; wait: Option.Option<BackoffWait> }> =>
  Match.value(connection.state).pipe(
    Match.tag("Backoff", () => ({ connection, wait: Option.none() })),
    Match.orElse((state) => {
      const attempt = nextAttempt(state);

      return {
        connection: {
          ...connection,
          state: ConnectionState.Backoff({ attempt }),
        },
        wait: Option.some({ epoch: connection.epoch, attempt }),
      };
    })
  );

/** Starts the next attempt now: a new epoch, so a new client and fresh streams. */
const retry = (connection: Connection, attempt: number): Connection => ({
  epoch: connection.epoch + 1,
  state: ConnectionState.Connecting({ attempt }),
});

/**
 * A backoff wait ended. Only the wait for the current epoch and attempt counts; a stale timer
 * from an earlier failure changes nothing.
 */
export const elapsed = (
  connection: Connection,
  epoch: number,
  attempt: number
): Connection =>
  Match.value(connection.state).pipe(
    Match.tag("Backoff", (state) =>
      connection.epoch === epoch && state.attempt === attempt
        ? retry(connection, attempt)
        : connection
    ),
    Match.orElse(() => connection)
  );

/**
 * The page came back (online, shown again, or visible): a connection in backoff tries now rather
 * than at the end of its wait. Any other state is left alone.
 */
export const woke = (connection: Connection): Connection =>
  Match.value(connection.state).pipe(
    Match.tag("Backoff", ({ attempt }) => retry(connection, attempt)),
    Match.orElse(() => connection)
  );
