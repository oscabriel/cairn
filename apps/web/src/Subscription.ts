// The root's streams and resources. The connection resource is keyed on the epoch, so a new epoch
// releases the old client and builds a new one. The shell stream runs while the epoch's client
// exists and reports the socket lost when it fails or ends; it is the connection's health check.
// The page also wakes the connection when the browser says it is back (online, shown, visible).

import { ShellSnapshot } from "@cairn/protocol/Shell";
import type { Cause } from "effect";
import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { ManagedResource, Subscription } from "foldkit";
import { streamFromEventFilterMap } from "foldkit/dom";

import type { Services } from "./Command.ts";
import * as Composer from "./composer/Subscription.ts";
import { acquireClient, CairnConnection } from "./connection/Connection.ts";
import type { CairnConnectionService } from "./connection/Connection.ts";
import { causeMessage } from "./connection/Failure.ts";
import { hasClient, isBackingOff } from "./connection/Reconnect.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { subscriptions as nextShellSubscriptions } from "./next/shell/Subscription.ts";
import * as Thread from "./page/thread/index.ts";
import { subscriptions as pushSubscriptions } from "./push/Subscription.ts";
import { subscriptions as settingsSubscriptions } from "./settings/Subscription.ts";
import { subscribeShell } from "./shell/ShellStore.ts";
import { subscriptions as sidebarSubscriptions } from "./sidebar/Subscription.ts";

const describe = (cause: Cause.Cause<unknown>): string =>
  causeMessage(
    cause,
    "The shell stream was interrupted.",
    "The shell stream failed."
  );

const shellStream = (
  epoch: number,
  shell: Option.Option<ShellSnapshot>
): Stream.Stream<Message, never, CairnConnectionService> =>
  Stream.unwrap(
    CairnConnection.get.pipe(
      Effect.map((client) =>
        subscribeShell(client, shell).pipe(
          Stream.map((item) => Message.ReceivedShellItem({ epoch, item })),
          Stream.concat(
            Stream.make(
              Message.LostConnection({
                epoch,
                reason: "The shell stream ended.",
              })
            )
          ),
          Stream.catchCause((cause) =>
            Stream.make(
              Message.LostConnection({ epoch, reason: describe(cause) })
            )
          )
        )
      ),
      Effect.catchTag("ResourceNotAvailable", () =>
        Effect.succeed(Stream.empty)
      )
    )
  );

const wakeEvents = Stream.merge(
  streamFromEventFilterMap({
    target: window,
    type: "online",
    filterMapEvent: () => Option.some(Message.WokeUp()),
  }),
  Stream.merge(
    streamFromEventFilterMap({
      target: window,
      type: "pageshow",
      filterMapEvent: () => Option.some(Message.WokeUp()),
    }),
    streamFromEventFilterMap({
      target: document,
      type: "visibilitychange",
      filterMapEvent: () =>
        document.visibilityState === "visible"
          ? Option.some(Message.WokeUp())
          : Option.none(),
    })
  )
);

/** What the shell stream depends on; only the epoch and the client's presence reopen it. */
interface ShellDependencies {
  readonly epoch: number;
  readonly hasClient: boolean;
  readonly shell: Option.Option<ShellSnapshot>;
}

const rootSubscriptions = Subscription.make<Model, Message, Services>()(
  (entry) => ({
    // The cursor is read when the stream opens and not watched after: the stream itself moves it,
    // and reopening on every item would lose the live tail.
    shell: entry(
      {
        epoch: Schema.Int,
        hasClient: Schema.Boolean,
        shell: Schema.Option(ShellSnapshot),
      },
      {
        modelToDependencies: (model) => ({
          epoch: model.connection.epoch,
          hasClient: hasClient(model.connection),
          shell: model.shell,
        }),
        keepAliveEquivalence: (
          left: ShellDependencies,
          right: ShellDependencies
        ) => left.epoch === right.epoch && left.hasClient === right.hasClient,
        dependenciesToStream: ({
          epoch,
          hasClient: open,
          shell,
        }: ShellDependencies) =>
          open ? shellStream(epoch, shell) : Stream.empty,
      }
    ),
    wake: Subscription.persistentEntry(wakeEvents),
  })
);

const threadSubscriptions = Subscription.lift(Thread.subscriptions)<
  Model,
  Message
>({
  read: (model) => Option.some(model.thread),
  toParentMessage: (message) => Message.GotThreadMessage({ message }),
  when: ({ route }) => Predicate.isTagged(route, "Thread"),
});

const composerSubscriptions = Subscription.lift(Composer.subscriptions)<
  Model,
  Message
>({
  read: (model) => Option.some(model.composer),
  toParentMessage: (message) => Message.GotComposerMessage({ message }),
});

const liftedSidebarSubscriptions = Subscription.lift(sidebarSubscriptions)<
  Model,
  Message
>({
  read: (model) => Option.some(model.sidebar),
  toParentMessage: (message) => Message.GotSidebarMessage({ message }),
});

const liftedPushSubscriptions = Subscription.lift(pushSubscriptions)<
  Model,
  Message
>({
  read: (model) => Option.some(model.push),
  toParentMessage: (message) => Message.GotPushMessage({ message }),
});

const liftedSettingsSubscriptions = Subscription.lift(settingsSubscriptions)<
  Model,
  Message
>({
  read: (model) => Option.some(model.settings),
  toParentMessage: (message) => Message.GotSettingsMessage({ message }),
});

// The `next` shell's keys (the scratch thread's Cmd+J or Ctrl+J).
const liftedNextShellSubscriptions = Subscription.lift(nextShellSubscriptions)<
  Model,
  Message
>({
  read: (model) => Option.some(model.nextShell),
  toParentMessage: (message) => Message.GotNextShellMessage({ message }),
});

// The scratch thread's stream; its page holds a thread only while the overlay shows it. Renamed,
// since the routed page's stream already takes the key `thread`.
const scratchThreadSubscriptions = {
  scratchThread: Subscription.lift(Thread.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.scratchThread),
    toParentMessage: (message) => Message.GotScratchThreadMessage({ message }),
  }).thread,
};

/** Every root subscription. */
export const subscriptions = Subscription.aggregate(
  rootSubscriptions,
  threadSubscriptions,
  composerSubscriptions,
  liftedSidebarSubscriptions,
  liftedPushSubscriptions,
  liftedSettingsSubscriptions,
  liftedNextShellSubscriptions,
  scratchThreadSubscriptions
);

/** The connection resource, one client per epoch. */
export const managedResources = ManagedResource.make<Model, Message>()(
  (entry) => ({
    connection: entry(Schema.Option(Schema.Struct({ epoch: Schema.Int })), {
      resource: CairnConnection,
      // None while backing off, so a failed client is let go at once rather than at the next try.
      modelToMaybeRequirements: (model) =>
        isBackingOff(model.connection)
          ? Option.none()
          : Option.some({ epoch: model.connection.epoch }),
      acquire: () => acquireClient,
      release: () => Effect.void,
      onAcquired: () => Message.AcquiredConnection(),
      onReleased: () => Message.ReleasedConnection(),
      onAcquireError: (error) =>
        Message.FailedAcquireConnection({ reason: String(error) }),
    }),
  })
);
