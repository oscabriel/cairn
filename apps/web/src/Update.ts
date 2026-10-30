// The root update: routing, the connection's state machine (Reconnect.ts), the shell, and the
// outbox. After every Message the thread page is told the routed thread and the connection, so its
// stream follows both without the root reaching into the page's state.

import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ShellCommand } from "@cairn/protocol/ShellCommands";
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
  WaitToResend,
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
  enqueueDispatch,
  nextToSend,
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
import type { Flags, Model, SentTurn } from "./Model.ts";
import type { Message as RequestCardMessage } from "./next/card/Message.ts";
import { OutMessage as RequestCardOutMessage } from "./next/card/Message.ts";
import {
  approvalsDocumentOf,
  initial as initialRequestCard,
} from "./next/card/Model.ts";
import type {
  CardContext,
  Model as RequestCardModel,
} from "./next/card/Model.ts";
import { nextRequestCardOf, nextMetersOf } from "./next/FrameLoad.ts";
import type { Message as MetersMessage } from "./next/meters/Message.ts";
import { initial as initialMeters } from "./next/meters/Model.ts";
import type { MetersPage, Model as MetersModel } from "./next/meters/Model.ts";
import { OutMessage as NextShellOutMessage } from "./next/shell/Message.ts";
import type { Message as NextShellMessage } from "./next/shell/Message.ts";
import { initial as initialNextShell } from "./next/shell/Model.ts";
import type {
  Model as NextShellModel,
  ShellContext as NextShellContext,
} from "./next/shell/Model.ts";
import { loadedShell } from "./next/shell/ShellLoad.ts";
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
import { AppRoute, draftRouter, urlToAppRoute } from "./Route.ts";
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
import { threadRowOf } from "./ThreadRow.ts";

type UpdateReturn = Update.Return<Model, Message, Services>;

