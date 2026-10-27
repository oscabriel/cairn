// Ported from cairn-v1, apps/web/src/push.ts at 1a5cd4a. Kept: the browser's side of Web Push is the
// service worker registration's PushManager bound to the server's VAPID key; a subscription bound
// to another key (a server whose key was made again) is unsubscribed first, since `subscribe` with a
// new key throws InvalidStateError while it exists, and its endpoint is handed back for the server
// to forget; the service worker gets 10 seconds to become ready; the app badge is best effort.
// Changed: Effects instead of promises, `PushSubscriptionInput` from the protocol, the iOS rule
// (PushManager exists only in an installed web app opened from the Home Screen), this device's
// presence id, and `/sw.js` registered here at scope `/`.

import type { PushSubscriptionInput } from "@cairn/protocol/Push";
import { Duration, Effect, Option, Predicate, Schema } from "effect";

import { mintUuid7 } from "../composer/Ids.ts";

/** Something the browser refused while turning push on or off. */
export class PushDeviceError extends Schema.TaggedError<PushDeviceError>()(
  "PushDeviceError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** How long the service worker gets to become active before push gives up for this load. */
const READY_TIMEOUT = Duration.seconds(10);

/** Where this device keeps its presence id. */
export const DEVICE_ID_KEY = "cairn:push-device:v1";

/** Where this device remembers that its user turned push on (the permission alone cannot say). */
export const PUSH_WANTED_KEY = "cairn:push-wanted:v1";

/** The service worker's path and scope. */
export const SERVICE_WORKER_PATH = "/sw.js";

/** What this browser can do about push. */
export const PushSupport = Schema.Literals([
  /** No service worker, PushManager or Notification here. */
  "unsupported",
  /** iOS Safari outside the installed app: push needs the Home Screen app. */
  "needs-home-screen",
  "supported",
]);

/** What this browser can do about push. */
export type PushSupport = typeof PushSupport.Type;

/** The notification permission as the browser reports it. */
export const PushPermission = Schema.Literals(["default", "granted", "denied"]);

/** The notification permission. */
export type PushPermission = typeof PushPermission.Type;

const isIos = (): boolean =>
  /iPad|iPhone|iPod/u.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (Predicate.hasProperty(navigator, "standalone") &&
    navigator.standalone === true);

/** True when the browser has everything Web Push needs. */
export const isPushSupported = (): boolean =>
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

/** What this browser can do about push, with iOS outside the Home Screen app told apart. */
export const pushSupport = (): PushSupport => {
  if (isPushSupported()) {
    return "supported";
  }

  return isIos() && !isStandalone() ? "needs-home-screen" : "unsupported";
};

/** The current permission; `default` where notifications do not exist. */
export const currentPermission = (): PushPermission =>
  "Notification" in window ? Notification.permission : "default";

const failed =
  (what: string) =>
  (cause: unknown): PushDeviceError =>
    new PushDeviceError({
      message: `${what}${Predicate.isError(cause) ? `: ${cause.message}` : "."}`,
      cause,
    });

/** Registers `/sw.js` at scope `/`. A browser without service workers does nothing. */
export const registerServiceWorker = Effect.gen(function* () {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  yield* Effect.tryPromise({
    try: async () =>
      await navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
        scope: "/",
      }),
    catch: failed("The service worker did not register"),
  });
});

const ready = Effect.tryPromise({
  try: async () => await navigator.serviceWorker.ready,
  catch: failed("The service worker did not start"),
}).pipe(
  Effect.timeoutOrElse({
    duration: READY_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new PushDeviceError({
          message: "The service worker did not start within 10 seconds.",
          cause: undefined,
        })
      ),
  })
);

const keyBytes = (base64url: string): Uint8Array<ArrayBuffer> => {
  const base64 = base64url
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }

  return bytes;
};

const isBoundTo = (
  subscription: PushSubscription,
  publicKey: string
): boolean => {
  const bound = subscription.options.applicationServerKey;

  if (bound === null) {
    return false;
  }

  const left = new Uint8Array(bound);
  const right = keyBytes(publicKey);

  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
};

/** What the server stores, from the browser's subscription. */
export const subscriptionInput = (
  subscription: PushSubscription
): PushSubscriptionInput => {
  const json = subscription.toJSON();

  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
  };
};

