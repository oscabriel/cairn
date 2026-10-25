// Ported from cairn-v1, apps/server/src/webpush.ts at 1a5cd4a (itself spike 10's sender). Kept: Web
// Push with WebCrypto only, no `web-push` dependency: RFC 8291 `aes128gcm` in one record of 4096
// octets ended by the 0x02 delimiter, the RFC 8292 VAPID JWT signed ES256 (WebCrypto's ECDSA
// signature already is the JWS `r || s` form), `vapid t=..., k=...`, and key pairs in `web-push`'s
// format. Changed: an Effect service over `HttpClient`; the JWT's `exp` comes from `Clock`; the salt
// and the sender's ephemeral key pair come from `PushEntropy`, so a test can replay RFC 8291's
// Appendix A byte for byte; the push service's answer is returned, never thrown.
import type { PushSubscriptionInput } from "@cairn/protocol/Push";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { Vapid } from "./Vapid.ts";
import type { VapidKeys } from "./Vapid.ts";

/** Web Push could not encrypt, sign or deliver a message. Nothing reached the device. */
export class WebPushError extends Schema.TaggedError<WebPushError>()(
  "WebPushError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "WebPush.encrypt",
      "WebPush.sign",
      "WebPush.send",
    ]),
    cause: Schema.Defect(),
  }
) {}

/** The record size every push uses (one record, RFC 8188). */
export const RECORD_SIZE = 4096;

/** The longest plaintext one record holds: the record minus the delimiter and the GCM tag. */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - 1 - 16;

/** How long a VAPID JWT is valid for; RFC 8292 caps it at 24 hours. */
export const VAPID_TOKEN_LIFETIME = Duration.hours(12);

/** How long a push service may take to answer before the send fails. */
const SEND_TIMEOUT = Duration.seconds(15);

/** How long a refused push's body may take to read, after its headers came within the send timeout. */
const BODY_READ_TIMEOUT = Duration.seconds(2);

/** A device's push subscription: its endpoint and its keys, as the browser gave them. */
export type PushTarget = PushSubscriptionInput;

/** The per-message randomness RFC 8291 needs: a salt and the sender's ephemeral ECDH key pair. */
export interface SenderKeys {
  /** 16 random octets. */
  readonly salt: Uint8Array<ArrayBuffer>;
  /** The ephemeral public key, an uncompressed P-256 point (65 octets). */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** The ephemeral private key, usable for ECDH `deriveBits`. */
  readonly privateKey: CryptoKey;
}

/** What `PushEntropy.draw` yields for one message. */
export type DrawSenderKeys = Effect.Effect<SenderKeys, WebPushError>;

/** How a push service answered one POST. */
export interface PushResponse {
  readonly status: number;
  /** The start of the body of a refusal, for the log; empty on success. */
  readonly body: string;
}

/** Per-send options. */
export interface SendOptions {
  /** How long the push service may hold the message for an offline device. */
  readonly ttlSeconds: number;
  readonly urgency: "very-low" | "low" | "normal" | "high";
}

const encoder = new TextEncoder();

const { subtle } = globalThis.crypto;

/** base64url without padding to bytes. */
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, "base64url"));

/** Bytes to base64url without padding. */
export const toBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const concat = (
  ...parts: ReadonlyArray<Uint8Array>
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

const crypto =
  (operation: WebPushError["operation"], what: string) =>
  <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new WebPushError({
          message: `${operation} failed to ${what}. Nothing was sent; check the keys involved.`,
          operation,
          cause,
        }),
    });

const encryptStep = crypto("WebPush.encrypt", "encrypt the message");

const hkdf = (
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number
) =>
  encryptStep(async () => {
    const key = await subtle.importKey("raw", ikm, "HKDF", false, [
      "deriveBits",
    ]);

    return new Uint8Array(
      await subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info },
        key,
        bytes * 8
      )
    );
  });

