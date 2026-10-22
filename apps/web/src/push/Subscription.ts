// The push toggle's streams: the load's re-check of the subscription (once the socket and the key
// are there), presence reports (at once, every 15 seconds and on every visibility change, for as
// long as the epoch's client lives), and the service worker's requests to open a path.
import { ThreadId } from "@cairn/protocol/Ids";
import { Duration, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { streamFromEventFilterMap } from "foldkit/dom";

import { reportPresence, syncSubscription } from "./Command.ts";
import type { Services } from "./Command.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { canPush } from "./Update.ts";

/** How often a page says what it shows while nothing changes. */
export const PRESENCE_INTERVAL = Duration.seconds(15);

/** What the service worker posts when a notification is tapped (`apps/web/public/sw.js`). */
const OpenRequest = Schema.Struct({
  type: Schema.Literal("open"),
  url: Schema.String,
});

const decodeOpenRequest = Schema.decodeUnknownOption(OpenRequest);

/** `url` when it is a same-origin path; anything else opens nothing. */
export const sameOriginPath = (url: string): Option.Option<string> =>
  url.startsWith("/") && !url.startsWith("//")
    ? Option.some(url)
    : Option.none();

const openRequests: Stream.Stream<Message> =
  "serviceWorker" in navigator
    ? streamFromEventFilterMap({
        target: navigator.serviceWorker,
        type: "message",
        filterMapEvent: (event) =>
          decodeOpenRequest(event.data).pipe(
            Option.flatMap(({ url }) => sameOriginPath(url)),
            Option.map((path) => Message.ReceivedOpenRequest({ path }))
          ),
      })
    : Stream.empty;

const visibilityChanges = streamFromEventFilterMap({
  target: document,
  type: "visibilitychange",
  filterMapEvent: () => Option.some("visibility" as const),
});

const presenceReports = (
  deviceId: string,
  threadId: Option.Option<ThreadId>
): Stream.Stream<Message, never, Services> =>
  Stream.merge(Stream.tick(PRESENCE_INTERVAL), visibilityChanges).pipe(
    Stream.mapEffect(() => reportPresence({ deviceId, threadId }))
  );

/** The push toggle's subscriptions. */
export const subscriptions = Subscription.make<Model, Message, Services>()(
  (entry) => ({
    sync: entry(
      {
        hasClient: Schema.Boolean,
        vapidKey: Schema.Option(Schema.String),
        due: Schema.Boolean,
      },
      {
        modelToDependencies: (model) => ({
          hasClient: model.context.hasClient,
          vapidKey: model.context.vapidKey,
          due: canPush(model) && !model.synced,
        }),
        dependenciesToStream: ({ due, hasClient, vapidKey }) =>
          Option.match(
            Option.filter(vapidKey, () => due && hasClient),
            {
              onNone: () => Stream.empty,
              onSome: (key) => Stream.fromEffect(syncSubscription(key)),
            }
          ),
      }
    ),
    presence: entry(
      {
        epoch: Schema.Int,
        hasClient: Schema.Boolean,
        deviceId: Schema.Option(Schema.String),
        threadId: Schema.Option(ThreadId),
      },
      {
        modelToDependencies: (model) => ({
          epoch: model.context.epoch,
          hasClient: model.context.hasClient,
          deviceId: model.deviceId,
          threadId: model.context.threadId,
        }),
        dependenciesToStream: ({ deviceId, hasClient, threadId }) =>
          Option.match(
            Option.filter(deviceId, () => hasClient),
            {
              onNone: () => Stream.empty,
              onSome: (id) => presenceReports(id, threadId),
            }
          ),
      }
    ),
    openRequests: Subscription.persistentEntry(openRequests),
  })
);
