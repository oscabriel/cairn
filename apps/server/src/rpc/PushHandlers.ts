// `push.subscribe`, `push.unsubscribe` and `presence.report`: thin calls into the push services that
// translate their failures into the protocol's errors, carrying the RPC request id. Also the VAPID
// public key in `session.hello`, which a page needs before it can subscribe.
import { InvalidInput, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs, Viewer } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import { Presence } from "../push/Presence.ts";
import { PushSubscriptions } from "../push/PushSubscriptions.ts";
import type {
  PushEndpointRefused,
  PushStoreError,
} from "../push/PushSubscriptions.ts";
import { Vapid } from "../push/Vapid.ts";
import { SessionHello } from "./SessionHandlers.ts";

const unavailable = (requestId: string) => (failure: PushStoreError) =>
  new Unavailable({
    message: failure.message,
    requestId: Option.some(requestId),
  });

const refused = (requestId: string) => (failure: PushEndpointRefused) =>
  new InvalidInput({
    message: failure.message,
    field: Option.some("endpoint"),
    requestId: Option.some(requestId),
  });

/** `push.subscribe`: stores this device's subscription for the admitted login. */
export const PushSubscribeHandler = CairnRpcs.toLayerHandler(
  "push.subscribe",
  Effect.gen(function* () {
    const subscriptions = yield* PushSubscriptions;

    return (input, { requestId }) =>
      Effect.gen(function* () {
        const viewer = yield* Viewer;

        yield* subscriptions.upsert(viewer.login, input);
      }).pipe(
        Effect.catchTags({
          PushEndpointRefused: (failure) =>
            Effect.fail(refused(String(requestId))(failure)),
          PushStoreError: (failure) =>
            Effect.fail(unavailable(String(requestId))(failure)),
        })
      );
  })
);

/** `push.unsubscribe`: forgets a device's subscription. */
export const PushUnsubscribeHandler = CairnRpcs.toLayerHandler(
  "push.unsubscribe",
  Effect.gen(function* () {
    const subscriptions = yield* PushSubscriptions;

    return (input, { requestId }) =>
      subscriptions
        .remove(input.endpoint)
        .pipe(Effect.mapError(unavailable(String(requestId))));
  })
);

/** `presence.report`: what a page shows, so a push skips the thread on screen. */
export const PresenceReportHandler = CairnRpcs.toLayerHandler(
  "presence.report",
  Effect.gen(function* () {
    const presence = yield* Presence;

    return (report) => presence.report(report);
  })
);

/** Every handler this module owns. Needs `PushSubscriptions` and `Presence`. */
export const PushHandlers = Layer.mergeAll(
  PushSubscribeHandler,
  PushUnsubscribeHandler,
  PresenceReportHandler
);

/** `SessionHello` with the VAPID public key. Needs the base `SessionHello` and `Vapid`. */
export const SessionHelloWithPush = Layer.effect(
  SessionHello,
  Effect.gen(function* () {
    const base = yield* SessionHello;
    const vapid = yield* Vapid;

    return SessionHello.of({
      ...base,
      vapidPublicKey: Effect.succeedSome(vapid.keys.publicKey),
    });
  })
);