/** The x and y coordinates of an uncompressed P-256 point, base64url, for a JWK. */
const pointCoordinates = (point: Uint8Array) => ({
  x: toBase64Url(point.slice(1, 33)),
  y: toBase64Url(point.slice(33, 65)),
});

/**
 * Sender keys from known values: a private scalar `d` and its public point, both base64url, and a
 * salt. Tests use it to replay RFC 8291's example; the default `PushEntropy` draws fresh ones.
 */
export const senderKeysFrom = (input: {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly salt: string;
}): DrawSenderKeys =>
  Effect.gen(function* () {
    const publicKey = fromBase64Url(input.publicKey);

    const privateKey = yield* encryptStep(
      async () =>
        await subtle.importKey(
          "jwk",
          {
            kty: "EC",
            crv: "P-256",
            d: input.privateKey,
            ...pointCoordinates(publicKey),
          },
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"]
        )
    );

    return { salt: fromBase64Url(input.salt), publicKey, privateKey };
  });

/** Fresh sender keys: 16 random octets of salt and a new ephemeral P-256 key pair. */
const drawSenderKeys: DrawSenderKeys = Effect.gen(function* () {
  const pair = yield* encryptStep(
    async () =>
      await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])
  );

  const publicKey = new Uint8Array(
    yield* encryptStep(
      async () => await subtle.exportKey("raw", pair.publicKey)
    )
  );

  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));

  return { salt, publicKey, privateKey: pair.privateKey };
});

/** Where each message's salt and ephemeral key pair come from; fresh randomness unless replaced. */
export const PushEntropy = Context.Reference<{
  readonly draw: DrawSenderKeys;
}>("cairn/server/push/WebPush/PushEntropy", {
  defaultValue: () => ({ draw: drawSenderKeys }),
});

/**
 * RFC 8291: `plaintext` encrypted for `target` as one `aes128gcm` record with the sender's keys.
 * Fails when the plaintext does not fit one record or a key is unusable.
 */
export const encryptPayload = Effect.fn("WebPush.encryptPayload")(function* (
  target: PushTarget,
  plaintext: Uint8Array<ArrayBuffer>,
  sender: SenderKeys
) {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    return yield* new WebPushError({
      message: `WebPush.encrypt refused a ${String(plaintext.length)}-octet message: one record holds at most ${String(MAX_PLAINTEXT_BYTES)}. Send a shorter message.`,
      operation: "WebPush.encrypt",
      cause: undefined,
    });
  }

  const uaPublic = fromBase64Url(target.keys.p256dh);
  const authSecret = fromBase64Url(target.keys.auth);

  const uaKey = yield* encryptStep(
    async () =>
      await subtle.importKey(
        "raw",
        uaPublic,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      )
  );

  const ecdhSecret = new Uint8Array(
    yield* encryptStep(
      async () =>
        await subtle.deriveBits(
          { name: "ECDH", public: uaKey },
          sender.privateKey,
          256
        )
    )
  );

  const keyInfo = concat(
    encoder.encode("WebPush: info\0"),
    uaPublic,
    sender.publicKey
  );

  const ikm = yield* hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cek = yield* hkdf(
    sender.salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16
  );

  const nonce = yield* hkdf(
    sender.salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12
  );

  const ciphertext = new Uint8Array(
    yield* encryptStep(async () => {
      const aes = await subtle.importKey("raw", cek, "AES-GCM", false, [
        "encrypt",
      ]);

      return await subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        aes,
        concat(plaintext, new Uint8Array([2]))
      );
    })
  );

  const header = new Uint8Array(16 + 4 + 1 + sender.publicKey.length);

  header.set(sender.salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicKey.length;
  header.set(sender.publicKey, 21);

  return concat(header, ciphertext);
});

const signStep = crypto("WebPush.sign", "sign the VAPID token");

/**
 * RFC 8292: the `Authorization` header for a push to `endpoint`: a JWT for the endpoint's origin,
 * expiring `VAPID_TOKEN_LIFETIME` after `nowMillis`, signed with the VAPID private key.
 */
