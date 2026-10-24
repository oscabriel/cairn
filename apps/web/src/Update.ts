// The root update: routing, the connection's state machine (Reconnect.ts), the shell, and the
// outbox. After every Message the thread page is told the routed thread and the connection, so its
// stream follows both without the root reaching into the page's state.
import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import { ThreadId } from "@cairn/protocol/Ids";
import { Array, Equal, Option, Predicate, Record, Schema } from "effect";
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
import { burnBusyBudget } from "./composer/Busy.ts";
import { composerContext } from "./composer/Context.ts";
import { OutMessage as ComposerOutMessage } from "./composer/Message.ts";
import type { Message as ComposerMessage } from "./composer/Message.ts";
import type { Draft as ComposerDraft } from "./composer/Model.ts";
import * as Composer from "./composer/Update.ts";
import {
  enqueue,
  nextToSend,
  OutboxItem,
  outboxKey,
  remove,
} from "./connection/Outbox.ts";
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
import { pushContextOf, samePushContext } from "./push/Context.ts";
import { OutMessage as PushOutMessage } from "./push/Message.ts";
import type { Message as PushMessage } from "./push/Message.ts";
import { initial as initialPush } from "./push/Model.ts";
import type { Model as PushModel, PushContext } from "./push/Model.ts";
import {
  init as initPush,
  inform as informPushModel,
  update as updatePush,
} from "./push/Update.ts";
import { AppRoute, urlToAppRoute } from "./Route.ts";
import { sameSettingsContext, settingsContextOf } from "./settings/Context.ts";
import type { Message as SettingsMessage } from "./settings/Message.ts";
import { initial as initialSettings } from "./settings/Model.ts";
import type {
  Model as SettingsModel,
  SettingsContext,
} from "./settings/Model.ts";
import {
  init as initSettings,
  inform as informSettingsModel,
  update as updateSettings,
} from "./settings/Update.ts";
import { LoadSettingsPage } from "./SettingsPage.ts";
import * as Parked from "./shell/Parked.ts";
import { isCurrent } from "./shell/ShellStore.ts";
import { OutMessage as SidebarOutMessage } from "./sidebar/Message.ts";
import type { Message as SidebarMessage } from "./sidebar/Message.ts";
import { initial as initialSidebar } from "./sidebar/Model.ts";
import type {
  DraftSummary,
  Model as SidebarModel,
  SidebarContext,
} from "./sidebar/Model.ts";
import {
  inform as informSidebarModel,
  init as initSidebar,
  openAddProject,
  update as updateSidebar,
} from "./sidebar/Update.ts";

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

const informThread = Update.foldChild({
  update: Thread.inform,
  read: readThread,
  write: writeThread,
  toParentMessage: toGotThreadMessage,
});

/** Whether `threadId`'s launch is on its way: queued in the outbox, or its shell row is preparing. */
const isLaunching = (model: Model, threadId: ThreadId): boolean =>
  model.outbox.some(
    (item) =>
      Predicate.isTagged(item, "Launch") && item.input.threadId === threadId
  ) ||
  Option.exists(model.shell, (shell) =>
    shell.threads.some(
      (thread) => thread.id === threadId && thread.activity === "preparing"
    )
  );

