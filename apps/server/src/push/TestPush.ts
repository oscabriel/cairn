// Ported in intent from cairn-v1, spikes/05-signin/send-push.ts at 1a5cd4a: one test push to every
// subscribed device, to prove the whole path to a locked phone. Changed: it reads the deployed
// brain's own files without writing them (`push.json`, which only the brain makes, and
// `cairn.sqlite` opened read only), waits for the first subscription, and reports each push
// service's answer by host, never by endpoint path.

import path from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";

import { ServerConfig } from "../Config.ts";
import { endpointHost, PushSubscriptions } from "./PushSubscriptions.ts";
import { Vapid, VAPID_FILE } from "./Vapid.ts";
import { WebPush } from "./WebPush.ts";

/** How one device's push service answered; status 0 when nothing came back. */
export interface TestPushResult {
  readonly host: string;
  readonly status: number;
}

/** The test push could not start: no key yet, or no device subscribed in time. */
export class TestPushError extends Schema.TaggedError<TestPushError>()(
  "TestPushError",
  { message: Schema.String }
) {}

/** Options for one test run. */
export interface TestPushOptions {
  /** How long to wait for the first subscription. */
  readonly wait: Duration.Duration;
  /** The same-origin path a tap opens. */
  readonly url: string;
}

const sendToEveryDevice = (options: TestPushOptions) =>
  Effect.gen(function* () {
    const subscriptions = yield* PushSubscriptions;
    const webPush = yield* WebPush;

    const targets = yield* subscriptions.list.pipe(
      Effect.filterOrFail((rows) => rows.length > 0),
      Effect.retry(Schedule.spaced(Duration.seconds(2))),
      Effect.timeoutOption(options.wait),
      Effect.orElseSucceed(() => Option.none())
    );

    if (Option.isNone(targets)) {
      return yield* new TestPushError({
        message: `No device subscribed within ${String(Duration.toSeconds(options.wait))} s. Turn on "Notify me on this device" in the installed app, then run this again.`,
      });
    }

    const at = DateTime.formatIso(yield* DateTime.now);

    const message = JSON.stringify({
      title: "Cairn push test",
      body: `Sent at ${at}. Tap to open Cairn.`,
      tag: "push-test",
      url: options.url,
      badge: 0,
    });

    return yield* Effect.forEach(
      targets.value,
      (target) =>
        webPush
          .send(target, message, { ttlSeconds: 300, urgency: "high" })
          .pipe(
            Effect.map((response): TestPushResult => ({
              host: endpointHost(target.endpoint),
              status: response.status,
            })),
            Effect.orElseSucceed((): TestPushResult => ({
              host: endpointHost(target.endpoint),
              status: 0,
            }))
          ),
      { concurrency: "unbounded" }
    );
  });

/**
 * Sends one test push to every device subscribed in the deployed brain's `cairn.sqlite`, signed with
 * its `push.json`. Writes nothing: `push.json` must exist already (the brain makes it), and the
 * database is opened read only. Needs `ServerConfig` and `FileSystem`.
 */
export const sendTestPush = Effect.fn("TestPush.sendTestPush")(function* (
  options: TestPushOptions
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const vapidFile = path.join(config.configDir, VAPID_FILE);

  // Checked before `Vapid.layer` builds, because that layer would make a key.
  const hasKey = yield* fs
    .exists(vapidFile)
    .pipe(Effect.orElseSucceed(() => false));

  if (!hasKey) {
    return yield* new TestPushError({
      message: `${vapidFile} does not exist yet. The brain makes it when it starts with push; deploy and start it first.`,
    });
  }

  const sqlite = SqliteClient.layer({
    filename: path.join(config.dataDir, "cairn.sqlite"),
    readonly: true,
    disableWAL: true,
  });

  const layer = Layer.mergeAll(
    WebPush.layer.pipe(Layer.provide(Vapid.layer)),
    PushSubscriptions.layerNoDeps.pipe(Layer.provide(sqlite))
  ).pipe(Layer.provide(Layer.succeed(ServerConfig, config)));

  return yield* sendToEveryDevice(options).pipe(Effect.provide(layer));
});
