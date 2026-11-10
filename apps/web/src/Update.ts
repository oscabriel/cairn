// The root update: routing, the connection's state machine (Reconnect.ts), the shell, and the
// outbox. After every Message the thread page is told the routed thread and the connection, so its
// stream follows both without the root reaching into the page's state.

import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import { userPromptsAfter } from "@cairn/client-logic/TimelineEntries";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { TurnInput } from "@cairn/protocol/Thread";
import { Array, Equal, Option, Predicate, Record, Schema } from "effect";
import { Update, Url } from "foldkit";
import type { Runtime } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";

import type { Message as RequestCardMessage } from "./card/Message.ts";
import { OutMessage as RequestCardOutMessage } from "./card/Message.ts";
import {
  approvalsDocumentOf,
  initial as initialRequestCard,
} from "./card/Model.ts";
import type { CardContext, Model as RequestCardModel } from "./card/Model.ts";
import { requestCard as RequestCard } from "./card/Update.ts";
import {
  CheckServerBuild,
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
import {
  draftProject,
  isDraftTarget,
  SCRATCH_DRAFT_KEY,
} from "./composer/Drafts.ts";
import { OutMessage as ComposerOutMessage } from "./composer/Message.ts";
import type { Message as ComposerMessage } from "./composer/Message.ts";
import { queuedInputs } from "./composer/Queue.ts";
import * as Composer from "./composer/Update.ts";
import {
  enqueue,
  enqueueDispatch,
  OutboxItem,
  outboxAttachments,
  outboxKey,
  readyToSend,
  rebaseOutbox,
  remove,
  withAttachments,
} from "./connection/Outbox.ts";
import {
  acquired,
  checksBuild,
  elapsed,
  hasClient,
  initialConnection,
  isLive,
  lost,
  synchronized,
  woke,
} from "./connection/Reconnect.ts";
import { Message } from "./Message.ts";
import type { Message as MetersMessage } from "./meters/Message.ts";
import { initial as initialMeters } from "./meters/Model.ts";
import type { MetersPage, Model as MetersModel } from "./meters/Model.ts";
import { meters as Meters } from "./meters/Update.ts";
import type { Flags, Model, SentTurn } from "./Model.ts";
import * as Chunks from "./page/Chunks.ts";
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
import * as Hold from "./shell/Hold.ts";
import { OutMessage as NextShellOutMessage } from "./shell/Message.ts";
import type { Message as NextShellMessage } from "./shell/Message.ts";
import { initial as initialNextShell } from "./shell/Model.ts";
import type {
  Model as NextShellModel,
  ShellContext as NextShellContext,
} from "./shell/Model.ts";
import { isCurrent } from "./shell/ShellStore.ts";
import * as NextShell from "./shell/Update.ts";
import { laterRead } from "./storage/TabChanges.ts";
import { threadRowOf } from "./ThreadRow.ts";
import type { QueuedSend } from "./timeline/Model.ts";
import { promptKey, sameSends } from "./timeline/Model.ts";

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

/**
 * The outbox items this tab still sends: every queued item except those it was refused and left
 * for the tab that queued them.
 */
const outboxSent = (model: Model): ReadonlyArray<OutboxItem> =>
  model.outbox.filter((item) => !model.outboxLeft.includes(outboxKey(item)));

/** Whether `threadId`'s launch is on its way: queued in the outbox, or its shell row is preparing. */
const isLaunching = (model: Model, threadId: ThreadId): boolean =>
  outboxSent(model).some(
    (item) =>
      Predicate.isTagged(item, "Launch") && item.input.threadId === threadId
  ) ||
  Option.exists(model.shell, (shell) =>
    shell.threads.some(
      (thread) => thread.id === threadId && thread.activity === "preparing"
    )
  );

/** The turn an outbox item sends to `threadId`: a send's, or a launch's first message. */
const turnTo = (
  item: OutboxItem,
  threadId: ThreadId
): Option.Option<TurnInput> => {
  if (Predicate.isTagged(item, "Send") && item.input.threadId === threadId) {
    return Option.some(item.input.input);
  }

  return Predicate.isTagged(item, "Launch") && item.input.threadId === threadId
    ? Option.some(item.input.initialMessage)
    : Option.none();
};

/** The thread an outbox item sends a turn to, with that turn; none for a shell command. */
const turnOf = (
  item: OutboxItem
): Option.Option<{ readonly threadId: ThreadId; readonly turn: TurnInput }> =>
  OutboxItem.match(item, {
    Send: ({ input }) =>
      Option.some({ threadId: input.threadId, turn: input.input }),
    Launch: ({ input }) =>
      Option.some({ threadId: input.threadId, turn: input.initialMessage }),
    Dispatch: () => Option.none(),
  });

/** A turn as the transcript draws it, with the names of the attachments this tab knows. */
const queuedSendOf = (
  model: Model,
  item: OutboxItem,
  turn: TurnInput,
  sent: boolean
): QueuedSend => {
  const refs = outboxAttachments(item);

  return {
    requestId: outboxKey(item),
    text: turn.text,
    attachments: turn.attachments,
    attachmentNames: turn.attachments.map(
      (attachmentId) =>
        refs.find((ref) => ref.id === attachmentId)?.name ?? "Attachment"
    ),
    skillRefs: turn.skillRefs,
    sent,
  };
};

/**
 * Where a queued turn's own row will come after: a launch's anywhere in its new thread, a send's
 * past the newest entry its thread showed when this tab first saw it queued (`outboxSince`); none
 * for a send this page did not queue, or queued while no page showed its thread's view.
 */
const sinceOf = (model: Model, item: OutboxItem): Option.Option<number> =>
  Predicate.isTagged(item, "Launch")
    ? Option.some(0)
    : Option.flatten(Record.get(model.outboxSince, outboxKey(item)));

/**
 * `since` with the items this page did not queue (read from storage at start, or adopted from
 * another tab) noted as having no entry to come after: the brain may already hold their rows.
 */
const notQueuedHere = (
  since: Model["outboxSince"],
  keys: ReadonlyArray<string>
): Model["outboxSince"] =>
  Array.reduce(keys, since, (noted, key) =>
    Record.set(noted, key, Option.none())
  );

/** The view `page` shows of `threadId`, when it shows that thread and its view arrived. */
const shownView = (
  page: Thread.Model.Model,
  threadId: string
): Option.Option<Thread.Model.ThreadViewModel> =>
  Option.exists(page.threadId, (id) => id === threadId)
    ? page.view
    : Option.none();

/**
 * Whether `send`'s own row has come in `state`: a user row past `since` with its words,
 * attachments and skills, or, once the brain acknowledged it, its words in the brain's queue
 * (`pi.inbox`), which the composer lists from then on. A send first seen before its thread's view
 * arrived, or one this page did not queue, has no `since`: it is matched only once acknowledged,
 * then against any row, so it never waits for a row that came before it was seen.
 */
const hasCome = (
  state: Thread.Model.ThreadViewModel,
  send: QueuedSend,
  since: Option.Option<number>
): boolean => {
  if (Option.isNone(since) && !send.sent) {
    return false;
  }

  const key = promptKey(send.text, send.attachments, send.skillRefs);

  return (
    userPromptsAfter(
      state.view.entries,
      Option.getOrElse(since, () => -1)
    ).some(
      (prompt) =>
        promptKey(prompt.text, prompt.attachments, prompt.skills) === key
    ) ||
    (send.sent &&
      queuedInputs(Record.get(state.view.docs, "pi.inbox")).some(
        (input) => input.text === send.text.trim()
      ))
  );
};

/**
 * The sends to `threadId` whose own row `page` does not show yet: those the brain acknowledged
 * (`outboxEchoes`), then those still in the outbox.
 */
const queuedSendsFor = (
  model: Model,
  page: Thread.Model.Model,
  threadId: Option.Option<ThreadId>
): ReadonlyArray<QueuedSend> =>
  Option.match(threadId, {
    onNone: () => [],
    onSome: (id) => {
      const state = shownView(page, id);

      const pending = (send: QueuedSend, since: Option.Option<number>) =>
        !Option.exists(state, (shown) => hasCome(shown, send, since));

      const echoes = model.outboxEchoes.flatMap((awaited) =>
        awaited.threadId === id && pending(awaited.send, awaited.since)
          ? [awaited.send]
          : []
      );

      const queued = outboxSent(model).flatMap((item) =>
        Option.match(turnTo(item, id), {
          onNone: () => [],
          onSome: (turn) => {
            const send = queuedSendOf(model, item, turn, false);

            return pending(send, sinceOf(model, item)) ? [send] : [];
          },
        })
      );

      return [...echoes, ...queued];
    },
  });

/** The newest entry of `threadId`'s view as a page of `model` shows it, when one does. */
const newestShown = (model: Model, threadId: string): Option.Option<number> =>
  Array.findFirst([model.thread, model.scratchThread], (page) =>
    Option.flatMap(shownView(page, threadId), (state) =>
      Option.fromUndefinedOr(state.view.entries.at(-1)?.id)
    )
  );

/**
 * Keeps the pending rows' bookkeeping for the thread `page` shows: notes where each send this page
 * queued starts (`outboxSince`) in the update that first sees it, as none for good when no page
 * showed its thread's view then (a view that comes later may already hold its row), forgets the
 * records of items gone from the outbox, and drops the acknowledged sends whose row came or whose
 * launch failed. `left` is the thread the page is leaving, whose acknowledged sends are dropped:
 * their rows show as the brain's once the page is back.
 */
const trackSends = (
  model: Model,
  page: Thread.Model.Model,
  left: Option.Option<string>
): Model => {
  const noted: { [key: string]: Option.Option<number> } = Record.filter(
    model.outboxSince,
    (_, key) => model.outbox.some((item) => outboxKey(item) === key)
  );

  for (const item of model.outbox) {
    if (
      Predicate.isTagged(item, "Send") &&
      !Record.has(noted, outboxKey(item))
    ) {
      noted[outboxKey(item)] = newestShown(model, item.input.threadId);
    }
  }

  const failed = (threadId: string): boolean =>
    Option.exists(model.shell, (shell) =>
      shell.threads.some(
        (thread) => thread.id === threadId && thread.activity === "failed"
      )
    );

  const echoes = model.outboxEchoes.filter(
    (awaited) =>
      !Option.contains(left, awaited.threadId) &&
      !(awaited.launch && failed(awaited.threadId)) &&
      !Option.exists(shownView(page, awaited.threadId), (state) =>
        hasCome(state, awaited.send, awaited.since)
      )
  );

  const sameSince =
    Record.size(noted) === Record.size(model.outboxSince) &&
    Record.every(noted, (value, key) => model.outboxSince[key] === value);

  return sameSince && echoes.length === model.outboxEchoes.length
    ? model
    : modifyFields(model, {
        outboxSince: () => (sameSince ? model.outboxSince : noted),
        outboxEchoes: () => echoes,
      });
};

/**
 * Keeps an acknowledged send (or launch) to a thread a page shows as a pending row, marked sent,
 * until its own row comes (`hasCome`): the acknowledgement and the row reach the page in either
 * order, and a launch's first message waits behind its workspace for as long as that takes.
 */
const awaitEcho = (model: Model, key: string): Model["outboxEchoes"] => {
  const awaited = Option.flatMap(
    Array.findFirst(model.outbox, (item) => outboxKey(item) === key),
    (item) =>
      Option.map(
        Option.filter(turnOf(item), ({ threadId }) =>
          [model.thread, model.scratchThread].some((page) =>
            Option.contains(page.threadId, threadId)
          )
        ),
        ({ threadId, turn }) => ({
          threadId,
          send: queuedSendOf(model, item, turn, true),
          since: sinceOf(model, item),
          launch: Predicate.isTagged(item, "Launch"),
        })
      )
  );

  return Option.isSome(awaited) &&
    !model.outboxEchoes.some(({ send }) => send.requestId === key)
    ? [...model.outboxEchoes, awaited.value]
    : model.outboxEchoes;
};

/** Tells the thread page the routed thread and the connection; a no-op when nothing changed. */
const syncThread: Step = (current) => {
  const threadId = routedThreadId(current.route);

  const model = trackSends(
    current,
    current.thread,
    Option.filter(
      current.thread.threadId,
      (id) => !Option.contains(threadId, id)
    )
  );

  const context: Thread.PageContext = {
    threadId,
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    launching: Option.exists(threadId, (id) => isLaunching(model, id)),
    queuedSends: queuedSendsFor(model, model.thread, threadId),
  };

  const unchanged =
    Equal.equals(model.thread.threadId, context.threadId) &&
    model.thread.epoch === context.epoch &&
    model.thread.hasClient === context.hasClient &&
    model.thread.launching === context.launching &&
    sameSends(model.thread.timeline.queuedSends, context.queuedSends);

  return unchanged ? { model } : informThread(model, context);
};

/** Saves what this tab changed in the outbox since it last read or wrote it. */
const persist: Step = (model) => ({
  model,
  commands: [
    SaveOutbox({
      base: model.outboxStored,
      read: model.outboxRead,
      outbox: model.outbox,
    }),
  ],
});

/**
 * Sends each lane's head when the connection is live, unless that lane has an item in flight or
 * waiting out its resend backoff (`readyToSend`).
 */
const sendNext: Step = (model) => {
  const ready = readyToSend(
    outboxSent(model),
    model.outboxInFlight,
    model.outboxResend,
    isLive(model.connection)
  );

  return ready.length === 0
    ? { model }
    : {
        model: modifyFields(model, {
          outboxInFlight: (inFlight) => [...inFlight, ...ready.map(outboxKey)],
        }),
        commands: ready.map((item) =>
          SendOutboxItem({ epoch: model.connection.epoch, item })
        ),
      };
};

/** `keys` without `key`. */
const without = (
  keys: ReadonlyArray<string>,
  key: string
): ReadonlyArray<string> => Array.filter(keys, (other) => other !== key);

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
      outboxInFlight: () => [],
      // The next connection sends each lane's head at once.
      outboxResend: () => [],
    }),
    commands: Option.match(next.wait, {
      onNone: () => [],
      // Dials refused a few times in a row may be a server that moved to another protocol.
      onSome: (wait) =>
        checksBuild(wait.attempt)
          ? [WaitForBackoff(wait), CheckServerBuild()]
          : [WaitForBackoff(wait)],
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
    scratchThreadId: model.nextShell.scratch.threadId,
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

const sameRow = Option.makeEquivalence<object>((left, right) => left === right);

/** Tells the hold banner the open thread's shell row, when it changed. */
const syncHold: Step = (model) => {
  const thread = Option.flatMap(routedThreadId(model.route), (id) =>
    threadRowOf(model.shell, id)
  );

  return sameRow(model.hold.thread, thread)
    ? { model }
    : { model: modifyFields(model, { hold: () => ({ thread }) }) };
};

const toGotMetersMessage = (message: MetersMessage): Message =>
  Message.GotMetersMessage({ message });

const readMeters = (model: Model): Option.Option<MetersModel> =>
  Option.some(model.meters);

const writeMeters = (model: Model, meters: MetersModel): Model =>
  modifyFields(model, { meters: () => meters });

/** Folds a meters Message through the meters' update. */
const foldMetersMessage = Update.foldChild({
  update: Meters.update,
  read: readMeters,
  write: writeMeters,
  toParentMessage: toGotMetersMessage,
});

const informMeters = Update.foldChild({
  update: Meters.inform,
  read: readMeters,
  write: writeMeters,
  toParentMessage: toGotMetersMessage,
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

/** Tells the meters the connection, the open page, the plan windows and the rows' spend. */
const syncMeters: Step = (model) => {
  const context = Meters.contextOf({
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    page: metersPageOf(model.route),
    usage: model.settings.usage,
    shell: model.shell,
  });

  return Meters.sameContext(model.meters, context)
    ? { model }
    : informMeters(model, context);
};

const toGotChunkMessage = (message: Chunks.Message): Message =>
  Message.GotChunkMessage({ message });

const readChunks = (model: Model): Option.Option<Chunks.Model> =>
  Option.some(model.chunks);

const writeChunks = (model: Model, chunks: Chunks.Model): Model =>
  modifyFields(model, { chunks: () => chunks });

/**
 * A chunk its view waited for failed: the notice bar says which, and the view closes, so its
 * control's next tap opens it again and asks again (a touch screen has no Escape).
 */
const foldChunkOutMessage = (outMessage: Chunks.OutMessage): Step =>
  Chunks.OutMessage.match<Step>(outMessage, {
    FailedChunk:
      ({ chunk }) =>
      (model) => ({
        model: modifyFields(Chunks.closeWaiting(chunk, model), {
          notice: () => Option.some(Chunks.failureNotice(chunk)),
        }),
      }),
  });

const foldChunkMessage = Update.foldChild({
  update: Chunks.update,
  read: readChunks,
  write: writeChunks,
  toParentMessage: toGotChunkMessage,
  foldOutMessage: foldChunkOutMessage,
});

/** Starts the warm-up that fetches every chunk once the page is interactive. */
const startChunks = Update.foldChildStep({
  update: Chunks.start,
  read: readChunks,
  write: writeChunks,
  toParentMessage: toGotChunkMessage,
});

const wantChunks = Update.foldChild({
  update: Chunks.want,
  read: readChunks,
  write: writeChunks,
  toParentMessage: toGotChunkMessage,
});

/** Asks for the chunks of the views the page now draws (W-8: they are not in the entry). */
const syncChunks: Step = (model) => {
  const wanted = Chunks.wantedChunks(model);

  return Chunks.isServed(model.chunks, wanted)
    ? { model }
    : wantChunks(model, wanted);
};

const toGotNextShellMessage = (message: NextShellMessage): Message =>
  Message.GotNextShellMessage({ message });

const readNextShell = (model: Model): Option.Option<NextShellModel> =>
  Option.some(model.nextShell);

const writeNextShell = (model: Model, nextShell: NextShellModel): Model =>
  nextShell === model.nextShell
    ? model
    : modifyFields(model, { nextShell: () => nextShell });

/** The hero's Add project: the shell opens its add-project picker. */
const openShellAddProject = Update.foldChildStep({
  update: NextShell.openAddProject,
  read: readNextShell,
  write: writeNextShell,
  toParentMessage: toGotNextShellMessage,
});

/** The hero's project picker chose a project: the shell's rail follows it. */
const followDraftProject = (projectId: ProjectId): Step =>
  Update.foldChildStep({
    update: NextShell.followDraftProject(projectId),
    read: readNextShell,
    write: writeNextShell,
    toParentMessage: toGotNextShellMessage,
  });

/**
 * The notice raised when storage holds drafts or outbox items this build cannot decode (another
 * build saved them), once for each (`readShared` in `storage/TabChanges.ts`).
 */
export const UNREAD_STORED_NOTICE =
  "Some drafts or unsent changes were saved by another version of Cairn and cannot be used here. They stay on this device, though writing in one of those threads replaces its old draft.";

const toGotRequestCardMessage = (message: RequestCardMessage): Message =>
  Message.GotRequestCardMessage({ message });

const readRequestCard = (model: Model): Option.Option<RequestCardModel> =>
  Option.some(model.requestCard);

const writeRequestCard = (model: Model, requestCard: RequestCardModel): Model =>
  modifyFields(model, { requestCard: () => requestCard });

// What the composer reports, told to the request card for its typing guard (W-1).

const composerFocusedCard = Update.foldChildStep({
  update: RequestCard.composerFocused,
  read: readRequestCard,
  write: writeRequestCard,
  toParentMessage: toGotRequestCardMessage,
});

const composerBlurredCard = Update.foldChildStep({
  update: RequestCard.composerBlurred,
  read: readRequestCard,
  write: writeRequestCard,
  toParentMessage: toGotRequestCardMessage,
});

const composerTypedCard = Update.foldChildStep({
  update: RequestCard.composerTyped,
  read: readRequestCard,
  write: writeRequestCard,
  toParentMessage: toGotRequestCardMessage,
});

const composerSentCard = Update.foldChildStep({
  update: RequestCard.composerSent,
  read: readRequestCard,
  write: writeRequestCard,
  toParentMessage: toGotRequestCardMessage,
});

/**
 * After a turn the scratch overlay's composer sent (U-16): a launch's thread is the overlay's from
 * now on, which the shell keeps; a send changes nothing there.
 */
const adoptScratchLaunch =
  (item: SentTurn["item"]): Step =>
  (model) =>
    Predicate.isTagged(item, "Launch")
      ? Update.foldChildStep({
          update: NextShell.adoptScratchThread(item.input.threadId),
          read: readNextShell,
          write: writeNextShell,
          toParentMessage: toGotNextShellMessage,
        })(model)
      : { model };

/**
 * What the composer hands up: a turn for the outbox (and where to go), a request for the
 * add-project picker, the draft's chosen project, saved drafts it cannot show, or its focus and
 * keystrokes, which the request card's typing guard reads.
 */
const foldComposerOutMessage = (outMessage: ComposerOutMessage): Step =>
  ComposerOutMessage.match<Step>(outMessage, {
    Submitted:
      ({ attachments, draftKey, item: turn, navigateTo }) =>
      (model) => {
        // The scratch overlay's turn, by the draft it was sent from, whether the overlay still
        // shows or not: a refusal puts it back in the overlay, and the thread its first message
        // launches is the overlay's from now on (U-16).
        const fromScratch = draftKey === SCRATCH_DRAFT_KEY;

        // Its attachments' refs are saved with it, so a refusal after a reload puts them back too.
        const item = withAttachments(turn, attachments);

        return Update.combine(
          modifyFields(model, {
            outbox: (outbox) => enqueue(outbox, item),
            sentTurns: (sent) =>
              Predicate.isTagged(item, "Dispatch")
                ? sent
                : Record.set(sent, outboxKey(item), {
                    item,
                    acknowledged: false,
                    fromScratch,
                  }),
          }),
          [
            persist,
            sendNext,
            (next) =>
              fromScratch ? adoptScratchLaunch(item)(next) : { model: next },
            (next) => ({
              model: next,
              commands: Option.match(navigateTo, {
                onNone: () => [],
                onSome: (url) => [NavigateInternal({ url })],
              }),
            }),
            composerSentCard,
          ]
        );
      },
    // The shell owns the add-project picker, and its rail follows the draft's project.
    RequestedAddProject: () => openShellAddProject,
    ChoseDraftProject: ({ projectId }) => followDraftProject(projectId),
    FoundUnreadDrafts: () => (model) => ({
      model: modifyFields(model, {
        notice: () => Option.some(UNREAD_STORED_NOTICE),
      }),
    }),
    Focused: () => composerFocusedCard,
    Blurred: () => composerBlurredCard,
    Typed: () => composerTypedCard,
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

/** Folds a request card Message through the card's update. */
const foldRequestCardMessage = Update.foldChild({
  update: RequestCard.update,
  read: readRequestCard,
  write: writeRequestCard,
  toParentMessage: toGotRequestCardMessage,
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

const informRequestCard = Update.foldChild({
  update: RequestCard.inform,
  read: readRequestCard,
  write: writeRequestCard,
  toParentMessage: toGotRequestCardMessage,
  foldOutMessage: foldRequestCardOutMessage,
});

/**
 * Tells the request card the open thread's decision records and the connection. The card counts a
 * client only once the connection is Live, so a reconnect re-checks the shown request's models on a
 * socket that is up, not while it is still Syncing.
 */
const syncRequestCard: Step = (model) => {
  const context: CardContext = {
    threadId: model.thread.threadId,
    approvals: approvalsDocumentOf(model.thread.view),
    hasClient: isLive(model.connection),
  };

  return RequestCard.sameContext(model.requestCard, context)
    ? { model }
    : informRequestCard(model, context);
};

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
    // The shown scratch overlay's composer is the one composer (U-16).
    scratch: model.nextShell.scratch.isOpen
      ? Option.some({
          threadId: model.nextShell.scratch.threadId,
          threadView: Option.map(
            model.scratchThread.view,
            (state) => state.view
          ),
        })
      : Option.none(),
  });

  return Composer.contextChanged(model.composer, context)
    ? informComposer(model, context)
    : { model };
};

/**
 * Hands the composer the Send shortcut and Follow-up behaviour chosen on the settings page, once
 * this device's settings have loaded. Settings owns them; the composer's own saved copy only
 * stands in until then.
 */
const syncComposerSettings: Step = (model) => {
  const { client, clientLoaded } = model.settings;
  const current = model.composer.settings;

  return !clientLoaded ||
    (current.sendShortcut === client.sendShortcut &&
      current.followUpBehavior === client.followUpBehavior)
    ? { model }
    : {
        model: modifyFields(model, {
          composer: (composer) =>
            modifyFields(composer, {
              settings: (settings) =>
                modifyFields(settings, {
                  sendShortcut: () => client.sendShortcut,
                  followUpBehavior: () => client.followUpBehavior,
                }),
            }),
        }),
      };
};

const isCurrentEpoch = (model: Model, epoch: number): boolean =>
  model.connection.epoch === epoch;

/** Puts a turn the brain refused, or a launch that failed, back in the composer. */
const restoreComposerTurn = Update.foldChild({
  update: (composer: Model["composer"], sent: SentTurn) =>
    Composer.restoreTurn(composer, sent.item, outboxAttachments(sent.item)),
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
});

/** The thread a sent launch makes, when `sent` is a launch. */
const launchedThread = (sent: SentTurn): Option.Option<ThreadId> =>
  Predicate.isTagged(sent.item, "Launch")
    ? Option.some(sent.item.input.threadId)
    : Option.none();

/** The thread a turn goes to; none for a shell command. */
const turnThread = (item: SentTurn["item"]): Option.Option<ThreadId> =>
  OutboxItem.match(item, {
    Send: ({ input }) => Option.some(input.threadId),
    Launch: ({ input }) => Option.some(input.threadId),
    Dispatch: () => Option.none(),
  });

/** True when `threadId` is the scratch overlay's thread. */
const isScratchThread = (model: Model, threadId: ThreadId): boolean =>
  Option.contains(model.nextShell.scratch.threadId, threadId);

/** Puts a refused scratch turn back in the scratch overlay's composer draft (U-16). */
const restoreComposerScratchTurn = Update.foldChild({
  update: (composer: Model["composer"], sent: SentTurn) =>
    Composer.restoreScratchTurn(
      composer,
      sent.item,
      outboxAttachments(sent.item)
    ),
  read: readComposer,
  write: writeComposer,
  toParentMessage: toGotComposerMessage,
});

/** A scratch launch failed: the shell lets its thread go, so the next turn launches a new one. */
const forgetScratchLaunch = (threadId: ThreadId): Step =>
  Update.foldChildStep({
    update: NextShell.forgetScratchLaunch(threadId),
    read: readNextShell,
    write: writeNextShell,
    toParentMessage: toGotNextShellMessage,
  });

/** The text of the notice raised when the outbox cannot be saved; it clears once a save works. */
const UNSAVED_NOTICE =
  "Unsent changes could not be saved on this device. Keep this page open until they are sent.";

/**
 * Restores the turn `key` names and forgets it. A refused launch the user is waiting on, on its
 * thread's page, opens its draft again. A turn with no record (the page reloaded since it was
 * queued, and records live in memory) comes back from `refused`, the outbox item itself, which
 * keeps its words, settings and attachments' refs.
 */
const restoreSent =
  (key: string, refused: Option.Option<SentTurn["item"]>): Step =>
  (model) =>
    Option.match(
      Option.orElse(Record.get(model.sentTurns, key), () =>
        Option.map(refused, (item): SentTurn => ({
          item,
          acknowledged: false,
          // With no record the origin is unknown; the scratch thread's turns go back to the overlay.
          fromScratch: Option.exists(turnThread(item), (threadId) =>
            isScratchThread(model, threadId)
          ),
        }))
      ),
      {
        onNone: () => ({ model }),
        onSome: (sent) => {
          const forgotten = modifyFields(model, {
            sentTurns: (turns) => Record.remove(turns, key),
          });

          if (sent.fromScratch) {
            return Update.combine(forgotten, [
              restoreComposerScratchTurn(sent),
              ...Option.toArray(
                Option.map(launchedThread(sent), forgetScratchLaunch)
              ),
            ]);
          }

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
      }
    );

/**
 * The record of the turn `key` once the brain acknowledged it, here or in the tab whose answer
 * removed it from the outbox (a tab leaves another's refused turn queued): a launch waits for its
 * shell row, and a send is done.
 */
const settleAcknowledged = (
  turns: Model["sentTurns"],
  key: string
): Model["sentTurns"] =>
  Option.match(Record.get(turns, key), {
    onNone: () => turns,
    onSome: (sent) =>
      Option.isSome(launchedThread(sent))
        ? Record.set(turns, key, { ...sent, acknowledged: true })
        : Record.remove(turns, key),
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
            ? restoreSent(key, Option.none())
            : (current) => ({
                model: modifyFields(current, {
                  sentTurns: (turns) => Record.remove(turns, key),
                }),
              })
        )
      );
    },
  });

/**
 * What the shell hands up: an item for the outbox (and where to go), a path to open, or a
 * new draft in the project the rail picked.
 */
const foldNextShellOutMessage = (outMessage: NextShellOutMessage): Step =>
  NextShellOutMessage.match<Step>(outMessage, {
    RequestedOutbox:
      ({ item, navigateTo }) =>
      (model) =>
        Update.combine(
          modifyFields(model, {
            outbox: (outbox) => enqueue(outbox, item),
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
    RequestedNavigate:
      ({ url }) =>
      (model) => ({ model, commands: [NavigateInternal({ url })] }),
    RequestedDispatch:
      ({ command }) =>
      (model) =>
        Update.combine(
          modifyFields(model, {
            outbox: (outbox) =>
              enqueueDispatch(outbox, command, model.outboxInFlight),
          }),
          [persist, sendNext]
        ),
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

const foldNextShellMessage = Update.foldChild({
  update: NextShell.update,
  read: readNextShell,
  write: writeNextShell,
  toParentMessage: toGotNextShellMessage,
  foldOutMessage: foldNextShellOutMessage,
});

const informNextShell = Update.foldChild({
  update: NextShell.inform,
  read: readNextShell,
  write: writeNextShell,
  toParentMessage: toGotNextShellMessage,
});

/** Tells the shell the shell, the route, the connection and the clock, when they changed. */
const syncNextShell: Step = (model) => {
  const current = model.nextShell.context;

  const context: NextShellContext = {
    shell: model.shell,
    route: model.route,
    hasClient: hasClient(model.connection),
    isLive: isLive(model.connection),
    defaults: Option.map(model.hello, (hello) => hello.defaults),
    // The rail and the list show the project the hero names (U-21).
    draftProjectId: isDraftTarget(model.composer)
      ? Option.map(draftProject(model.composer), (project) => project.id)
      : Option.none(),
  };

  // The first update starts the shell, even with nothing new to tell.
  const unchanged =
    model.nextShell.started &&
    current.shell === context.shell &&
    Equal.equals(current.route, context.route) &&
    current.hasClient === context.hasClient &&
    current.isLive === context.isLive &&
    Equal.equals(current.defaults, context.defaults) &&
    Equal.equals(current.draftProjectId, context.draftProjectId);

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
 * Tells the scratch thread's page which thread the shell's overlay shows: its scratch thread
 * while the overlay is open, none while it is hidden, so a hidden overlay holds no stream.
 */
const syncScratchThread: Step = (current) => {
  const { scratch } = current.nextShell;
  const threadId = scratch.isOpen ? scratch.threadId : Option.none();

  const model = trackSends(
    current,
    current.scratchThread,
    Option.filter(
      current.scratchThread.threadId,
      (id) => !Option.contains(threadId, id)
    )
  );

  const context: Thread.PageContext = {
    threadId,
    epoch: model.connection.epoch,
    hasClient: hasClient(model.connection),
    launching: Option.exists(threadId, (id) => isLaunching(model, id)),
    queuedSends: queuedSendsFor(model, model.scratchThread, threadId),
  };

  const unchanged =
    Equal.equals(model.scratchThread.threadId, context.threadId) &&
    model.scratchThread.epoch === context.epoch &&
    model.scratchThread.hasClient === context.hasClient &&
    model.scratchThread.launching === context.launching &&
    sameSends(model.scratchThread.timeline.queuedSends, context.queuedSends);

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
    // A navigation is a new open: a page whose chunk failed asks for it again.
    ChangedUrl:
      ({ url }) =>
      (model) => ({
        model: modifyFields(model, {
          route: () => urlToAppRoute(url),
          chunks: Chunks.navigated,
        }),
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
    CheckedServerBuild: () => (model) => ({ model }),
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
              isCurrentEpoch(model, epoch) ? without(inFlight, key) : inFlight,
            outboxAttempt: (attempts) => Record.remove(attempts, key),
            outboxResend: (waiting) => without(waiting, key),
            sentTurns: (turns) => settleAcknowledged(turns, key),
            // Its pending row stays until its own row comes, not only until this answer.
            outboxEchoes: () => awaitEcho(model, key),
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
          // Left at its lane's head; the connection reports the loss and the next live one sends it.
          return {
            model: modifyFields(model, {
              outboxInFlight: (inFlight) => without(inFlight, key),
            }),
          };
        }

        if (retryable) {
          // The brain answered "not now" on a socket that stays up: sent again after a backoff
          // (or by the next connection, if this one drops first); its lane waits, the others go on.
          const attempt = (model.outboxAttempt[key] ?? 0) + 1;

          return {
            model: modifyFields(model, {
              outboxInFlight: (inFlight) => without(inFlight, key),
              outboxAttempt: (attempts) => Record.set(attempts, key, attempt),
              outboxResend: (waiting) => [...without(waiting, key), key],
            }),
            commands: [WaitToResend({ epoch, key, attempt })],
          };
        }

        const refused = Array.findFirst(
          model.outbox,
          (item) => outboxKey(item) === key
        );

        // Another tab's turn stays queued for that tab, which puts it back with its attachments.
        if (
          model.outboxAdopted.includes(key) &&
          Option.exists(
            refused,
            (item) => !Predicate.isTagged(item, "Dispatch")
          )
        ) {
          return sendNext(
            modifyFields(model, {
              outboxInFlight: (inFlight) => without(inFlight, key),
              outboxAttempt: (attempts) => Record.remove(attempts, key),
              outboxLeft: (left) => [...left, key],
              notice: () => Option.some(message),
            })
          );
        }

        return Update.combine(
          modifyFields(model, {
            outbox: (outbox) => remove(outbox, key),
            outboxInFlight: (inFlight) => without(inFlight, key),
            outboxAttempt: (attempts) => Record.remove(attempts, key),
            notice: () => Option.some(message),
          }),
          [
            restoreSent(
              key,
              model.outboxAdopted.includes(key) ? Option.none() : refused
            ),
            persist,
            sendNext,
          ]
        );
      },
    ElapsedResend:
      ({ epoch, key }) =>
      (model) =>
        // A timer from an earlier epoch, or for an item no longer waiting, sends nothing; the wait
        // over, the head goes (this item, unless another tab's answer removed it meanwhile).
        isCurrentEpoch(model, epoch) && model.outboxResend.includes(key)
          ? sendNext(
              modifyFields(model, {
                outboxResend: (waiting) => without(waiting, key),
              })
            )
          : { model },
    // Saving merges into what the other tab wrote, and its answer brings those items here.
    ChangedStoredOutbox: () => persist,
    CompletedSaveOutbox:
      ({ read, stored, written }) =>
      (model) =>
        Option.match(stored, {
          onNone: () => ({
            model: modifyFields(model, {
              notice: () => Option.some(UNSAVED_NOTICE),
            }),
          }),
          onSome: (saved) => {
            const outbox = rebaseOutbox(written, model.outbox, saved);
            const keys = outbox.map(outboxKey);
            const held = model.outbox.map(outboxKey);
            const settled = Array.filter(held, (key) => !keys.includes(key));
            const adopting = Array.filter(keys, (key) => !held.includes(key));

            return Update.combine(
              modifyFields(model, {
                outbox: () => outbox,
                outboxStored: () => saved,
                outboxRead: (last) => laterRead(read, last),
                outboxAdopted: (adopted) => [
                  ...Array.filter(adopted, (key) => keys.includes(key)),
                  ...adopting,
                ],
                outboxSince: (since) => notQueuedHere(since, adopting),
                outboxLeft: (left) =>
                  Array.filter(left, (key) => keys.includes(key)),
                sentTurns: (turns) =>
                  Array.reduce(settled, turns, settleAcknowledged),
                notice: (notice) =>
                  Option.filter(notice, (text) => text !== UNSAVED_NOTICE),
              }),
              [sendNext, followLaunches]
            );
          },
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
    GotPushMessage:
      ({ message: pushMessage }) =>
      (model) =>
        foldPushMessage(model, pushMessage),
    GotSettingsMessage:
      ({ message: settingsMessage }) =>
      (model) =>
        foldSettingsMessage(model, settingsMessage),
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
    GotChunkMessage:
      ({ message: chunkMessage }) =>
      (model) =>
        foldChunkMessage(model, chunkMessage),
  });

/** The root update. */
export const update = (model: Model, message: Message): UpdateReturn => {
  burnBusyBudget();

  return Update.combine(model, [
    step(message),
    syncThread,
    syncComposer,
    syncPush,
    syncSettings,
    syncComposerSettings,
    syncHold,
    syncNextShell,
    syncScratchThread,
    syncRequestCard,
    syncMeters,
    syncChunks,
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
      outboxStored: flags.outbox,
      outboxRead: flags.outboxRead,
      outboxInFlight: [],
      outboxAttempt: {},
      outboxResend: [],
      sentTurns: {},
      outboxSince: notQueuedHere({}, flags.outbox.map(outboxKey)),
      outboxEchoes: [],
      outboxAdopted: [],
      outboxLeft: [],
      notice: flags.outboxUnread
        ? Option.some(UNREAD_STORED_NOTICE)
        : Option.none(),
      thread: Thread.Model.initial,
      composer,
      push: initialPush,
      settings: initialSettings,
      hold: Hold.initial,
      nextShell: initialNextShell,
      scratchThread: Thread.Model.initial,
      requestCard: initialRequestCard,
      meters: initialMeters,
      chunks: Chunks.initial,
    }),
    toParentMessage: toGotComposerMessage,
  });

  const synced = Update.combine(started.model, [
    syncThread,
    syncComposer,
    startPush,
    syncPush,
    startSettings,
    syncSettings,
    syncComposerSettings,
    syncHold,
    syncNextShell,
    syncScratchThread,
    syncRequestCard,
    syncMeters,
    startChunks,
    syncChunks,
  ]);

  return {
    model: synced.model,
    commands: Array.appendAll(started.commands ?? [], synced.commands ?? []),
  };
};