/** A subscription bound to the server's key, and the endpoint of one it replaced. */
export interface CurrentSubscription {
  readonly subscription: PushSubscriptionInput;
  readonly replaced: Option.Option<string>;
}

/**
 * The registration's subscription for `publicKey`, made when there is none. One bound to another
 * key is unsubscribed first. Needs the permission already granted.
 */
export const currentSubscription = Effect.fn("PushDevice.currentSubscription")(
  function* (publicKey: string) {
    const registration = yield* ready;

    const existing = yield* Effect.tryPromise({
      try: async () => await registration.pushManager.getSubscription(),
      catch: failed("The browser could not read its push subscription"),
    });

    if (existing !== null && isBoundTo(existing, publicKey)) {
      return {
        subscription: subscriptionInput(existing),
        replaced: Option.none(),
      };
    }

    if (existing !== null) {
      yield* Effect.tryPromise({
        try: async () => await existing.unsubscribe(),
        catch: failed("The browser could not drop its old push subscription"),
      });
    }

    const made = yield* Effect.tryPromise({
      try: async () =>
        await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        }),
      catch: failed("The browser refused the push subscription"),
    });

    return {
      subscription: subscriptionInput(made),
      replaced: Option.map(
        Option.fromNullishOr(existing),
        ({ endpoint }) => endpoint
      ),
    };
  }
);

/** Asks for the notification permission (from a tap, as iOS requires) and returns the answer. */
export const requestPermission = Effect.tryPromise({
  try: async () => await Notification.requestPermission(),
  catch: failed("The browser did not ask for the notification permission"),
});

/** Drops this browser's subscription; its endpoint when there was one. */
export const unsubscribeDevice = Effect.gen(function* () {
  const registration = yield* ready;

  const existing = yield* Effect.tryPromise({
    try: async () => await registration.pushManager.getSubscription(),
    catch: failed("The browser could not read its push subscription"),
  });

  if (existing === null) {
    return Option.none<string>();
  }

  yield* Effect.tryPromise({
    try: async () => await existing.unsubscribe(),
    catch: failed("The browser could not drop its push subscription"),
  });

  return Option.some(existing.endpoint);
});

/** Shows `count` on the app icon (nothing at zero). Missing outside an installed app; never fails. */
export const setAppBadge = (count: number) =>
  Effect.tryPromise(async () => {
    if (!("setAppBadge" in navigator)) {
      return;
    }

    await (count > 0
      ? navigator.setAppBadge(count)
      : navigator.clearAppBadge());
  }).pipe(Effect.ignore);

const DeviceId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/u)
);

const isDeviceId = Schema.is(DeviceId);

/** A fresh id; kept in storage, or used for this load alone when storage refuses it. */
const freshId = Effect.map(mintUuid7, (id) => id.replaceAll("-", ""));

/**
 * This device's presence id, made and kept in localStorage the first time it is asked for. A
 * storage that throws (private mode, a full quota) gives this load's own id instead of a defect
 * that would crash the page at load (T37).
 */
export const loadDeviceId = Effect.gen(function* () {
  const made = yield* freshId;

  return yield* Effect.try(() => {
    const stored = localStorage.getItem(DEVICE_ID_KEY);

    if (stored !== null && isDeviceId(stored)) {
      return stored;
    }

    localStorage.setItem(DEVICE_ID_KEY, made);

    return made;
  }).pipe(Effect.orElseSucceed(() => made));
});

/**
 * True when the user turned push on here and has not turned it off since. The load's re-check
 * makes a dropped subscription again only then, so "off" stays off while the permission stays
 * granted.
 */
export const loadPushWanted = Effect.try(
  () => localStorage.getItem(PUSH_WANTED_KEY) === "1"
).pipe(Effect.orElseSucceed(() => false));

/** Remembers whether the user wants push on this device. */
export const savePushWanted = (wanted: boolean) =>
  Effect.try(() => {
    if (wanted) {
      localStorage.setItem(PUSH_WANTED_KEY, "1");
    } else {
      localStorage.removeItem(PUSH_WANTED_KEY);
    }
  }).pipe(Effect.ignore);
