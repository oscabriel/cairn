// Judges the Web Push sender against outside references: RFC 8291's Appendix A example (the same
// keys, salt and plaintext must give the same octets), a receiver written with `node:crypto` rather
// than WebCrypto (it decrypts what the sender sent and verifies the VAPID JWT against the key in
// `k=`), and the push service's answer passed through. Ported in part from cairn-v1
// apps/server/test/webpush.test.ts at 1a5cd4a (the receiver and the checks on headers and claims).

import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";

import { generateVapidKeyPair, Vapid } from "./Vapid.ts";
import type { VapidKeys } from "./Vapid.ts";
import {
  encryptPayload,
  fromBase64Url,
  PushEntropy,
  senderKeysFrom,
  toBase64Url,
  VAPID_TOKEN_LIFETIME,
  WebPush,
} from "./WebPush.ts";

// RFC 8291, Appendix A (whitespace removed).
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

const rfcBody = Buffer.concat([
  Buffer.from(RFC.header, "base64url"),
  Buffer.from(RFC.ciphertext, "base64url"),
]);

const rfcEntropy = {
  draw: senderKeysFrom({
    privateKey: RFC.asPrivate,
    publicKey: RFC.asPublic,
    salt: RFC.salt,
  }),
};

/** A browser's side of a subscription, in `node:crypto`. */
interface Browser {
  readonly ecdh: ReturnType<typeof createECDH>;
  readonly auth: Buffer;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

const browser = (): Browser => {
  const ecdh = createECDH("prime256v1");

  ecdh.generateKeys();

  const auth = randomBytes(16);

  return {
    ecdh,
    auth,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
};

const rfcBrowser = (): Browser => {
  const ecdh = createECDH("prime256v1");

  ecdh.setPrivateKey(Buffer.from(RFC.uaPrivate, "base64url"));

  return {
    ecdh,
    auth: Buffer.from(RFC.authSecret, "base64url"),
    keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
  };
};

/** RFC 8291 and RFC 8188, receiver side, in `node:crypto`. */
const decrypt = (body: Buffer, ua: Browser): string => {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  assert.strictEqual(recordSize, 4096);
  assert.strictEqual(idLength, 65);

  const ecdhSecret = ua.ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    ua.ecdh.getPublicKey(),
    asPublic,
  ]);

  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, ua.auth, keyInfo, 32));

  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0"),
      16
    )
  );

  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)
  );

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);

  decipher.setAuthTag(ciphertext.subarray(-16));

  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, -16)),
    decipher.final(),
  ]);

  let end = plain.length - 1;

  while (end >= 0 && plain[end] === 0) {
    end -= 1;
  }

  assert.strictEqual(plain[end], 2, "the last record ends with 0x02");

  return plain.subarray(0, end).toString("utf-8");
};

const Claims = Schema.Struct({
  aud: Schema.String,
  exp: Schema.Int,
  sub: Schema.String,
});

const decodeClaims = Schema.decodeUnknownSync(Schema.fromJsonString(Claims));

const decodeHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ typ: Schema.String, alg: Schema.String })
  )
);

/** Verifies the VAPID header with `node:crypto` against the key it names, and returns its claims. */
const checkVapid = (authorization: string, vapid: VapidKeys) => {
  const match = /^vapid t=(?<token>[^,]+), k=(?<key>.+)$/u.exec(authorization);
  const token = match?.groups?.token ?? "";
  const key = match?.groups?.key ?? "";

  assert.strictEqual(key, vapid.publicKey);

  const [header = "", claims = "", signature = ""] = token.split(".");

  assert.deepStrictEqual(
    decodeHeader(Buffer.from(header, "base64url").toString()),
    { typ: "JWT", alg: "ES256" }
  );

  const raw = Buffer.from(key, "base64url");

  const publicKey = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });

  assert.isTrue(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url")
    ),
    "the JWT signature verifies with the key in k="
  );

  return decodeClaims(Buffer.from(claims, "base64url").toString());
};

interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A local push service: records each POST and answers with `status`. */
const pushService = (status: number) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly origin: string;
      readonly received: Array<Received>;
      readonly close: () => void;
    }>((resume) => {
      const received: Array<Received> = [];

      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = [];

        request.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          received.push({
            path: request.url ?? "",
            headers: request.headers,
            body: Buffer.concat(chunks),
          });
          response.statusCode = status;
          response.end(
            status >= 400 ? "push subscription has unsubscribed or expired" : ""
          );
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = Predicate.isObject(address) ? address.port : 0;

        resume(
          Effect.succeed({
            origin: `http://127.0.0.1:${String(port)}`,
            received,
            close: () => {
              server.close();
            },
          })
        );
      });
    }),
    (service) => Effect.sync(service.close)
  );

/** 2026-10-22T12:00:00Z. */
const NOW = 1_792_670_400_000;

const withSender = (keys: VapidKeys) =>
  Effect.provide(WebPush.layer.pipe(Layer.provide(Vapid.layerFromKeys(keys))));

