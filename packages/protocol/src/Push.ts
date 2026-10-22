// Web Push: the VAPID key a device subscribes with, its subscription, and the presence reports that
// keep a push from firing for a thread the user is looking at.
import { Schema } from "effect";

import { ThreadId } from "./Ids.ts";

/** The server's VAPID public key, base64url, as `PushManager.subscribe` takes it. */
export const VapidKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{40,128}$/u)
);

export type VapidKey = typeof VapidKey.Type;

/** A browser push subscription, as `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String.check(
    Schema.isPattern(/^https:\/\//u),
    Schema.isMaxLength(2048)
  ),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMaxLength(256)),
    auth: Schema.String.check(Schema.isMaxLength(64)),
  }),
});

export type PushSubscriptionInput = typeof PushSubscriptionInput.Type;

/** `push.unsubscribe` input. */
export const PushUnsubscribeInput = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
});

export type PushUnsubscribeInput = typeof PushUnsubscribeInput.Type;

/** A device saying what it shows: sent every 15 seconds and on every visibility change. */
export const PresenceReport = Schema.Struct({
  /** The device's own random id, kept in its storage. */
  deviceId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/u)),
  visible: Schema.Boolean,
  /** The thread on screen, when a thread page is open. */
  threadId: Schema.OptionFromNullOr(ThreadId),
});

export type PresenceReport = typeof PresenceReport.Type;
