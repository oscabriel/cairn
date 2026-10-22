// The settings page's streams: the plan windows from `usage.subscribe` for as long as the epoch's
// client lives (the composer's meter reads them on every page), and the device's light or dark
// preference while the theme follows it. A usage stream that fails or ends stays quiet until the
// next epoch; the meter then keeps its last frame.
import { Effect, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { streamFromEventFilterMap } from "foldkit/dom";

import { CairnConnection } from "../connection/Connection.ts";
import type { Services } from "./Command.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

const usageStream: Stream.Stream<Message, never, Services> = Stream.unwrap(
  Effect.map(CairnConnection.get, (client) =>
    client["usage.subscribe"]().pipe(
      Stream.map((usage) => Message.ReceivedUsage({ usage })),
      Stream.catchCause(() => Stream.empty)
    )
  ).pipe(Effect.orElseSucceed(() => Stream.empty))
);

// Built when the theme follows the device, so loading this module never touches `matchMedia`.
const colorSchemeChanges: Stream.Stream<Message> = Stream.suspend(() =>
  streamFromEventFilterMap({
    target: window.matchMedia("(prefers-color-scheme: dark)"),
    type: "change",
    filterMapEvent: () => Option.some(Message.ChangedColorScheme()),
  })
);

/** The settings page's subscriptions. */
export const subscriptions = Subscription.make<Model, Message, Services>()(
  (entry) => ({
    usage: entry(
      { epoch: Schema.Int, hasClient: Schema.Boolean },
      {
        modelToDependencies: (model) => ({
          epoch: model.context.epoch,
          hasClient: model.context.hasClient,
        }),
        dependenciesToStream: ({ hasClient }) =>
          hasClient ? usageStream : Stream.empty,
      }
    ),
    colorScheme: entry(
      { followsDevice: Schema.Boolean },
      {
        modelToDependencies: (model) => ({
          followsDevice: model.client.theme === "system",
        }),
        dependenciesToStream: ({ followsDevice }) =>
          followsDevice ? colorSchemeChanges : Stream.empty,
      }
    ),
  })
);
