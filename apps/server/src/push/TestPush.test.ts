// Judges the wizard's test push and the key choice: `sendTestPush` reads a brain's `push.json` and
// `cairn.sqlite` without writing either and reports each push service's answer by host; it refuses
// to start without a key rather than making one; and every brain but the deployed one gets its
// VAPID key in memory, so dev brains, judges and tests never touch `push.json`.

import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Predicate } from "effect";
import { SqlClient } from "effect/sql";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { Push0005 } from "../db/migrations/0005Push.ts";
import { sendTestPush } from "./TestPush.ts";
import { Vapid, VAPID_FILE, VapidKeyFromFile } from "./Vapid.ts";

const tempDir = Effect.acquireRelease(
  Effect.promise(
    async () => await mkdtemp(path.join(os.tmpdir(), "cairn-test-push-"))
  ),
  (dir) =>
    Effect.promise(async () => {
      await rm(dir, { recursive: true, force: true });
    })
);

/** A push service on loopback that answers every POST with 201 and counts them. */
const fakePushService = Effect.acquireRelease(
  Effect.promise(async () => {
    const received: Array<number> = [];

    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];

      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        received.push(Buffer.concat(chunks).length);
        response.writeHead(201).end();
      });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    const port = Predicate.isObject(address) ? address.port : 0;

    return { server, received, origin: `http://127.0.0.1:${String(port)}` };
  }),
  ({ server }) =>
    Effect.promise(async () => {
      const closed = once(server, "close");

      server.close();
      await closed;
    })
);

/** A browser's subscription keys: a P-256 point and a 16-octet auth secret. */
const receiverKeys = Effect.promise(async () => {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const raw = await globalThis.crypto.subtle.exportKey("raw", pair.publicKey);

  return {
    p256dh: Buffer.from(raw).toString("base64url"),
    auth: Buffer.from(
      globalThis.crypto.getRandomValues(new Uint8Array(16))
    ).toString("base64url"),
  };
});

describe(sendTestPush, () => {
  it.live("sends one push to every stored device, reported by host", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const configDir = path.join(dir, "config");
      const dataDir = path.join(dir, "data");

      yield* Effect.promise(
        async () => await mkdir(dataDir, { recursive: true })
      );
      const config = ServerConfig.layerWith({ configDir, dataDir });
      const service = yield* fakePushService;

      // The brain's side: its key file and its database with one subscription.
      yield* Vapid.use((vapid) => Effect.succeed(vapid.keys)).pipe(
        Effect.provide(Vapid.layer.pipe(Layer.provide(config)))
      );

      const keys = yield* receiverKeys;

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
            INSERT INTO push_subscriptions (endpoint, p256dh, auth, login, created_at, updated_at)
            VALUES (${`${service.origin}/push/device-1`}, ${keys.p256dh}, ${keys.auth}, 'owner', 0, 0)
          `;
      }).pipe(
        Effect.provide(
          Database.layer({
            filename: path.join(dataDir, "cairn.sqlite"),
            migrations: { "0005_Push": Push0005 },
          })
        ),
        Effect.scoped
      );

      const results = yield* sendTestPush({
        wait: Duration.seconds(1),
        url: "/",
      }).pipe(Effect.provide(Layer.mergeAll(config, NodeServices.layer)));

      assert.deepStrictEqual(results, [{ host: "127.0.0.1", status: 201 }]);
      assert.strictEqual(service.received.length, 1);
      assert.isAbove(service.received[0] ?? 0, 0);
    }).pipe(Effect.scoped)
  );

  it.live("refuses to start without push.json, and does not make one", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const configDir = path.join(dir, "config");

      const exit = yield* sendTestPush({
        wait: Duration.seconds(1),
        url: "/",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerWith({ configDir, dataDir: dir }),
            NodeServices.layer
          )
        ),
        Effect.exit
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(existsSync(path.join(configDir, VAPID_FILE)));
    }).pipe(Effect.scoped)
  );
});

const chosenIn = (configDir: string, fromFile: boolean) =>
  Vapid.use((vapid) => Effect.succeed(vapid.keys)).pipe(
    Effect.provide(
      Vapid.layerChosen.pipe(
        Layer.provide(ServerConfig.layerWith({ configDir })),
        Layer.provide(fromFile ? VapidKeyFromFile : Layer.empty)
      )
    )
  );

describe("the VAPID key choice", () => {
  it.live("keeps every brain but the deployed one off push.json", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const file = path.join(dir, VAPID_FILE);

      yield* chosenIn(dir, false);
      assert.isFalse(existsSync(file));

      yield* chosenIn(dir, true);
      assert.isTrue(existsSync(file));
    }).pipe(Effect.scoped)
  );
});
