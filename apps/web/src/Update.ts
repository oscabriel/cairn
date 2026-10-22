// The root update: routing, the connection's state machine (Reconnect.ts), the shell, and the
// outbox. After every Message the thread page is told the routed thread and the connection, so its
// stream follows both without the root reaching into the page's state.
import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import { ThreadId } from "@cairn/protocol/Ids";
import { Equal, Option, Schema } from "effect";
import { Update, Url } from "foldkit";
import type { Runtime } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";

import {
  LoadExternal,
  NavigateInternal,
  SaveOutbox,
  SayHello,
  SendOutboxItem,
  WaitForBackoff,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import { enqueue, nextToSend, outboxKey, remove } from "./connection/Outbox.ts";
import {
  acquired,
  elapsed,
  hasClient,
  initialConnection,
  isLive,
  lost,
  synchronized,
  woke,
} from "./connection/Reconnect.ts";
import { Message } from "./Message.ts";
import type { Flags, Model } from "./Model.ts";
import * as Thread from "./page/thread/index.ts";
import { AppRoute, urlToAppRoute } from "./Route.ts";
import { isCurrent } from "./shell/ShellStore.ts";

type UpdateReturn = Update.Return<Model, Message, Services>;

type Step = Update.Step<Model, Message, Services>;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The thread the route names, when its id is a well-formed thread id. */
const routedThreadId = (route: AppRoute): Option.Option<ThreadId> =>
  AppRoute.match(route, {
    Inbox: () => Option.none(),
    Thread: ({ threadId }) => decodeThreadId(threadId),
    Draft: () => Option.none(),
    Settings: () => Option.none(),
    NotFound: () => Option.none(),
  });

const toGotThreadMessage = (message: Thread.Message): Message =>
  Message.GotThreadMessage({ message });

const readThread = (model: Model): Option.Option<Thread.Model.Model> =>
  Option.some(model.thread);

const writeThread = (model: Model, thread: Thread.Model.Model): Model =>
  modifyFields(model, { thread: () => thread });

const foldThreadMessage = Update.foldChild({
  update: Thread.update,
  read: readThread,
  write: writeThread,
  toParentMessage: toGotThreadMessage,
});

const informThread = Update.foldChild({
  update: Thread.inform,
  read: readThread,
  write: writeThread,
  toParentMessage: toGotThreadMessage,
});

/** Tells the thread page the routed thread and the connection; a no-op when nothing changed. */
const syncThread: Step = (model) => {
  const context: Thread.PageContext = {
    threadId: routedThreadId(model.route),
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
  };

  const unchanged =
    Equal.equals(model.thread.threadId, context.threadId) &&
    model.thread.epoch === context.epoch &&
    model.thread.hasClient === context.hasClient;

  return unchanged ? { model } : informThread(model, context);
};

/** Saves the outbox as it now is. */
const persist: Step = (model) => ({
  model,
  commands: [SaveOutbox({ outbox: model.outbox })],
});

/** Sends the outbox's head when the connection is live and nothing is in flight. */
const sendNext: Step = (model) =>
  Option.match(
    nextToSend(model.outbox, model.outboxInFlight, isLive(model.connection)),
    {
      onNone: () => ({ model }),
      onSome: (item) => ({
        model: modifyFields(model, {
          outboxInFlight: () => Option.some(outboxKey(item)),
        }),
        commands: [SendOutboxItem({ epoch: model.connection.epoch, item })],
      }),
    }
  );

/** The current epoch failed: back off, and forget what was in flight on it. */
const enterBackoff: Step = (model) => {
  const next = lost(model.connection);

  return {
    model: modifyFields(model, {
      connection: () => next.connection,
      hello: () => Option.none(),
      outboxInFlight: () => Option.none(),
    }),
    commands: Option.match(next.wait, {
      onNone: () => [],
      onSome: (wait) => [WaitForBackoff(wait)],
    }),
  };
};

const isCurrentEpoch = (model: Model, epoch: number): boolean =>
  model.connection.epoch === epoch;

const step = (received: Message): Step =>
  Message.match<Step>(received, {
    ClickedLink:
      ({ request }) =>
      (model) =>
        UrlRequest.match<UpdateReturn>(request, {
          Internal: ({ url }) => ({
            model,
            commands: [NavigateInternal({ url: Url.toString(url) })],
          }),
          External: ({ href }) => ({
            model,
            commands: [LoadExternal({ href })],
          }),
        }),
    ChangedUrl:
      ({ url }) =>
      (model) => ({
        model: modifyFields(model, { route: () => urlToAppRoute(url) }),
      }),
    CompletedNavigateInternal: () => (model) => ({ model }),
    CompletedLoadExternal: () => (model) => ({ model }),

    AcquiredConnection: () => (model) => {
      const connection = acquired(model.connection);

      if (Equal.equals(connection, model.connection)) {
        return { model };
      }

      return {
        model: modifyFields(model, { connection: () => connection }),
        commands: [SayHello({ epoch: connection.epoch })],
      };
    },
    ReleasedConnection: () => (model) => ({ model }),
    FailedAcquireConnection: () => enterBackoff,
    LostConnection:
      ({ epoch }) =>
      (model) =>
        isCurrentEpoch(model, epoch) ? enterBackoff(model) : { model },
    ElapsedBackoff:
      ({ attempt, epoch }) =>
      (model) => ({
        model: modifyFields(model, {
          connection: (connection) => elapsed(connection, epoch, attempt),
        }),
      }),
    WokeUp: () => (model) => ({
      model: modifyFields(model, { connection: woke }),
    }),

    SucceededHello:
      ({ epoch, hello }) =>
      (model) => ({
        model: isCurrentEpoch(model, epoch)
          ? modifyFields(model, { hello: () => Option.some(hello) })
          : model,
      }),
    ReceivedShellItem:
      ({ epoch, item }) =>
      (model) => {
        if (!isCurrentEpoch(model, epoch)) {
          return { model };
        }

        const shell = applyShellStreamItem(model.shell, item);

        // Live needs both: the stream says the replay is done, and there is a shell to be current.
        const next = modifyFields(model, {
          shell: () => shell,
          connection: (connection) =>
            isCurrent(item) && Option.isSome(shell)
              ? synchronized(connection)
              : connection,
        });

        return sendNext(next);
      },

    QueuedOutboxItem:
      ({ item }) =>
      (model) =>
        Update.combine(
          modifyFields(model, { outbox: (outbox) => enqueue(outbox, item) }),
          [persist, sendNext]
        ),
    AcknowledgedOutboxItem:
      ({ epoch, key }) =>
      (model) =>
        // An acknowledgement from an earlier epoch still means the brain has the item.
        Update.combine(
          modifyFields(model, {
            outbox: (outbox) => remove(outbox, key),
            outboxInFlight: (inFlight) =>
              isCurrentEpoch(model, epoch) && Option.contains(inFlight, key)
                ? Option.none()
                : inFlight,
          }),
          [persist, sendNext]
        ),
    FailedOutboxItem:
      ({ epoch, key, message, retryable }) =>
      (model) => {
        if (!isCurrentEpoch(model, epoch)) {
          return { model };
        }

        if (retryable) {
          // Left at the head; the next live connection sends it again.
          return {
            model: modifyFields(model, { outboxInFlight: () => Option.none() }),
          };
        }

        return Update.combine(
          modifyFields(model, {
            outbox: (outbox) => remove(outbox, key),
            outboxInFlight: () => Option.none(),
            notice: () => Option.some(message),
          }),
          [persist, sendNext]
        );
      },
    CompletedSaveOutbox:
      ({ saved }) =>
      (model) => ({
        model: saved
          ? model
          : modifyFields(model, {
              notice: () =>
                Option.some(
                  "Unsent changes could not be saved on this device. Keep this page open until they are sent."
                ),
            }),
      }),

    GotThreadMessage:
      ({ message: threadMessage }) =>
      (model) =>
        foldThreadMessage(model, threadMessage),
  });

/** The root update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Update.combine(model, [step(message), syncThread]);

/** The first Model: the route, the boot shell and the saved outbox; the connection starts now. */
export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  Flags,
  never,
  Services
> = (flags, url) =>
  syncThread({
    route: urlToAppRoute(url),
    connection: initialConnection,
    hello: Option.none(),
    shell: Option.map(flags.boot, (boot) => boot.shell),
    outbox: flags.outbox,
    outboxInFlight: Option.none(),
    notice: Option.none(),
    thread: Thread.Model.initial,
  });
