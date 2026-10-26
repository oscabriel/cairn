// The push toggle's state: what the root tells it (the connection, the VAPID key from
// `session.hello`, the thread on screen, the badge count), what this browser can do, and whether
// this device is subscribed.

import { ThreadId } from "@cairn/protocol/Ids";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { PushPermission, PushSupport } from "./PushDevice.ts";

/** What the root tells the toggle on every change. */
export const PushContext = Schema.Struct({
  epoch: Schema.Int,
  hasClient: Schema.Boolean,
  /** The server's VAPID public key, from the epoch's `session.hello`. */
  vapidKey: Schema.Option(Schema.String),
  /** The thread on screen, which presence reports name. */
  threadId: Schema.Option(ThreadId),
  /** Threads with something for the user, for the app icon's badge. */
  badge: Schema.Int,
});

/** What the root tells the toggle. */
export type PushContext = typeof PushContext.Type;

/** Whether this device gets pushes. */
export const PushStatus = defineTaggedUnion({
  /** Not checked yet on this load. */
  Unknown: {},
  Off: {},
  On: {},
  /** Turning on or off. */
  Working: {},
  Failed: { message: Schema.String },
});

/** Whether this device gets pushes. */
export type PushStatus = typeof PushStatus.Type;

/** The toggle's Model. */
export const Model = Schema.Struct({
  context: PushContext,
  /** None until the device was checked on this load. */
  support: Schema.Option(PushSupport),
  permission: PushPermission,
  status: PushStatus,
  /** True once this load re-registered the subscription with the server (or found none). */
  synced: Schema.Boolean,
  /** This device's presence id. */
  deviceId: Schema.Option(Schema.String),
  /**
   * The badge last written to the app icon on this load; -1 before the first, since the service
   * worker may have left one while the page was closed (T37).
   */
  shownBadge: Schema.Int,
});

/** The toggle's Model. */
export type Model = typeof Model.Type;

/** A toggle that has not looked at the device yet. */
export const initial: Model = {
  context: {
    epoch: 0,
    hasClient: false,
    vapidKey: Option.none(),
    threadId: Option.none(),
    badge: 0,
  },
  support: Option.none(),
  permission: "default",
  status: PushStatus.Unknown(),
  synced: false,
  deviceId: Option.none(),
  shownBadge: -1,
};