/** Tells the thread page the routed thread and the connection; a no-op when nothing changed. */
const syncThread: Step = (model) => {
  const threadId = routedThreadId(model.route);

  const context: Thread.PageContext = {
    threadId,
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    launching: Option.exists(threadId, (id) => isLaunching(model, id)),
  };

  const unchanged =
    Equal.equals(model.thread.threadId, context.threadId) &&
    model.thread.epoch === context.epoch &&
    model.thread.hasClient === context.hasClient &&
    model.thread.launching === context.launching;

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

/** The thread page's Messages; a Retry from the transcript joins the outbox. */
const foldThreadMessage = Update.foldChild({
  update: Thread.update,
  read: readThread,
  write: writeThread,
  toParentMessage: toGotThreadMessage,
  foldOutMessage: (out: Thread.OutMessage) =>
    Thread.OutMessage.match<Step>(out, {
      RequestedSend:
        ({ item }) =>
        (model) =>
          Update.combine(
            modifyFields(model, {
              outbox: (outbox) => enqueue(outbox, item),
            }),
            [persist, sendNext]
          ),
    }),
});

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

const toGotComposerMessage = (message: ComposerMessage): Message =>
  Message.GotComposerMessage({ message });

const readComposer = (model: Model) => Option.some(model.composer);

const writeComposer = (model: Model, composer: Model["composer"]): Model =>
  modifyFields(model, { composer: () => composer });

/** Drops one unsent draft from the composer (the sidebar's Discard). */
const discardComposerDraft = Update.foldChild({
  update: Composer.discardDraft,
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
});

/** Queues each item in order. */
const enqueueAll = (
  outbox: Model["outbox"],
  items: ReadonlyArray<OutboxItem>
): Model["outbox"] => {
  let next = outbox;

  for (const item of items) {
    next = enqueue(next, item);
  }

  return next;
};

const toGotSidebarMessage = (message: SidebarMessage): Message =>
  Message.GotSidebarMessage({ message });

const readSidebar = (model: Model): Option.Option<SidebarModel> =>
  Option.some(model.sidebar);

const writeSidebar = (model: Model, sidebar: SidebarModel): Model =>
  modifyFields(model, { sidebar: () => sidebar });

/** The draft the route names, when it names one. */
const routedDraftId = (route: AppRoute): Option.Option<string> =>
  AppRoute.match(route, {
    Inbox: () => Option.none(),
    Thread: () => Option.none(),
    Draft: ({ draftId }) => Option.some(draftId),
    Settings: () => Option.none(),
    NotFound: () => Option.none(),
  });

const DRAFT_KEY_PREFIX = "draft:";

/** A draft's sidebar preview: its first line, or how many attachments it holds. */
const draftPreview = (draft: ComposerDraft): string => {
  const firstLine = draft.text.trim().split("\n", 1)[0] ?? "";

  if (firstLine !== "") {
    return firstLine;
  }

  return draft.attachments.length === 1
    ? "1 attachment"
    : `${draft.attachments.length} attachments`;
};

/** The composer's unsent drafts (not threads' drafts), as the sidebar's draft rows show them. */
const draftSummaries = (
  drafts: Model["composer"]["drafts"]
): ReadonlyArray<DraftSummary> =>
  Record.toEntries(drafts).flatMap(([key, draft]) =>
    key.startsWith(DRAFT_KEY_PREFIX)
      ? [
          {
            draftId: key.slice(DRAFT_KEY_PREFIX.length),
            projectId: draft.projectId,
            preview: draftPreview(draft),
          },
        ]
      : []
  );

const sameDrafts = (
  left: ReadonlyArray<DraftSummary>,
  right: ReadonlyArray<DraftSummary>
): boolean =>
  left.length === right.length &&
  left.every((draft, index) => {
    const other = right[index];

    return (
      other !== undefined &&
      draft.draftId === other.draftId &&
      draft.preview === other.preview &&
      Equal.equals(draft.projectId, other.projectId)
    );
  });

/** What the sidebar hands up: shell commands for the outbox, or a draft to discard. */
const foldSidebarOutMessage = (outMessage: SidebarOutMessage): Step =>
  SidebarOutMessage.match<Step>(outMessage, {
    RequestedDispatch:
      ({ commands }) =>
      (model) =>
        Update.combine(
          modifyFields(model, {
            outbox: (outbox) =>
              enqueueAll(
                outbox,
                commands.map((command) => OutboxItem.Dispatch({ command }))
              ),
          }),
          [persist, sendNext]
        ),
    RequestedDiscardDraft: ({ draftId }) => discardComposerDraft(draftId),
  });

const foldSidebarMessage = Update.foldChild({
  update: updateSidebar,
  read: readSidebar,
  write: writeSidebar,
  toParentMessage: toGotSidebarMessage,
  foldOutMessage: foldSidebarOutMessage,
});

const informSidebar = Update.foldChild({
  update: informSidebarModel,
  read: readSidebar,
  write: writeSidebar,
  toParentMessage: toGotSidebarMessage,
  foldOutMessage: foldSidebarOutMessage,
});

const openSidebarAddProject = Update.foldChildStep({
  update: openAddProject,
  read: readSidebar,
  write: writeSidebar,
  toParentMessage: toGotSidebarMessage,
  foldOutMessage: foldSidebarOutMessage,
});

const startSidebar = Update.foldChildStep({
  update: () => initSidebar(),
  read: readSidebar,
  write: writeSidebar,
  toParentMessage: toGotSidebarMessage,
  foldOutMessage: foldSidebarOutMessage,
});

const toGotPushMessage = (message: PushMessage): Message =>
  Message.GotPushMessage({ message });

const readPush = (model: Model): Option.Option<PushModel> =>
  Option.some(model.push);

const writePush = (model: Model, push: PushModel): Model =>
  modifyFields(model, { push: () => push });

/** What the push toggle hands up: a tapped notification's same-origin path to open. */
const foldPushOutMessage = (outMessage: PushOutMessage): Step =>
  PushOutMessage.match<Step>(outMessage, {
    RequestedNavigate:
      ({ path }) =>
      (model) => ({ model, commands: [NavigateInternal({ url: path })] }),
  });

const foldPushMessage = Update.foldChild({
  update: updatePush,
  read: readPush,
  write: writePush,
  toParentMessage: toGotPushMessage,
  foldOutMessage: foldPushOutMessage,
});

const informPush = Update.foldChild({
  update: informPushModel,
  read: readPush,
  write: writePush,
  toParentMessage: toGotPushMessage,
  foldOutMessage: foldPushOutMessage,
});

const startPush = Update.foldChildStep({
  update: () => initPush(),
  read: readPush,
  write: writePush,
  toParentMessage: toGotPushMessage,
  foldOutMessage: foldPushOutMessage,
});

/** Tells the push toggle the epoch, the VAPID key, the open thread and the badge, when they changed. */
const syncPush: Step = (model) => {
  const context: PushContext = pushContextOf({
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    hello: model.hello,
    shell: model.shell,
    openThreadId: routedThreadId(model.route),
  });

  return samePushContext(model.push.context, context)
    ? { model }
    : informPush(model, context);
};

const toGotSettingsMessage = (message: SettingsMessage): Message =>
  Message.GotSettingsMessage({ message });

const readSettings = (model: Model): Option.Option<SettingsModel> =>
  Option.some(model.settings);

const writeSettings = (model: Model, settings: SettingsModel): Model =>
  modifyFields(model, { settings: () => settings });

const foldSettingsMessage = Update.foldChild({
  update: updateSettings,
  read: readSettings,
  write: writeSettings,
  toParentMessage: toGotSettingsMessage,
});

const informSettings = Update.foldChild({
  update: informSettingsModel,
  read: readSettings,
  write: writeSettings,
  toParentMessage: toGotSettingsMessage,
});

const startSettings = Update.foldChildStep({
  update: () => initSettings(),
  read: readSettings,
  write: writeSettings,
  toParentMessage: toGotSettingsMessage,
});

/** Asks for the settings page's view chunk the first time the settings route opens. */
const loadSettingsPage: Step = (model) =>
  model.settingsPage === "idle" && Predicate.isTagged(model.route, "Settings")
    ? {
        model: modifyFields(model, { settingsPage: () => "loading" as const }),
        commands: [LoadSettingsPage()],
      }
    : { model };

/** Tells the settings page the epoch, whether it is open and the shell, when they changed. */
const syncSettings: Step = (model) => {
  const context: SettingsContext = settingsContextOf({
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    isOpen: Predicate.isTagged(model.route, "Settings"),
    shell: model.shell,
  });

  return sameSettingsContext(model.settings.context, context)
    ? { model }
    : informSettings(model, context);
};

const toGotParkedMessage = (message: Parked.Message): Message =>
  Message.GotParkedMessage({ message });

const readParked = (model: Model): Option.Option<Parked.Model> =>
  Option.some(model.parked);

const writeParked = (model: Model, parked: Parked.Model): Model =>
  modifyFields(model, { parked: () => parked });

const foldParkedMessage = Update.foldChild({
  update: Parked.update,
  read: readParked,
  write: writeParked,
  toParentMessage: toGotParkedMessage,
});

const informParked = Update.foldChild({
  update: Parked.inform,
  read: readParked,
  write: writeParked,
  toParentMessage: toGotParkedMessage,
});

const sameRow = Option.makeEquivalence<object>((left, right) => left === right);

/** Tells the hold banner the open thread's shell row and the connection, when they changed. */
const syncParked: Step = (model) => {
  const thread = Option.flatMap(routedThreadId(model.route), (id) =>
    Option.flatMap(model.shell, (shell) =>
      Array.findFirst(shell.threads, (row) => row.id === id)
    )
  );

  const connected = hasClient(model.connection);

  const unchanged =
    model.parked.hasClient === connected &&
    sameRow(model.parked.thread, thread);

  return unchanged
    ? { model }
    : informParked(model, { thread, hasClient: connected });
};

/** Tells the sidebar the shell, the open page, the connection and the drafts, when they changed. */
const syncSidebar: Step = (model) => {
  const current = model.sidebar.context;
  const drafts = draftSummaries(model.composer.drafts);

  const context: SidebarContext = {
    shell: model.shell,
    openThreadId: routedThreadId(model.route),
    openDraftId: routedDraftId(model.route),
    connection: model.connection.state._tag,
    drafts: sameDrafts(current.drafts, drafts) ? current.drafts : drafts,
  };

  const unchanged =
    current.shell === context.shell &&
    Equal.equals(current.openThreadId, context.openThreadId) &&
    Equal.equals(current.openDraftId, context.openDraftId) &&
    current.connection === context.connection &&
    current.drafts === context.drafts;

  return unchanged ? { model } : informSidebar(model, context);
};

/** What the composer hands up: a turn for the outbox (and where to go), or a request for the folder dialog. */
const foldComposerOutMessage = (outMessage: ComposerOutMessage): Step =>
  ComposerOutMessage.match<Step>(outMessage, {
    Submitted:
      ({ item, navigateTo }) =>
      (model) =>
        Update.combine(
          modifyFields(model, { outbox: (outbox) => enqueue(outbox, item) }),
          [
            persist,
            sendNext,
            (next) => ({
              model: next,
              commands: Option.match(navigateTo, {
                onNone: () => [],
                onSome: (url) => [NavigateInternal({ url })],
              }),
            }),
          ]
        ),
    // The sidebar owns the folder dialog.
    RequestedAddProject: () => openSidebarAddProject,
  });

const foldComposerMessage = Update.foldChild({
  update: Composer.update,
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
  foldOutMessage: foldComposerOutMessage,
});

const informComposer = Update.foldChild({
  update: Composer.inform,
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
});

/** Tells the composer the route, the connection, the shell and the thread's view, when they changed. */
const syncComposer: Step = (model) => {
  const context = composerContext({
    route: model.route,
    threadId: routedThreadId(model.route),
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    live: isLive(model.connection),
    shell: model.shell,
    threadView: Option.map(model.thread.view, (state) => state.view),
    defaults: Option.map(model.hello, (hello) => hello.defaults),
    usage: model.settings.usage,
  });

  return Composer.contextChanged(model.composer, context)
    ? informComposer(model, context)
    : { model };
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
    GotComposerMessage:
      ({ message: composerMessage }) =>
      (model) =>
        foldComposerMessage(model, composerMessage),
    GotSidebarMessage:
      ({ message: sidebarMessage }) =>
      (model) =>
        foldSidebarMessage(model, sidebarMessage),
    GotPushMessage:
      ({ message: pushMessage }) =>
      (model) =>
        foldPushMessage(model, pushMessage),
    GotSettingsMessage:
      ({ message: settingsMessage }) =>
      (model) =>
        foldSettingsMessage(model, settingsMessage),
    GotParkedMessage:
      ({ message: parkedMessage }) =>
      (model) =>
        foldParkedMessage(model, parkedMessage),
    LoadedSettingsPage: () => (model) => ({
      model: modifyFields(model, { settingsPage: () => "loaded" as const }),
    }),
    FailedSettingsPage: () => (model) => ({
      model: modifyFields(model, { settingsPage: () => "failed" as const }),
    }),
  });

