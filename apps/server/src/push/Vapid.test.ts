// Judges the VAPID key file and the subscription table: the key is made once at 0600 and read back
// after that, two brains racing to make it agree on one key, a loose file mode is narrowed, and only
// a known push service's https endpoint is stored (upserted by endpoint, removed only while its keys
// are the ones refused). Ported in part from cairn-v1 apps/server/test/push.test.ts at 1a5cd4a.
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { Push0005 } from "../db/migrations/0005Push.ts";
import {
  isPushEndpoint,
  PushEndpointRule,
  PushSubscriptions,
} from "./PushSubscriptions.ts";
import { Vapid, VAPID_FILE, VAPID_SUBJECT, VapidKeyFromFile } from "./Vapid.ts";

const tempDir = Effect.acquireRelease(
  Effect.promise(
    async () => await mkdtemp(path.join(os.tmpdir(), "cairn-vapid-"))
  ),
  (dir) =>
    Effect.promise(async () => {
      await rm(dir, { recursive: true, force: true });
    })
);

const vapidIn = (configDir: string) =>
  Vapid.use((vapid) => Effect.succeed(vapid.keys)).pipe(
    Effect.provide(
      Vapid.layer.pipe(Layer.provide(ServerConfig.layerWith({ configDir })))
    )
  );

describe(Vapid, () => {
  it.live(
    "boots on a key in memory when push.json is corrupt, and says so",
    () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;

        yield* Effect.promise(async () => {
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, VAPID_FILE), "{ not json", {
            mode: 0o600,
          });
        });

        const events: Array<unknown> = [];

        const capture = Logger.make((options) => {
          events.push(
            options.fiber.getRef(References.CurrentLogAnnotations).event
          );
        });

        const keys = yield* Vapid.use((vapid) =>
          Effect.succeed(vapid.keys)
        ).pipe(
          Effect.provide(
            Vapid.layerChosen.pipe(
              Layer.provide(
                Layer.mergeAll(
                  ServerConfig.layerWith({ configDir: dir }),
                  VapidKeyFromFile,
                  Logger.layer([capture], { mergeWithExisting: false })
                )
              )
            )
          )
        );

        assert.strictEqual(keys.subject, VAPID_SUBJECT);
        assert.include(events, "vapid_unavailable");
      }).pipe(Effect.scoped)
  );

  it.live("makes the key pair once at 0600 and reads it back after that", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const configDir = path.join(dir, "config");
      const file = path.join(configDir, VAPID_FILE);

      const first = yield* vapidIn(configDir);
      const info = yield* Effect.promise(async () => await stat(file));

      assert.strictEqual(info.mode % 0o1000, 0o600);
      assert.strictEqual(first.subject, VAPID_SUBJECT);

      const second = yield* vapidIn(configDir);

      assert.deepStrictEqual(second, first);
    }).pipe(Effect.scoped)
  );

  it.live("gives two brains racing to make it the same key", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;

      const [left, right] = yield* Effect.all([vapidIn(dir), vapidIn(dir)], {
        concurrency: 2,
      });

      assert.strictEqual(left.publicKey, right.publicKey);

      const text = yield* Effect.promise(
        async () => await readFile(path.join(dir, VAPID_FILE), "utf-8")
      );

      assert.include(text, left.publicKey);
    }).pipe(Effect.scoped)
  );

  it.live("narrows a file other users could read to 0600", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const file = path.join(dir, VAPID_FILE);

      yield* vapidIn(dir);
      yield* Effect.promise(async () => {
        await chmod(file, 0o644);
      });
      yield* vapidIn(dir);

      const info = yield* Effect.promise(async () => await stat(file));

      assert.strictEqual(info.mode % 0o1000, 0o600);
    }).pipe(Effect.scoped)
  );
});

const P256DH = "B".padEnd(87, "A");

const subscriptionsLayer = PushSubscriptions.layerNoDeps.pipe(
  Layer.provideMerge(Database.layerTest({ "0005_Push": Push0005 }))
);

describe(PushSubscriptions, () => {
  it("knows the real push services and nothing else", () => {
    for (const ok of [
      "https://web.push.apple.com/QGx",
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      assert.isTrue(isPushEndpoint(ok), ok);
    }

    for (const bad of [
      "http://web.push.apple.com/x",
      "https://web.push.apple.com:8443/x",
      "https://push.apple.com.evil.test/x",
      "https://evilpush.apple.com.test/x",
      "https://127.0.0.1/x",
      "https://user@fcm.googleapis.com/x",
      "not a url",
    ]) {
      assert.isFalse(isPushEndpoint(bad), bad);
    }
  });

  it.effect(
    "upserts by endpoint, refuses other hosts, and removes a refused one only with its keys",
    () =>
      Effect.gen(function* () {
        const subscriptions = yield* PushSubscriptions;
        const endpoint = "https://web.push.apple.com/device-a";

        yield* subscriptions.upsert("oscabriel@github", {
          endpoint,
          keys: { p256dh: P256DH, auth: "old" },
        });
        yield* subscriptions.upsert("oscabriel@github", {
          endpoint,
          keys: { p256dh: P256DH, auth: "new" },
        });

        const refused = yield* Effect.flip(
          subscriptions.upsert("oscabriel@github", {
            endpoint: "https://evil.test/x",
            keys: { p256dh: P256DH, auth: "x" },
          })
        );

        assert.strictEqual(refused._tag, "PushEndpointRefused");
        assert.deepStrictEqual(yield* subscriptions.list, [
          { endpoint, keys: { p256dh: P256DH, auth: "new" } },
        ]);

        // A refusal for the old keys must not delete the row the device sent again since.
        yield* subscriptions.removeRefused({
          endpoint,
          keys: { p256dh: P256DH, auth: "old" },
        });

        assert.strictEqual((yield* subscriptions.list).length, 1);

        yield* subscriptions.remove(endpoint);
        yield* subscriptions.remove("https://web.push.apple.com/unknown");

        assert.deepStrictEqual(yield* subscriptions.list, []);
      }).pipe(Effect.provide(subscriptionsLayer))
  );

  it.effect("accepts what the endpoint rule allows", () =>
    Effect.gen(function* () {
      const subscriptions = yield* PushSubscriptions;

      yield* subscriptions.upsert("oscabriel@github", {
        endpoint: "https://push.test/a",
        keys: { p256dh: P256DH, auth: "a" },
      });

      assert.strictEqual((yield* subscriptions.list).length, 1);
    }).pipe(
      Effect.provideService(PushEndpointRule, {
        allows: (endpoint: string) => endpoint.startsWith("https://push.test/"),
      }),
      Effect.provide(subscriptionsLayer)
    )
  );
});