type Step = Update.Step<Model, Message, Services>;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The thread the route names, when its id is a well-formed thread id. */
const routedThreadId = (route: AppRoute): Option.Option<ThreadId> =>
  AppRoute.match(route, {
    Hero: () => Option.none(),
    Thread: ({ threadId }) => decodeThreadId(threadId),
    Draft: () => Option.none(),
    Settings: () => Option.none(),
    Usage: () => Option.none(),
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

// The same root Model when the composer kept its own, so the runtime skips the render.
const writeComposer = (model: Model, composer: Model["composer"]): Model =>
  composer === model.composer
    ? model
    : modifyFields(model, { composer: () => composer });

/** Drops one unsent draft from the composer (the sidebar's Discard). */
const discardComposerDraft = Update.foldChild({
  update: Composer.discardDraft,
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
});

/** Queues each shell command in order. */
const enqueueAll = (
  model: Model,
  commands: ReadonlyArray<ShellCommand>
): Model["outbox"] => {
  let next = model.outbox;

  for (const command of commands) {
    next = enqueueDispatch(next, command, model.outboxInFlight);
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
    Hero: () => Option.none(),
    Thread: () => Option.none(),
    Draft: ({ draftId }) => Option.some(draftId),
    Settings: () => Option.none(),
    Usage: () => Option.none(),
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
          modifyFields(model, { outbox: () => enqueueAll(model, commands) }),
          [persist, sendNext]
        ),
    RequestedDiscardDraft: ({ draftId }) => discardComposerDraft(draftId),
    RequestedNotice:
      ({ message }) =>
      (model) => ({
        model: modifyFields(model, { notice: () => Option.some(message) }),
      }),
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
    threadRowOf(model.shell, id)
  );

  const connected = hasClient(model.connection);

  const unchanged =
    model.parked.hasClient === connected &&
    sameRow(model.parked.thread, thread);

  return unchanged
    ? { model }
    : informParked(model, { thread, hasClient: connected });
};

const toGotMetersMessage = (message: MetersMessage): Message =>
  Message.GotMetersMessage({ message });

const readMeters = (model: Model): Option.Option<MetersModel> =>
  Option.some(model.meters);

const writeMeters = (model: Model, meters: MetersModel): Model =>
  modifyFields(model, { meters: () => meters });

/** Folds a meters Message through the meters' update, once the `next` chunk brought it. */
const foldMetersMessage = (
  model: Model,
  message: MetersMessage
): UpdateReturn =>
  Option.match(nextMetersOf(model), {
    onNone: () => ({ model }),
    onSome: (meters) =>
      Update.foldChild({
        update: meters.update,
        read: readMeters,
        write: writeMeters,
        toParentMessage: toGotMetersMessage,
      })(model, message),
  });

/** Which of the meters' pages the route opens. */
const metersPageOf = (route: Model["route"]): MetersPage =>
  AppRoute.match(route, {
    Usage: () => "usage" as const,
    Settings: () => "settings" as const,
    Hero: () => "closed" as const,
    Thread: () => "closed" as const,
    Draft: () => "closed" as const,
    NotFound: () => "closed" as const,
  });

/**
 * Tells the meters the connection, the open page, the plan windows and the rows' spend, when they
 * changed, while the `next` frame draws them.
 */
const syncMeters: Step = (model) =>
  Option.match(nextMetersOf(model), {
    onNone: () => ({ model }),
    onSome: (meters) => {
      const context = meters.contextOf({
        epoch: model.connection.epoch,
        hasClient: hasClient(model.connection),
        page: metersPageOf(model.route),
        usage: model.settings.usage,
        shell: model.shell,
      });

      return meters.sameContext(model.meters, context)
        ? { model }
        : Update.foldChild({
            update: meters.inform,
            read: readMeters,
            write: writeMeters,
            toParentMessage: toGotMetersMessage,
          })(model, context);
    },
  });

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
      ({ attachments, item, navigateTo }) =>
      (model) =>
        Update.combine(
          modifyFields(model, {
            outbox: (outbox) => enqueue(outbox, item),
            sentTurns: (sent) =>
              Predicate.isTagged(item, "Dispatch")
                ? sent
                : Record.set(sent, outboxKey(item), {
                    item,
                    attachments,
                    acknowledged: false,
                  }),
          }),
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

const toGotRequestCardMessage = (message: RequestCardMessage): Message =>
  Message.GotRequestCardMessage({ message });

const readRequestCard = (model: Model): Option.Option<RequestCardModel> =>
  Option.some(model.requestCard);

const writeRequestCard = (model: Model, requestCard: RequestCardModel): Model =>
  modifyFields(model, { requestCard: () => requestCard });

/** Folds a request card Message through the card's update, once the `next` chunk brought it. */
const foldRequestCardMessage = (
  model: Model,
  message: RequestCardMessage
): UpdateReturn =>
  Option.match(nextRequestCardOf(model), {
    onNone: () => ({ model }),
    onSome: (card) =>
      Update.foldChild({
        update: card.update,
        read: readRequestCard,
        write: writeRequestCard,
        toParentMessage: toGotRequestCardMessage,
      })(model, message),
  });

/**
 * What the request card hands up: the words typed on a request that closed under them go into the
 * thread's composer draft (look track L7).
 */
const foldRequestCardOutMessage = (outMessage: RequestCardOutMessage): Step =>
  RequestCardOutMessage.match<Step>(outMessage, {
    CarriedTypedWords:
      ({ text, threadId }) =>
      (model) => ({
        model: modifyFields(model, {
          composer: (composer) =>
            Composer.carryIntoDraft(composer, threadId, text),
        }),
      }),
  });

/**
 * Tells the request card the open thread's decision records and the connection, when they
 * changed, while the `next` frame draws it.
 */
const syncRequestCard: Step = (model) =>
  Option.match(nextRequestCardOf(model), {
    onNone: () => ({ model }),
    onSome: (card) => {
      const context: CardContext = {
        threadId: model.thread.threadId,
        approvals: approvalsDocumentOf(model.thread.view),
        hasClient: hasClient(model.connection),
      };

      return card.sameContext(model.requestCard, context)
        ? { model }
        : Update.foldChild({
            update: card.inform,
            read: readRequestCard,
            write: writeRequestCard,
            toParentMessage: toGotRequestCardMessage,
            foldOutMessage: foldRequestCardOutMessage,
          })(model, context);
    },
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

/** Puts a turn the brain refused, or a launch that failed, back in the composer. */
const restoreComposerTurn = Update.foldChild({
  update: (composer: Model["composer"], sent: SentTurn) =>
    Composer.restoreTurn(composer, sent.item, sent.attachments),
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
});

/** The thread a sent launch makes, when `sent` is a launch. */
const launchedThread = (sent: SentTurn): Option.Option<ThreadId> =>
  Predicate.isTagged(sent.item, "Launch")
    ? Option.some(sent.item.input.threadId)
    : Option.none();

/** The text of the notice raised when the outbox cannot be saved; it clears once a save works. */
const UNSAVED_NOTICE =
  "Unsent changes could not be saved on this device. Keep this page open until they are sent.";

/**
 * Restores the turn `key` names and forgets it. A refused launch the user is waiting on, on its
 * thread's page, opens its draft again.
 */
const restoreSent =
  (key: string): Step =>
  (model) =>
    Option.match(Record.get(model.sentTurns, key), {
      onNone: () => ({ model }),
      onSome: (sent) => {
        const forgotten = modifyFields(model, {
          sentTurns: (turns) => Record.remove(turns, key),
        });

        const reopen = Option.filter(launchedThread(sent), (threadId) =>
          Option.contains(routedThreadId(model.route), threadId)
        );

        return Update.combine(forgotten, [
          restoreComposerTurn(sent),
          (next) => ({
            model: next,
            commands: Option.match(reopen, {
              onNone: () => [],
              onSome: (threadId) => [
                NavigateInternal({
                  url: draftRouter({
                    draftId: Composer.retryDraftId(threadId),
                  }),
                }),
              ],
            }),
          }),
        ]);
      },
    });

/**
 * Follows acknowledged launches in the shell: a thread that started forgets its launch, and one
 * whose row failed puts its first message back in a new draft (the thread page links to it).
 */
const followLaunches: Step = (model) =>
  Option.match(model.shell, {
    onNone: () => ({ model }),
    onSome: (shell) => {
      const settled = Record.toEntries(model.sentTurns).flatMap(
        ([key, sent]) => {
          if (!sent.acknowledged) {
            return [];
          }

          return Option.match(
            Option.flatMap(launchedThread(sent), (threadId) =>
              Array.findFirst(shell.threads, (row) => row.id === threadId)
            ),
            {
              onNone: () => [],
              onSome: (row) =>
                row.activity === "preparing"
                  ? []
                  : [{ key, failed: row.activity === "failed" }],
            }
          );
        }
      );

      return Update.combine(
        model,
        settled.map(({ failed, key }): Step =>
          failed
            ? restoreSent(key)
            : (current) => ({
                model: modifyFields(current, {
                  sentTurns: (turns) => Record.remove(turns, key),
                }),
              })
        )
      );
    },
  });

const toGotNextShellMessage = (message: NextShellMessage): Message =>
  Message.GotNextShellMessage({ message });

const readNextShell = (model: Model): Option.Option<NextShellModel> =>
  Option.some(model.nextShell);

const writeNextShell = (model: Model, nextShell: NextShellModel): Model =>
  nextShell === model.nextShell
    ? model
    : modifyFields(model, { nextShell: () => nextShell });

/**
 * What the `next` shell hands up: an item for the outbox (and where to go), a path to open, or a
 * new draft in the project the rail picked.
 */
const foldNextShellOutMessage = (outMessage: NextShellOutMessage): Step =>
  NextShellOutMessage.match<Step>(outMessage, {
    RequestedOutbox:
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
    RequestedNavigate:
      ({ url }) =>
      (model) => ({ model, commands: [NavigateInternal({ url })] }),
    // The draft holds its project before its page opens, so the hero launches where the rail says.
    RequestedProjectDraft:
      ({ projectId, draftId }) =>
      (model) => ({
        model: writeComposer(
          model,
          Composer.pickDraftProject(model.composer, draftId, projectId)
        ),
        commands: [NavigateInternal({ url: draftRouter({ draftId }) })],
      }),
  });

/** The shell's update, once its chunk has loaded; no shell Message can come before. */
const updateNextShell = (shell: NextShellModel, message: NextShellMessage) =>
  Option.match(loadedShell(), {
    onNone: () => ({ model: shell }),
    onSome: (runtime) => runtime.update(shell, message),
  });

/** Tells the shell the root's context: through its update once loaded, else only the context. */
const informNextShellModel = (
  shell: NextShellModel,
  context: NextShellContext
) =>
  Option.match(loadedShell(), {
    onNone: () => ({
      model: modifyFields(shell, { context: () => context }),
    }),
    onSome: (runtime) => runtime.inform(shell, context),
  });

const foldNextShellMessage = Update.foldChild({
  update: updateNextShell,
  read: readNextShell,
  write: writeNextShell,
  toParentMessage: toGotNextShellMessage,
  foldOutMessage: foldNextShellOutMessage,
});

const informNextShell = Update.foldChild({
  update: informNextShellModel,
  read: readNextShell,
  write: writeNextShell,
  toParentMessage: toGotNextShellMessage,
});

/** Tells the `next` shell the shell, the route, the connection and the clock, when they changed. */
const syncNextShell: Step = (model) => {
  const current = model.nextShell.context;

  const context: NextShellContext = {
    shell: model.shell,
    route: model.route,
    hasClient: hasClient(model.connection),
    defaults: Option.map(model.hello, (hello) => hello.defaults),
    nowMs: model.sidebar.nowMs,
    isMac: model.sidebar.isMac,
  };

  // The first update after the chunk loads starts the shell, even with nothing new to tell.
  const unchanged =
    (model.nextShell.started || Option.isNone(loadedShell())) &&
    current.shell === context.shell &&
    Equal.equals(current.route, context.route) &&
    current.hasClient === context.hasClient &&
    Equal.equals(current.defaults, context.defaults) &&
    current.nowMs === context.nowMs &&
    current.isMac === context.isMac;

  return unchanged ? { model } : informNextShell(model, context);
};

const toGotScratchThreadMessage = (message: Thread.Message): Message =>
  Message.GotScratchThreadMessage({ message });

const readScratchThread = (model: Model): Option.Option<Thread.Model.Model> =>
  Option.some(model.scratchThread);

const writeScratchThread = (
  model: Model,
  scratchThread: Thread.Model.Model
): Model => modifyFields(model, { scratchThread: () => scratchThread });

const informScratchThread = Update.foldChild({
  update: Thread.inform,
  read: readScratchThread,
  write: writeScratchThread,
  toParentMessage: toGotScratchThreadMessage,
});

/** The scratch thread page's Messages; a Retry from its transcript joins the outbox. */
const foldScratchThreadMessage = Update.foldChild({
  update: Thread.update,
  read: readScratchThread,
  write: writeScratchThread,
  toParentMessage: toGotScratchThreadMessage,
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

/**
 * Tells the scratch thread's page which thread the `next` shell's overlay shows: its scratch thread
 * while the overlay is open, none while it is hidden, so a hidden overlay holds no stream.
 */
const syncScratchThread: Step = (model) => {
  const { scratch } = model.nextShell;
  const threadId = scratch.isOpen ? scratch.threadId : Option.none();

  const context: Thread.PageContext = {
    threadId,
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    launching: Option.exists(threadId, (id) => isLaunching(model, id)),
  };

  const unchanged =
    Equal.equals(model.scratchThread.threadId, context.threadId) &&
    model.scratchThread.epoch === context.epoch &&
    model.scratchThread.hasClient === context.hasClient &&
    model.scratchThread.launching === context.launching;

  return unchanged ? { model } : informScratchThread(model, context);
};

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

        return Update.combine(next, [sendNext, followLaunches]);
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
            outboxAttempt: () => 0,
            sentTurns: (turns) =>
              Option.match(Record.get(turns, key), {
                onNone: () => turns,
                onSome: (sent) =>
                  Option.isSome(launchedThread(sent))
                    ? Record.set(turns, key, { ...sent, acknowledged: true })
                    : Record.remove(turns, key),
              }),
          }),
          [persist, sendNext, followLaunches]
        ),
    FailedOutboxItem:
      ({ epoch, key, message, retryable, transport }) =>
      (model) => {
        if (!isCurrentEpoch(model, epoch)) {
          return { model };
        }

        if (retryable && transport) {
          // Left at the head; the connection reports the loss and the next live one sends it.
          return {
            model: modifyFields(model, { outboxInFlight: () => Option.none() }),
          };
        }

        if (retryable) {
          // The brain answered "not now" on a socket that stays up: sent again after a backoff
          // (or by the next connection, if this one drops first).
          const attempt = model.outboxAttempt + 1;

          return {
            model: modifyFields(model, {
              outboxInFlight: () => Option.none(),
              outboxAttempt: () => attempt,
            }),
            commands: [WaitToResend({ epoch, key, attempt })],
          };
        }

        return Update.combine(
          modifyFields(model, {
            outbox: (outbox) => remove(outbox, key),
            outboxInFlight: () => Option.none(),
            outboxAttempt: () => 0,
            notice: () => Option.some(message),
          }),
          [restoreSent(key), persist, sendNext]
        );
      },
    ElapsedResend:
      ({ epoch, key }) =>
      (model) =>
        // A timer from an earlier epoch, or for an item already answered, sends nothing: the head
        // must still be this item, and sendNext refuses while another send is in flight.
        isCurrentEpoch(model, epoch) &&
        Option.exists(
          Array.head(model.outbox),
          (head) => outboxKey(head) === key
        )
          ? sendNext(model)
          : { model },
    CompletedSaveOutbox:
      ({ saved }) =>
      (model) => ({
        model: modifyFields(model, {
          notice: (notice) =>
            saved
              ? Option.filter(notice, (text) => text !== UNSAVED_NOTICE)
              : Option.some(UNSAVED_NOTICE),
        }),
      }),
    DismissedNotice: () => (model) => ({
      model: modifyFields(model, { notice: () => Option.none() }),
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
    GotNextShellMessage:
      ({ message: nextShellMessage }) =>
      (model) =>
        foldNextShellMessage(model, nextShellMessage),
    GotScratchThreadMessage:
      ({ message: scratchMessage }) =>
      (model) =>
        foldScratchThreadMessage(model, scratchMessage),
    GotRequestCardMessage:
      ({ message: requestCardMessage }) =>
      (model) =>
        foldRequestCardMessage(model, requestCardMessage),
    GotMetersMessage:
      ({ message: metersMessage }) =>
      (model) =>
        foldMetersMessage(model, metersMessage),
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
    syncNextShell,
    syncScratchThread,
    syncRequestCard,
    syncMeters,
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
      outboxAttempt: 0,
      sentTurns: {},
      notice: Option.none(),
      thread: Thread.Model.initial,
      sidebar: initialSidebar,
      composer,
      push: initialPush,
      settings: initialSettings,
      parked: Parked.initial,
      nextShell: initialNextShell,
      scratchThread: Thread.Model.initial,
      requestCard: initialRequestCard,
      meters: initialMeters,
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
    syncNextShell,
    syncScratchThread,
    syncRequestCard,
    syncMeters,
    loadSettingsPage,
  ]);

  return {
    model: synced.model,
    commands: Array.appendAll(started.commands ?? [], synced.commands ?? []),
  };
};
