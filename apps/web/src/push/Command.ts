// The push toggle's Commands and the Effects its Subscriptions run: checking the device (and
// registering `/sw.js`), turning push on from a tap, turning it off, the load's re-check of the
// subscription, presence reports, and the app badge. Each answers with one Message.
import type { ThreadId } from "@cairn/protocol/Ids";
import { Cause, Effect, Option, Schema } from "effect";
import { Command } from "foldkit";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import type { CairnConnectionService } from "../connection/Connection.ts";
import type { CallFailure } from "../connection/Failure.ts";
import { failureMessage } from "../connection/Failure.ts";
import { Message } from "./Message.ts";
import {
  currentPermission,
  currentSubscription,
  loadDeviceId,
  loadPushWanted,
  pushSupport,
  registerServiceWorker,
  requestPermission,
  savePushWanted,
  setAppBadge,
  unsubscribeDevice,
} from "./PushDevice.ts";
import type { CurrentSubscription } from "./PushDevice.ts";

/** The services the push toggle's Commands and Subscriptions read. */
export type Services = CairnConnectionService;

/** A failed call: one of the protocol's errors, the transport's, or the browser's. */
const PUSH_FAILED = "Push did not work this time.";

const causeText = (cause: Cause.Cause<CallFailure>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => PUSH_FAILED,
    onSome: (failure) => failureMessage(failure, PUSH_FAILED),
  });

/** Tells the server about this device's subscription, and to forget the one it replaced. */
const register = (current: CurrentSubscription) =>
  Effect.gen(function* () {
    const client = yield* CairnConnection.get;

    yield* client["push.subscribe"](current.subscription);

    if (Option.isSome(current.replaced)) {
      yield* client["push.unsubscribe"]({ endpoint: current.replaced.value });
    }
  });

/** Looks at the device: support, permission and its presence id; registers the service worker. */
export const CheckDevice = Command.define("CheckDevice", {
  messages: [Message.CheckedDevice],
  execute: Effect.gen(function* () {
    // A worker that fails to register only costs push; the page works without it.
    yield* registerServiceWorker.pipe(Effect.ignore);

    return Message.CheckedDevice({
      support: pushSupport(),
      permission: currentPermission(),
      deviceId: yield* loadDeviceId,
      wanted: yield* loadPushWanted,
    });
  }),
});

/** Asks for the permission, subscribes with the server's key and tells the server. */
export const EnablePush = Command.define("EnablePush", {
  args: { vapidKey: Schema.String },
  messages: [Message.SucceededEnable, Message.FailedPush],
  execute: ({ vapidKey }) =>
    Effect.gen(function* () {
      const permission = yield* requestPermission;

      if (permission !== "granted") {
        return Message.FailedPush({
          message:
            permission === "denied"
              ? "Notifications are blocked for Cairn. Allow them in this browser's site settings, then try again."
              : "Notifications were not allowed. Try again and choose Allow.",
          permission,
        });
      }

      yield* register(yield* currentSubscription(vapidKey));
      yield* savePushWanted(true);

      return Message.SucceededEnable();
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          Message.FailedPush({
            message: causeText(cause),
            permission: currentPermission(),
          })
        )
      )
    ),
});

/** Drops this browser's subscription and tells the server to forget it. */
export const DisablePush = Command.define("DisablePush", {
  messages: [Message.SucceededDisable, Message.FailedPush],
  execute: Effect.gen(function* () {
    yield* savePushWanted(false);

    const endpoint = yield* unsubscribeDevice;

    if (Option.isSome(endpoint)) {
      const client = yield* CairnConnection.get;

      yield* client["push.unsubscribe"]({ endpoint: endpoint.value });
    }

    return Message.SucceededDisable();
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(
        Message.FailedPush({
          message: causeText(cause),
          permission: currentPermission(),
        })
      )
    )
  ),
});

/** Writes `count` to the app icon's badge. */
export const ShowBadge = Command.define("ShowBadge", {
  args: { count: Schema.Int },
  messages: [Message.ShowedBadge],
  execute: ({ count }) =>
    setAppBadge(count).pipe(Effect.as(Message.ShowedBadge({ count }))),
});

/**
 * The load's re-check (run by a Subscription): iOS drops subscriptions silently, so with the
 * permission granted the subscription for the server's key is fetched or made again and sent to
 * the server every time the app starts.
 */
export const syncSubscription = (vapidKey: string) =>
  Effect.gen(function* () {
    yield* register(yield* currentSubscription(vapidKey));

    return Message.SyncedSubscription({ subscribed: true });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(
        Message.FailedPush({
          message: causeText(cause),
          permission: currentPermission(),
        })
      )
    )
  );

/** One presence report (run by a Subscription); a failure is quiet, the next report follows. */
export const reportPresence = (input: {
  readonly deviceId: string;
  readonly threadId: Option.Option<ThreadId>;
}) =>
  Effect.gen(function* () {
    const client = yield* CairnConnection.get;

    yield* client["presence.report"]({
      deviceId: input.deviceId,
      visible: document.visibilityState === "visible",
      threadId: input.threadId,
    });
  }).pipe(withBoundary, Effect.ignore, Effect.as(Message.ReportedPresence()));
