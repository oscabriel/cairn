// The transcript's update, and the two calls the thread page makes into it: `switchThread` when the
// routed thread changes (the old thread's list and open folds are kept, the new one's restored)
// and `afterView` after the page's view changed shape (a first snapshot or a page of history: the
// list re-anchors on its stable row keys, so nothing on screen moves). Per-thread scroll memory
// follows t3code's `rememberTimelinePosition` (github.com/pingdotgg/t3code,
// apps/web/src/components/chat/timelineScrollAnchoring.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92) by keeping each thread's whole list Model.
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import type { EntryId } from "@cairn/protocol/Ids";
import { ThreadId } from "@cairn/protocol/Ids";
import * as VirtualList from "@foldkit/ui/virtualList";
import { Option, Record, Schema } from "effect";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { CairnConnectionService } from "../connection/Connection.ts";
import {
  CopyText,
  ExpireCopied,
  LoadEarlier,
  PrepareRetry,
} from "./Command.ts";
import { Message, OutMessage } from "./Message.ts";
import type { Model, ThreadUi } from "./Model.ts";
import { freshUi, SAVED_THREAD_LIMIT } from "./Model.ts";
import { itemKeys, transcriptOf } from "./Rows.ts";

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  CairnConnectionService
>;

type Return = Update.Return<Model, Message, CairnConnectionService>;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const toggle = (
  ids: ReadonlyArray<string>,
  id: string
): ReadonlyArray<string> =>
  ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];

const readList = (model: Model): Option.Option<VirtualList.Model> =>
  Option.some(model.ui.list);

const writeList = (model: Model, list: VirtualList.Model): Model =>
  modifyFields(model, { ui: (ui) => modifyFields(ui, { list: () => list }) });

const toGotListMessage = (message: VirtualList.Message): Message =>
  Message.GotListMessage({ message });

const foldList = Update.foldChild({
  update: VirtualList.update,
  read: readList,
  write: writeList,
  toParentMessage: toGotListMessage,
});

const scrollToEnd = Update.foldChildStep({
  update: VirtualList.scrollToEnd,
  read: readList,
  write: writeList,
  toParentMessage: toGotListMessage,
});

const informList = (keys: ReadonlyArray<string>) =>
  Update.foldChildStep({
    update: (list: VirtualList.Model) =>
      VirtualList.informItemsChanged(list, keys),
    read: readList,
    write: writeList,
    toParentMessage: toGotListMessage,
  });

const modifyUi = (
  model: Model,
  change: (ui: ThreadUi) => ThreadUi
): Return => ({
  model: modifyFields(model, { ui: change }),
});

const copy = (model: Model, rowId: string, text: string): Return => {
  const version = model.copyVersion + 1;

  return {
    model: modifyFields(model, { copyVersion: () => version }),
    commands: [CopyText({ rowId, text, version })],
  };
};

const completedCopy = (model: Model, rowId: string, version: number): Return =>
  version === model.copyVersion
    ? {
        model: modifyFields(model, { copiedRowId: () => Option.some(rowId) }),
        commands: [ExpireCopied({ version })],
      }
    : { model };

const loadEarlier = (
  model: Model,
  threadId: string,
  before: EntryId
): Return =>
  model.history === "loading"
    ? { model }
    : {
        model: modifyFields(model, { history: () => "loading" as const }),
        commands: [LoadEarlier({ threadId, before })],
      };

const isCurrent = (model: Model, threadId: string): boolean =>
  Option.contains(model.threadId, threadId);