export const vapidAuthorization = Effect.fn("WebPush.vapidAuthorization")(
  function* (endpoint: string, vapid: VapidKeys, nowMillis: number) {
    const publicKey = fromBase64Url(vapid.publicKey);

    const key = yield* signStep(
      async () =>
        await subtle.importKey(
          "jwk",
          {
            kty: "EC",
            crv: "P-256",
            d: vapid.privateKey,
            ...pointCoordinates(publicKey),
          },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"]
        )
    );

    const header = toBase64Url(
      encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))
    );

    const exp = Math.floor(
      (nowMillis + Duration.toMillis(VAPID_TOKEN_LIFETIME)) / 1000
    );

    const claims = toBase64Url(
      encoder.encode(
        JSON.stringify({
          aud: new URL(endpoint).origin,
          exp,
          sub: vapid.subject,
        })
      )
    );

    const unsigned = `${header}.${claims}`;

    const signature = new Uint8Array(
      yield* signStep(
        async () =>
          await subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            key,
            encoder.encode(unsigned)
          )
      )
    );

    return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
  }
);

/** Sends encrypted, VAPID-signed messages to push services. */
export class WebPush extends Context.Service<
  WebPush,
  {
    /**
     * POSTs `message` (JSON text) to the subscription's push service. Answers with the service's
     * status whatever it is; fails only when nothing came back (network, timeout) or the message
     * could not be encrypted or signed.
     */
    send(
      target: PushTarget,
      message: string,
      options: SendOptions
    ): Effect.Effect<PushResponse, WebPushError>;
  }
>()("cairn/server/push/WebPush") {
  /** Needs `Vapid` and an `HttpClient`. */
  static readonly layerNoDeps = Layer.effect(
    WebPush,
    Effect.gen(function* () {
      const vapid = yield* Vapid;
      const client = yield* HttpClient.HttpClient;

      const send = Effect.fn("WebPush.send")(function* (
        target: PushTarget,
        message: string,
        options: SendOptions
      ) {
        const entropy = yield* PushEntropy;
        const sender = yield* entropy.draw;

        const body = yield* encryptPayload(
          target,
          encoder.encode(message),
          sender
        );

        const authorization = yield* vapidAuthorization(
          target.endpoint,
          vapid.keys,
          yield* Clock.currentTimeMillis
        );

        const request = HttpClientRequest.post(target.endpoint).pipe(
          HttpClientRequest.setHeaders({
            authorization,
            "content-encoding": "aes128gcm",
            ttl: String(Math.max(0, Math.floor(options.ttlSeconds))),
            urgency: options.urgency,
          }),
          HttpClientRequest.bodyUint8Array(body, "application/octet-stream")
        );

        const response = yield* client.execute(request).pipe(
          Effect.timeoutOption(SEND_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new WebPushError({
                message: `WebPush.send got no answer from ${new URL(target.endpoint).host}. The push may be retried.`,
                operation: "WebPush.send",
                cause,
              })
          )
        );

        if (Option.isNone(response)) {
          return yield* new WebPushError({
            message: `WebPush.send timed out after ${String(Duration.toSeconds(SEND_TIMEOUT))} s waiting for ${new URL(target.endpoint).host}. The push may be retried.`,
            operation: "WebPush.send",
            cause: undefined,
          });
        }

        const { status } = response.value;
        const ok = status >= 200 && status < 300;

        const text = ok
          ? ""
          : yield* response.value.text.pipe(
              Effect.map((full) => full.slice(0, 200)),
              // The send timeout ended with the headers; a body that never comes must not hold
              // the delivery (T36).
              Effect.timeoutOption(BODY_READ_TIMEOUT),
              Effect.map(Option.getOrElse(() => "")),
              Effect.orElseSucceed(() => "")
            );

        return { status, body: text };
      });

      return WebPush.of({ send });
    })
  );

  /** Over the global `fetch`. Needs `Vapid`. */
  static readonly layer = WebPush.layerNoDeps.pipe(
    Layer.provide(FetchHttpClient.layer)
  );
}