/** The root update. */
export const update = (model: Model, message: Message): UpdateReturn => {
  burnBusyBudget();

  return Update.combine(model, [
    step(message),
    syncThread,
    syncComposer,
    syncSidebar,
    syncPush,
    syncSettings,
    syncParked,
    loadSettingsPage,
  ]);
};

/** The first Model: the route, the boot shell and the saved outbox; the connection starts now. */
export const init: Runtime.RoutingApplicationInit<
  Model,
  Message,
  Flags,
  never,
  Services
> = (flags, url) => {
  const started = Update.foldChildInit(Composer.init(), {
    toParentModel: (composer): Model => ({
      route: urlToAppRoute(url),
      connection: initialConnection,
      hello: Option.none(),
      shell: Option.map(flags.boot, (boot) => boot.shell),
      outbox: flags.outbox,
      outboxInFlight: Option.none(),
      notice: Option.none(),
      thread: Thread.Model.initial,
      sidebar: initialSidebar,
      composer,
      push: initialPush,
      settings: initialSettings,
      parked: Parked.initial,
      settingsPage: "idle",
    }),
    toParentMessage: toGotComposerMessage,
  });

  const synced = Update.combine(started.model, [
    syncThread,
    syncComposer,
    startSidebar,
    syncSidebar,
    startPush,
    syncPush,
    startSettings,
    syncSettings,
    syncParked,
    loadSettingsPage,
  ]);

  return {
    model: synced.model,
    commands: [...(started.commands ?? []), ...(synced.commands ?? [])],
  };
};