/** The transcript's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotListMessage: ({ message: listMessage }) => foldList(model, listMessage),
    ToggledTurnFold: ({ turnId }) =>
      modifyUi(model, (ui) =>
        modifyFields(ui, { expandedTurnIds: (ids) => toggle(ids, turnId) })
      ),
    ToggledWorkGroup: ({ groupId }) =>
      modifyUi(model, (ui) =>
        modifyFields(ui, {
          expandedWorkGroupIds: (ids) => toggle(ids, groupId),
        })
      ),
    ToggledUserMessage: ({ rowId }) =>
      modifyUi(model, (ui) =>
        modifyFields(ui, {
          expandedUserMessageIds: (ids) => toggle(ids, rowId),
        })
      ),
    ClickedScrollToEnd: () => scrollToEnd(model),
    ClickedLoadEarlier: ({ before, threadId }) =>
      loadEarlier(model, threadId, before),
    LoadedEarlier: ({ page, threadId }) =>
      isCurrent(model, threadId)
        ? {
            model: modifyFields(model, { history: () => "idle" as const }),
            outMessage: OutMessage.ReceivedHistory({ page }),
          }
        : { model },
    FailedEarlier: ({ threadId }) =>
      isCurrent(model, threadId)
        ? { model: modifyFields(model, { history: () => "failed" as const }) }
        : { model },
    ClickedRetry: ({ attachments, skillRefs, text, threadId }) =>
      Option.match(decodeThreadId(threadId), {
        onNone: () => ({ model }),
        onSome: (id) => ({
          model,
          commands: [
            PrepareRetry({ threadId: id, text, attachments, skillRefs }),
          ],
        }),
      }),
    PreparedRetry: ({ item }) => ({
      model,
      outMessage: OutMessage.RequestedSend({ item }),
    }),
    ClickedOpenDiff: ({ path, turn }) => ({
      model,
      outMessage: OutMessage.RequestedDiff({ turn, path }),
    }),
    ClickedCopy: ({ rowId, text }) => copy(model, rowId, text),
    CompletedCopy: ({ rowId, version }) => completedCopy(model, rowId, version),
    ExpiredCopied: ({ version }) =>
      version === model.copyVersion
        ? { model: modifyFields(model, { copiedRowId: () => Option.none() }) }
        : { model },
    LoadedLanguage: ({ language }) =>
      model.highlightedLanguages.includes(language)
        ? { model }
        : {
            model: modifyFields(model, {
              highlightedLanguages: (languages) => [...languages, language],
            }),
          },
    HighlightedCode: ({ language }) => ({
      model: modifyFields(model, {
        highlightedLanguages: (languages) =>
          languages.includes(language) ? languages : [...languages, language],
        highlightedCode: (count) => count + 1,
      }),
    }),
    FailedLanguage: () => ({ model }),
    MountedTimer: () => ({ model }),
    MountedFollowEnd: () => ({ model }),
  });

const saveCurrent = (model: Model): Pick<Model, "saved" | "savedOrder"> => {
  const savedOrder = Option.match(model.threadId, {
    onNone: () => model.savedOrder,
    onSome: (id) => [...model.savedOrder.filter((other) => other !== id), id],
  }).slice(-SAVED_THREAD_LIMIT);

  const withCurrent = Option.match(model.threadId, {
    onNone: () => model.saved,
    onSome: (id) => Record.set(model.saved, id, model.ui),
  });

  return {
    saved: Record.filter(withCurrent, (_, id) => savedOrder.includes(id)),
    savedOrder,
  };
};

/**
 * Shows `threadId`: the current thread's list and open folds are saved, and the new thread's saved
 * ones come back (or a fresh list at its end). A no-op for the thread already shown.
 */
export const switchThread = (
  model: Model,
  threadId: Option.Option<string>
): Return => {
  if (
    Option.getOrUndefined(model.threadId) === Option.getOrUndefined(threadId)
  ) {
    return { model };
  }

  const { saved, savedOrder } = saveCurrent(model);
  const restored = Option.flatMap(threadId, (id) => Record.get(saved, id));

  return {
    model: modifyFields(model, {
      threadId: () => threadId,
      ui: () => Option.getOrElse(restored, () => freshUi(threadId)),
      saved: () => saved,
      savedOrder: () => savedOrder,
      history: () => "idle" as const,
      copiedRowId: () => Option.none(),
    }),
  };
};

const viewReplaced = (
  before: Option.Option<ThreadViewState>,
  after: Option.Option<ThreadViewState>
): boolean =>
  Option.exists(after, (next) =>
    Option.match(before, {
      onNone: () => true,
      onSome: (previous) =>
        previous.older.length !== next.older.length ||
        previous.hasMoreHistory !== next.hasMoreHistory,
    })
  );

/**
 * Re-anchors the list after the page's view changed shape: its first snapshot, or a page of
 * history in front. Streaming needs nothing: rows keep their keys and the list measures them.
 */
export const afterView = (
  model: Model,
  before: Option.Option<ThreadViewState>,
  after: Option.Option<ThreadViewState>
): Return => {
  if (!viewReplaced(before, after) || Option.isNone(model.threadId)) {
    return { model };
  }

  const keys = itemKeys(
    transcriptOf(model.threadId.value, after, model.ui, Option.none())
  );

  return informList(keys)(model);
};
