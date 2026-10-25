// The root's Commands: navigation, the backoff timer, `session.hello`, and the outbox's send and
// save. Each reads what it needs from the resources the runtime provides (the connection, the
// browser's key-value store) and answers with one Message.
import { Duration, Effect, Predicate, Random, Schema } from "effect";
import type { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";

import { CairnConnection, withBoundary } from "./connection/Connection.ts";
import type {
  CairnClient,
  CairnConnectionService,
} from "./connection/Connection.ts";
import { OutboxItem, outboxKey, saveOutbox } from "./connection/Outbox.ts";
import { backoffDelayMs } from "./connection/Reconnect.ts";
import { reloadIfStale } from "./load/StaleBuild.ts";
import { Message } from "./Message.ts";

/** Every service a root Command or Subscription may read. */
export type Services = CairnConnectionService | KeyValueStore.KeyValueStore;

/** Moves to a path inside the app without a reload. */
export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

/** Leaves the app for another page. */
export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

/** Waits out the backoff before attempt `attempt`, with jitter drawn here, not in update. */
export const WaitForBackoff = Command.define("WaitForBackoff", {
  args: { epoch: Schema.Int, attempt: Schema.Int },
  messages: [Message.ElapsedBackoff],
  execute: ({ attempt, epoch }) =>
    Effect.gen(function* () {
      const random = yield* Random.next;

      yield* Effect.sleep(Duration.millis(backoffDelayMs(attempt, random)));

      return Message.ElapsedBackoff({ epoch, attempt });
    }),
});

/** Waits before sending the outbox's head again after a retryable failure, with jitter drawn here. */
export const WaitToResend = Command.define("WaitToResend", {
  args: { epoch: Schema.Int, key: Schema.String, attempt: Schema.Int },
  messages: [Message.ElapsedResend],
  execute: ({ attempt, epoch, key }) =>
    Effect.gen(function* () {
      const random = yield* Random.next;

      yield* Effect.sleep(Duration.millis(backoffDelayMs(attempt, random)));

      return Message.ElapsedResend({ epoch, key });
    }),
});

/**
 * How long one outbox send may go unanswered before it counts as a retryable failure. Above the
 * brain's own longest wait (a send follows a launch for up to 15 minutes, its `LaunchFollowLimit`),
 * so a slow answer is not cut short; the items are idempotent by key, so a resend is harmless.
 */
export const OUTBOX_SEND_TIMEOUT = Duration.minutes(16);

/** An outbox send the brain did not answer within `OUTBOX_SEND_TIMEOUT`; safe to send again. */
export class OutboxSendTimeout extends Schema.TaggedError<OutboxSendTimeout>()(
  "OutboxSendTimeout",
  { message: Schema.String, retryable: Schema.Literal(true) }
) {}

/** `send`, failing with a retryable `OutboxSendTimeout` once it has waited the timeout. */
export const answeredInTime = <A, E, R>(
  send: Effect.Effect<A, E, R>
): Effect.Effect<A, E | OutboxSendTimeout, R> =>
  send.pipe(
    Effect.timeoutOrElse({
      duration: OUTBOX_SEND_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OutboxSendTimeout({
            message: "The brain did not answer in time. Sending again.",
            retryable: true,
          })
        ),
    })
  );

/** A failed call: one of the protocol's errors, which say whether a retry is safe, or the transport's. */
interface CallFailure {
  readonly _tag: string;
}

const failureText = (failure: CallFailure): string =>
  Predicate.hasProperty(failure, "message") &&
  Predicate.isString(failure.message)
    ? failure.message
    : `The request failed (${failure._tag}).`;

/** True for a failure that carries no `retryable` verdict: the transport's, where nothing known ran. */
const isTransport = (failure: CallFailure): boolean =>
  !(
    Predicate.hasProperty(failure, "retryable") &&
    Predicate.isBoolean(failure.retryable)
  );

/** A failure the brain marked retryable, or one of the transport. */
const isRetryable = (failure: CallFailure): boolean =>
  Predicate.hasProperty(failure, "retryable") &&
  Predicate.isBoolean(failure.retryable)
    ? failure.retryable
    : true;

/** Asks the brain who it is; a failure means this epoch's socket is not usable. */
export const SayHello = Command.define("SayHello", {
  args: { epoch: Schema.Int },
  messages: [Message.SucceededHello, Message.LostConnection],
  execute: ({ epoch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["session.hello"]();
      })
    ).pipe(
      Effect.tap((hello) => reloadIfStale(hello.build)),
      Effect.match({
        onSuccess: (hello) => Message.SucceededHello({ epoch, hello }),
        onFailure: (failure) =>
          Message.LostConnection({ epoch, reason: failureText(failure) }),
      })
    ),
});

const sendItem = (client: CairnClient, item: OutboxItem) =>
  OutboxItem.match(item, {
    Send: ({ input }) => Effect.asVoid(client["thread.send"](input)),
    Dispatch: ({ command }) => Effect.asVoid(client["shell.dispatch"](command)),
    Launch: ({ input }) => Effect.asVoid(client["thread.launch"](input)),
  });

/** Sends one outbox item over the current epoch's client. */
export const SendOutboxItem = Command.define("SendOutboxItem", {
  args: { epoch: Schema.Int, item: OutboxItem },
  messages: [Message.AcknowledgedOutboxItem, Message.FailedOutboxItem],
  execute: ({ epoch, item }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        yield* sendItem(client, item);
      })
    ).pipe(
      answeredInTime,
      Effect.match({
        onSuccess: () =>
          Message.AcknowledgedOutboxItem({ epoch, key: outboxKey(item) }),
        onFailure: (failure) =>
          Message.FailedOutboxItem({
            epoch,
            key: outboxKey(item),
            retryable: isRetryable(failure),
            transport: isTransport(failure),
            message: failureText(failure),
          }),
      })
    ),
});

/** Saves the outbox to localStorage. */
export const SaveOutbox = Command.define("SaveOutbox", {
  args: { outbox: Schema.Array(OutboxItem) },
  messages: [Message.CompletedSaveOutbox],
  execute: ({ outbox }) =>
    Effect.map(saveOutbox(outbox), (saved) =>
      Message.CompletedSaveOutbox({ saved })
    ),
});
