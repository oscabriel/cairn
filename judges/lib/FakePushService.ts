// A push service on loopback for judges: it takes Web Push POSTs to `/push/<name>`, decrypts each
// with the subscription's own browser keys (RFC 8291 and RFC 8188, receiver side, in `node:crypto`,
// as `WebPush.test.ts` does), checks the VAPID header's form, answers 201 and keeps the plaintext.
// A judge subscribes the brain to `subscription(name)` and reads what a phone would have shown.

import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Predicate } from "effect";

/** One push the service took, in arrival order. */
export interface TakenPush {
  readonly name: string;
  /** The decrypted payload, or why it could not be read. */
  readonly plaintext: string;
  readonly decrypted: boolean;
  readonly vapid: boolean;
}

interface Browser {
  readonly ecdh: ReturnType<typeof createECDH>;
  readonly auth: Buffer;
}

const decrypt = (body: Buffer, browser: Browser): string => {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const secret = browser.ecdh.computeSecret(senderPublic);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    browser.ecdh.getPublicKey(),
    senderPublic,
  ]);

  const ikm = Buffer.from(
    hkdfSync("sha256", secret, browser.auth, keyInfo, 32)
  );

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

  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, -16)),
    decipher.final(),
  ]);

  // One record: the plaintext ends with the 0x02 delimiter, then any padding zeros.
  return padded.subarray(0, padded.lastIndexOf(2)).toString("utf-8");
};

/**
 * Starts the service on a free loopback port for the scope's life. `subscription(name)` makes a
 * browser's keys for `name` and answers the subscription a device would send; `taken` fills as
 * pushes arrive.
 */
export const startFakePushService = Effect.gen(function* () {
  const browsers = new Map<string, Browser>();
  const taken: Array<TakenPush> = [];

  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];

    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      const name = (request.url ?? "").replace(/^\/push\//u, "");
      const browser = browsers.get(name);

      const vapid = /^vapid t=[\w.-]+, k=[\w-]+$/u.test(
        request.headers.authorization ?? ""
      );

      if (browser === undefined) {
        response.writeHead(404).end();

        return;
      }

      try {
        taken.push({
          name,
          plaintext: decrypt(Buffer.concat(chunks), browser),
          decrypted: true,
          vapid,
        });
      } catch (error) {
        taken.push({ name, plaintext: String(error), decrypted: false, vapid });
      }

      response.writeHead(201).end();
    });
  });

  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () => {
        const address: AddressInfo | string | null = server.address();

        resume(
          Effect.succeed(
            address === null || Predicate.isString(address) ? 0 : address.port
          )
        );
      });
    }),
    () =>
      Effect.callback<boolean>((resume) => {
        server.closeAllConnections();
        server.close(() => {
          resume(Effect.succeed(true));
        });
      })
  );

  const base = `http://127.0.0.1:${String(port)}`;

  const subscription = (name: string) => {
    const ecdh = createECDH("prime256v1");

    ecdh.generateKeys();

    // Any 16 octets do; the name makes each device's secret its own.
    const auth = Buffer.from(name.padEnd(16, "-").slice(0, 16));

    browsers.set(name, { ecdh, auth });

    return {
      endpoint: `${base}/push/${name}`,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    };
  };

  return { base, taken, subscription };
});
