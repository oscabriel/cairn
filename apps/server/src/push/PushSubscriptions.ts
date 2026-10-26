// Ported from cairn-v1, apps/server/src/Push.ts (`isPushEndpoint` and the subscription statements) at
// 1a5cd4a. Kept: one row per endpoint, upserted with the keys the browser sent last; only an https
// URL on a known push service (Apple, Google's FCM, Mozilla, Microsoft) with no port and no user
// info is stored, so a subscription can never aim Cairn's POSTs anywhere else; a refused
// subscription is deleted only when its keys are still the ones the push went to. Changed: an Effect
// service over `cairn.sqlite`; rows record the login that subscribed instead of a device name.

import type { PushSubscriptionInput } from "@cairn/protocol/Push";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** The push services browsers subscribe through. */
const PUSH_HOSTS: ReadonlyArray<RegExp> = [
  /^(?<sub>[a-z0-9-]+\.)*push\.apple\.com$/u,
  /^fcm\.googleapis\.com$/u,
  /^(?<sub>[a-z0-9-]+\.)*push\.services\.mozilla\.com$/u,
  /^(?<sub>[a-z0-9-]+\.)*notify\.windows\.com$/u,
];

/** True for an https URL on a known push service, with no port and no user info. */
export const isPushEndpoint = (endpoint: string): boolean => {
  const url = URL.parse(endpoint);

  return (
    url !== null &&
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    PUSH_HOSTS.some((host) => host.test(url.hostname))
  );
};

/** Which endpoints `push.subscribe` accepts; the known push services unless a test says otherwise. */
export const PushEndpointRule = Context.Reference<{
  readonly allows: (endpoint: string) => boolean;
}>("cairn/server/push/PushSubscriptions/PushEndpointRule", {
  defaultValue: () => ({ allows: isPushEndpoint }),
});

/** The host of an endpoint, for logs and messages; never the path, which identifies the device. */
export const endpointHost = (endpoint: string): string =>
  URL.parse(endpoint)?.hostname ?? "unknown host";

/** The subscription's endpoint is not a push service Cairn sends to. Nothing was stored. */
export class PushEndpointRefused extends Schema.TaggedError<PushEndpointRefused>()(
  "PushEndpointRefused",
  {
    message: Schema.String,
    host: Schema.String,
  }
) {}

/** The subscription table could not be read or written. Nothing changed; retry. */
export class PushStoreError extends Schema.TaggedError<PushStoreError>()(
  "PushStoreError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}

const storeFailure = (operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new PushStoreError({
        message: `${operation} could not use cairn.sqlite's push tables. Nothing changed; retry.`,
        operation,
        cause,
      })
  );

const Row = Schema.Struct({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toSubscription = (row: typeof Row.Type): PushSubscriptionInput => ({
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});

/** Decoded bytes of a base64url string, or none when it is not base64url. */
const base64UrlBytes = (text: string): Option.Option<Uint8Array> =>
  /^[A-Za-z0-9_-]*={0,2}$/u.test(text)
    ? Option.some(Uint8Array.from(Buffer.from(text, "base64url")))
    : Option.none();

/** Whether a subscription's keys are an uncompressed P-256 point and a 16-byte auth secret. */
export const hasValidKeys = (subscription: PushSubscriptionInput): boolean =>
  Option.exists(
    base64UrlBytes(subscription.keys.p256dh),
    (point) => point.length === 65 && point[0] === 0x04
  ) &&
  Option.exists(
    base64UrlBytes(subscription.keys.auth),
    (secret) => secret.length === 16
  );

/** The devices that asked for pushes, one row per endpoint. */
export class PushSubscriptions extends Context.Service<
  PushSubscriptions,
  {
    /** Stores `subscription` for `login`, replacing the keys of the same endpoint. */
    upsert(
      login: string,
      subscription: PushSubscriptionInput
    ): Effect.Effect<void, PushEndpointRefused | PushStoreError>;
    /** Forgets `endpoint`; forgetting an unknown one is not an error. */
    remove(endpoint: string): Effect.Effect<void, PushStoreError>;
    /** Forgets a subscription the push service refused, unless its keys changed since. */
    removeRefused(
      subscription: PushSubscriptionInput
    ): Effect.Effect<void, PushStoreError>;
    /** Every stored subscription. */
    readonly list: Effect.Effect<
      ReadonlyArray<PushSubscriptionInput>,
      PushStoreError
    >;
    /** Records a delivery the push service accepted. */
    markDelivered(endpoint: string): Effect.Effect<void, PushStoreError>;
  }
>()("cairn/server/push/PushSubscriptions") {
  /** Reads and writes `push_subscriptions` through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    PushSubscriptions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const upsert = Effect.fn("PushSubscriptions.upsert")(function* (
        login: string,
        subscription: PushSubscriptionInput
      ) {
        const rule = yield* PushEndpointRule;

        if (!rule.allows(subscription.endpoint)) {
          const host = endpointHost(subscription.endpoint);

          return yield* new PushEndpointRefused({
            message: `PushSubscriptions refused ${host}: it is not a push service Cairn sends to (Apple, Google, Mozilla or Microsoft).`,
            host,
          });
        }

        // A key that is not a P-256 point (65 bytes from 0x04) or a 16-byte secret would fail every
        // push to this device, three times each, forever (T36).
        if (!hasValidKeys(subscription)) {
          return yield* new PushEndpointRefused({
            message:
              "PushSubscriptions refused a subscription whose keys are not a P-256 point and a 16-byte secret. Subscribe again from the browser.",
            host: endpointHost(subscription.endpoint),
          });
        }

        const now = yield* Clock.currentTimeMillis;

        return yield* sql`
          INSERT INTO push_subscriptions (endpoint, p256dh, auth, login, created_at, updated_at)
          VALUES (
            ${subscription.endpoint},
            ${subscription.keys.p256dh},
            ${subscription.keys.auth},
            ${login},
            ${now},
            ${now}
          )
          ON CONFLICT (endpoint) DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            login = excluded.login,
            updated_at = excluded.updated_at
        `.pipe(Effect.asVoid, storeFailure("PushSubscriptions.upsert"));
      });

      const remove = Effect.fn("PushSubscriptions.remove")(function* (
        endpoint: string
      ) {
        yield* sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`.pipe(
          storeFailure("PushSubscriptions.remove")
        );
      });

      const removeRefused = Effect.fn("PushSubscriptions.removeRefused")(
        function* (subscription: PushSubscriptionInput) {
          yield* sql`
            DELETE FROM push_subscriptions
            WHERE endpoint = ${subscription.endpoint}
              AND p256dh = ${subscription.keys.p256dh}
              AND auth = ${subscription.keys.auth}
          `.pipe(storeFailure("PushSubscriptions.removeRefused"));
        }
      );

      const list = sql`
        SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at, endpoint
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows.map(toSubscription)),
        storeFailure("PushSubscriptions.list")
      );

      const markDelivered = Effect.fn("PushSubscriptions.markDelivered")(
        function* (endpoint: string) {
          const now = yield* Clock.currentTimeMillis;

          yield* sql`
            UPDATE push_subscriptions SET last_ok_at = ${now} WHERE endpoint = ${endpoint}
          `.pipe(storeFailure("PushSubscriptions.markDelivered"));
        }
      );

      return PushSubscriptions.of({
        upsert,
        remove,
        removeRefused,
        list,
        markDelivered,
      });
    })
  );
}
