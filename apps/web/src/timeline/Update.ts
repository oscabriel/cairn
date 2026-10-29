// The transcript's update, and the two calls the thread page makes into it: `switchThread` when the
// routed thread changes (the old thread's list and open folds are kept, the new one's restored)
// and `afterView` after the page's view changed shape (a first snapshot or a page of history: the
// list forgets the heights of rows that are gone; list/Place.ts keeps what is on screen still).
// Per-thread scroll memory follows t3code's `rememberTimelinePosition` (github.com/pingdotgg/t3code,
// apps/web/src/components/chat/timelineScrollAnchoring.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92) by keeping each thread's whole list Model.

import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import type { EntryId } from "@cairn/protocol/Ids";
import { ThreadId } from "@cairn/protocol/Ids";
import { Option, Record, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { CairnConnectionService } from "../connection/Connection.ts";
import {
  CopyText,
  ExpireCopied,
  LoadEarlier,
  PrepareRetry,
} from "./Command.ts";
import type * as ListModel from "./list/Model.ts";
import * as List from "./list/Update.ts";
import { Message, OutMessage } from "./Message.ts";
import type { Model, ThreadUi } from "./Model.ts";
import { freshUi, SAVED_THREAD_LIMIT } from "./Model.ts";
import { itemKeys, transcriptForKeys } from "./Rows.ts";

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

const modifyList = (
  model: Model,
  change: (list: ListModel.Model) => ListModel.Model
): Model =>
  modifyFields(model, { ui: (ui) => modifyFields(ui, { list: change }) });

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

// A refused clipboard write shows no check (T33).
const completedCopy = (
  model: Model,
  rowId: string,
  version: number,
  copied: boolean
): Return =>
  copied && version === model.copyVersion
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
    GotListMessage: ({ message: listMessage }) => ({
      model: modifyList(model, (list) => List.update(list, listMessage)),
    }),
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
    ClickedScrollToEnd: () => ({ model: modifyList(model, List.scrollToEnd) }),
    ClickedLoadEarlier: ({ before, threadId }) =>
      loadEarlier(model, threadId, before),
    LoadedEarlier: ({ before, page, threadId }) =>
      isCurrent(model, threadId)
        ? {
            model: modifyFields(model, { history: () => "idle" as const }),
            outMessage: OutMessage.ReceivedHistory({ before, page }),
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
    CompletedCopy: ({ copied, rowId, version }) =>
      completedCopy(model, rowId, version, copied),
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
 * After the page's view changed shape (its first snapshot, or a page of history in front), the list
 * forgets the heights of rows that are gone. Streaming needs nothing: rows keep their keys.
 */
export const afterView = (
  model: Model,
  before: Option.Option<ThreadViewState>,
  after: Option.Option<ThreadViewState>
): Return => {
  if (!viewReplaced(before, after) || Option.isNone(model.threadId)) {
    return { model };
  }

  const keys = new Set(
    itemKeys(transcriptForKeys(model.threadId.value, after, model.ui))
  );

  return { model: modifyList(model, (list) => List.keepRows(list, keys)) };
};