describe(WebPush, () => {
  it.effect("reproduces RFC 8291's Appendix A byte for byte", () =>
    Effect.gen(function* () {
      const sender = yield* rfcEntropy.draw;

      const body = yield* encryptPayload(
        {
          endpoint:
            "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
          keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
        },
        new TextEncoder().encode(RFC.plaintext),
        sender
      );

      assert.strictEqual(toBase64Url(body.subarray(0, 86)), RFC.header);
      assert.strictEqual(toBase64Url(body.subarray(86)), RFC.ciphertext);
      assert.isTrue(Buffer.from(body).equals(rfcBody));
      assert.strictEqual(
        decrypt(Buffer.from(body), rfcBrowser()),
        RFC.plaintext
      );
    })
  );

  it.effect(
    "sends the RFC body to the push service with the injected randomness, and a VAPID JWT that verifies",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);

        const service = yield* pushService(201);
        const keys = yield* generateVapidKeyPair;

        const response = yield* WebPush.use((push) =>
          push.send(
            {
              endpoint: `${service.origin}/push/abc`,
              keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret },
            },
            RFC.plaintext,
            { ttlSeconds: 600, urgency: "high" }
          )
        ).pipe(
          withSender(keys),
          Effect.provideService(PushEntropy, rfcEntropy)
        );

        assert.deepStrictEqual(response, { status: 201, body: "" });
        assert.strictEqual(service.received.length, 1);

        const [push] = service.received;

        assert.isDefined(push);
        assert.strictEqual(push?.path, "/push/abc");
        assert.isTrue(push?.body.equals(rfcBody));
        assert.strictEqual(push?.headers["content-encoding"], "aes128gcm");
        assert.strictEqual(
          push?.headers["content-type"],
          "application/octet-stream"
        );
        assert.strictEqual(push?.headers.ttl, "600");
        assert.strictEqual(push?.headers.urgency, "high");

        const claims = checkVapid(String(push?.headers.authorization), keys);

        assert.strictEqual(claims.aud, service.origin);
        assert.strictEqual(claims.sub, "mailto:admin@gneiss.run");
        assert.isAbove(claims.exp * 1000, NOW);
        assert.isAtMost(claims.exp * 1000, NOW + 24 * 3_600_000);
        assert.strictEqual(
          claims.exp * 1000,
          NOW + Duration.toMillis(VAPID_TOKEN_LIFETIME)
        );
      })
  );

  it.effect(
    "encrypts every push afresh, and a node:crypto receiver reads it",
    () =>
      Effect.gen(function* () {
        const service = yield* pushService(201);
        const keys = yield* generateVapidKeyPair;
        const ua = browser();
        const target = { endpoint: `${service.origin}/push/ua`, keys: ua.keys };

        const message = JSON.stringify({
          title: "Done",
          body: "Finished after 3m 12s.",
          url: "/t/x",
        });

        yield* WebPush.use((push) =>
          Effect.gen(function* () {
            yield* push.send(target, message, {
              ttlSeconds: 60,
              urgency: "normal",
            });
            yield* push.send(target, message, {
              ttlSeconds: 60,
              urgency: "normal",
            });
          })
        ).pipe(withSender(keys));

        const [first, second] = service.received;

        assert.isDefined(first);
        assert.isDefined(second);
        assert.isFalse(first?.body.equals(second?.body ?? Buffer.alloc(0)));
        assert.strictEqual(
          decrypt(first?.body ?? Buffer.alloc(0), ua),
          message
        );
        assert.strictEqual(
          decrypt(second?.body ?? Buffer.alloc(0), ua),
          message
        );
      })
  );

  it.effect("returns the push service's refusal instead of failing", () =>
    Effect.gen(function* () {
      const service = yield* pushService(410);
      const keys = yield* generateVapidKeyPair;

      const response = yield* WebPush.use((push) =>
        push.send(
          { endpoint: `${service.origin}/push/gone`, keys: browser().keys },
          "{}",
          { ttlSeconds: 60, urgency: "normal" }
        )
      ).pipe(withSender(keys));

      assert.deepStrictEqual(response, {
        status: 410,
        body: "push subscription has unsubscribed or expired",
      });
    })
  );

  it.effect("refuses a message that does not fit one record", () =>
    Effect.gen(function* () {
      const sender = yield* rfcEntropy.draw;

      const error = yield* Effect.flip(
        encryptPayload(
          { endpoint: "https://push.example.net/x", keys: browser().keys },
          new Uint8Array(4080),
          sender
        )
      );

      assert.strictEqual(error.operation, "WebPush.encrypt");
    })
  );

  it.effect("makes VAPID keys in web-push's format", () =>
    Effect.gen(function* () {
      const keys = yield* generateVapidKeyPair;

      assert.strictEqual(fromBase64Url(keys.publicKey).length, 65);
      assert.strictEqual(fromBase64Url(keys.privateKey).length, 32);
    })
  );
});
