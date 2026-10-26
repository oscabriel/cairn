// The push toggle's Messages and the one OutMessage it hands the root: a tapped notification asks
// the page to open a path.

import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { PushPermission, PushSupport } from "./PushDevice.ts";

/** Everything the push toggle reacts to. */
export const Message = defineMessageUnion({
  /**
   * The device was looked at: what it supports, its permission, its presence id, and whether its
   * user turned push on here.
   */
  CheckedDevice: {
    support: PushSupport,
    permission: PushPermission,
    deviceId: Schema.String,
    wanted: Schema.Boolean,
  },
  /** The load's re-check: subscribed (and the server told) or not subscribed. */
  SyncedSubscription: { subscribed: Schema.Boolean },
  /** The switch was flipped. */
  ToggledNotifications: { isChecked: Schema.Boolean },
  SucceededEnable: {},
  SucceededDisable: {},
  /** Turning push on or off failed; `permission` is the browser's answer when it asked. */
  FailedPush: { message: Schema.String, permission: PushPermission },
  /** A presence report went out (or failed quietly). */
  ReportedPresence: {},
  /** The app badge shows `count`. */
  ShowedBadge: { count: Schema.Int },
  /** The service worker asks the page to open `path` (a tapped notification). */
  ReceivedOpenRequest: { path: Schema.String },
});

/** A push toggle Message. */
export type Message = typeof Message.Type;

/** What the push toggle asks the root to do. */
export const OutMessage = defineMessageUnion({
  /** Go to `path` inside the app (a same-origin path the service worker checked). */
  RequestedNavigate: { path: Schema.String },
});

/** A push toggle OutMessage. */
export type OutMessage = typeof OutMessage.Type;
