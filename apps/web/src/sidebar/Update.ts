// Ported in behaviour from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.tsx (row
// actions, settle and advance, the shelves, search keys, rename), apps/web/src/hooks/useThreadActions.ts
// (settle and snooze with undo, what undo restores), apps/web/src/hooks/showThreadUndoNotice.ts (one
// notice per action, grouped, 5 seconds) and apps/web/src/hooks/useThreadActionMenu.ts (what each
// menu item does) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: every change goes to the
// brain as a shell command through the root's outbox, and is laid over the row at once until the
// shell shows it; a settled or snoozed open thread advances to the next row; drafts belong to the
// composer, so discarding one is handed to the root.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import {
  isThreadWoke,
  nextThreadAfterLeaving,
  resolveAdjacentThreadId,
} from "@cairn/client-logic/Sidebar";
import {
  effectiveSnoozed,
  threadWokeAt,
} from "@cairn/client-logic/ThreadSettled";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Equal, Option, Predicate } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { draftRouter, threadRouter } from "../Route.ts";
import { badgeCount } from "../shell/Notifications.ts";
import { planVisit } from "../shell/Visited.ts";
import {
  BrowseFolder,
  CopyText,
  DetectPlatform,
  FocusElement,
  IssueCommands,
  LoadShelves,
  ReadClock,
  MintDraftId,
  NavigateTo,
  RetryTask,
  SaveShelves,
  SetBadge,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import {
  findProject,
  findThread,
  nowOf,
  searchResultsOf,
  snoozePresetsOf,
  threadMenuOf,
  visibleOrderOf,
} from "./Derived.ts";
import { Intent } from "./Intent.ts";
import { Message, OutMessage } from "./Message.ts";
import type { Shelf } from "./Message.ts";
import { initial, Listing, MenuTarget } from "./Model.ts";
import type { Model, SidebarContext, UndoEntry } from "./Model.ts";
import { outstandingChanges, PENDING_CHANGE_TTL_MS } from "./Pending.ts";

/** What one sidebar update returns. */
export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  Services
>;

type Commands = Update.Commands<Message, Services>;

/** The selector of the rename field, for focusing it. */
export const RENAME_INPUT_SELECTOR = '[data-testid="sidebar-rename-input"]';

/** The selector of the search field, for focusing it. */
export const SEARCH_INPUT_SELECTOR = 'input[aria-label="Search threads"]';

/** A Model with the Commands that go with it, before any OutMessage. */
interface Issued {
  readonly model: Model;
  readonly commands: Commands;
}

/** Records `intents` over the rows now, and asks for their command ids. */
const issue = (model: Model, intents: ReadonlyArray<Intent>): Issued => {
  if (intents.length === 0) {
    const none: Commands = [];

    return { model, commands: none };
  }

  const at = nowOf(model);

  const changes = intents.map((intent, index) => ({
    id: model.nextPendingId + index,
    intent,
    at,
  }));

  return {
    model: modifyFields(model, {
      pending: (pending) => [...pending, ...changes],
      nextPendingId: (next) => next + changes.length,
    }),
    commands: [IssueCommands({ intents })],
  };
};

const navigateToThread = (threadId: string) =>
  NavigateTo({ url: threadRouter({ threadId }) });

/** When the open thread leaves the visible list, the command that opens the next row. */
const advanceFrom = (
  model: Model,
  threadId: ThreadId,
  orderBefore: ReadonlyArray<string>
): Commands =>
  Option.contains(model.context.openThreadId, threadId)
    ? Option.match(nextThreadAfterLeaving(orderBefore, threadId), {
        onNone: () => [],
        onSome: (next) => [navigateToThread(next)],
      })
    : [];

/** Starts or extends the undo notice for `action`; a Subscription ends it after 5 seconds. */
const showUndo = (
  model: Model,
  action: "Settled" | "Snoozed",
  entry: UndoEntry
): Model => {
  const version = Option.match(model.undo, {
    onNone: () => 0,
    onSome: (notice) => notice.version + 1,
  });

  const entries = Option.match(model.undo, {
    onNone: () => [entry],
    onSome: (notice) =>
      notice.action === action
        ? [
            ...notice.entries.filter(
              (kept) => kept.threadId !== entry.threadId
            ),
            entry,
          ]
        : [entry],
  });

  return modifyFields(model, {
    undo: () => Option.some({ action, entries, version }),
  });
};

const settle = (model: Model, thread: ThreadShell): UpdateReturn => {
  const now = nowOf(model);
  const orderBefore = visibleOrderOf(model);

  // Settling clears a woke indicator the user is now acknowledging.
  const visit = Option.match(threadWokeAt(thread, now), {
    onNone: () => [],
    onSome: (wokeAt) => [Intent.Visit({ threadId: thread.id, at: wokeAt })],
  });

  const issued = issue(model, [
    Intent.Settle({ threadId: thread.id }),
    ...visit,
  ]);

  const withUndo = showUndo(issued.model, "Settled", {
    threadId: thread.id,
    wasPinned: Option.isSome(thread.pinnedAt),
    snoozedUntil: effectiveSnoozed(thread, now)
      ? thread.snoozedUntil
      : Option.none(),
  });

  return {
    model: withUndo,
    commands: [
      ...issued.commands,
      ...advanceFrom(model, thread.id, orderBefore),
    ],
  };
};

const snooze = (
  model: Model,
  thread: ThreadShell,
  until: DateTime.Utc
): UpdateReturn => {
  const orderBefore = visibleOrderOf(model);
  const issued = issue(model, [Intent.Snooze({ threadId: thread.id, until })]);

  const withUndo = showUndo(issued.model, "Snoozed", {
    threadId: thread.id,
    wasPinned: false,
    snoozedUntil: Option.none(),
  });

  return {
    model: withUndo,
    commands: [
      ...issued.commands,
      ...advanceFrom(model, thread.id, orderBefore),
    ],
  };
};

/** Takes back every entry of the undo notice. */
const undo = (model: Model): UpdateReturn =>
  Option.match(model.undo, {
    onNone: () => ({ model }),
    onSome: (notice) => {
      const intents = notice.entries.flatMap((entry): ReadonlyArray<Intent> =>
        notice.action === "Snoozed"
          ? [Intent.Unsnooze({ threadId: entry.threadId })]
          : [
              Intent.Unsettle({ threadId: entry.threadId }),
              ...onlyIf(
                entry.wasPinned,
                Intent.Pin({ threadId: entry.threadId })
              ),
              ...Option.toArray(
                Option.map(entry.snoozedUntil, (until) =>
                  Intent.Snooze({ threadId: entry.threadId, until })
                )
              ),
            ]
      );

      const issued = issue(
        modifyFields(model, { undo: () => Option.none() }),
        intents
      );

      return issued;
    },
  });

const withThread = (
  model: Model,
  threadId: string,
  act: (thread: ThreadShell) => UpdateReturn
): UpdateReturn =>
  Option.match(findThread(model, threadId), {
    onNone: () => ({ model }),
    onSome: act,
  });

const issueFor =
  (model: Model) =>
  (intent: Intent): UpdateReturn =>
    issue(model, [intent]);

const startRename = (model: Model, thread: ThreadShell): UpdateReturn => ({
  model: modifyFields(model, {
    renaming: () => Option.some({ threadId: thread.id, title: thread.title }),
    contextMenu: () => Option.none(),
  }),
  commands: [FocusElement({ selector: RENAME_INPUT_SELECTOR })],
});

const commitRename = (model: Model): UpdateReturn =>
  Option.match(model.renaming, {
    onNone: () => ({ model }),
    onSome: ({ threadId, title }) => {
      const closed = modifyFields(model, { renaming: () => Option.none() });
      const trimmed = title.trim();

      const unchanged = Option.exists(
        findThread(model, threadId),
        (thread) => thread.title === trimmed
      );

      return trimmed.length === 0 || unchanged
        ? { model: closed }
        : issue(closed, [Intent.Rename({ threadId, title: trimmed })]);
    },
  });

const closeMenu = (model: Model): Model =>
  modifyFields(model, { contextMenu: () => Option.none() });

const pathOf = (model: Model, thread: ThreadShell): Option.Option<string> =>
  Option.orElse(thread.worktreePath, () =>
    Option.map(
      findProject(model, thread.projectId),
      (project) => project.workspaceRoot
    )
  );

/** What a chosen thread menu item does. */
const chooseThreadAction = (
  model: Model,
  thread: ThreadShell,
  id: string
): UpdateReturn => {
  const intent = issueFor(model);

  if (id.startsWith("snooze:")) {
    return Option.match(
      Array.findFirst(
        snoozePresetsOf(model),
        (preset) => `snooze:${preset.id}` === id
      ),
      {
        onNone: () => ({ model }),
        onSome: (preset) => snooze(model, thread, preset.snoozedUntil),
      }
    );
  }

  const copy = (text: Option.Option<string>): UpdateReturn =>
    Option.match(text, {
      onNone: () => ({ model }),
      onSome: (value) => ({ model, commands: [CopyText({ text: value })] }),
    });

  switch (id) {
    case "pin": {
      return intent(Intent.Pin({ threadId: thread.id }));
    }

    case "unpin": {
      return intent(Intent.Unpin({ threadId: thread.id }));
    }

    case "settle": {
      return settle(model, thread);
    }

    case "unsettle": {
      return intent(Intent.Unsettle({ threadId: thread.id }));
    }

    case "unsnooze": {
      return intent(Intent.Unsnooze({ threadId: thread.id }));
    }

    case "rename": {
      return startRename(model, thread);
    }

    case "mark-unread": {
      return intent(Intent.MarkUnread({ threadId: thread.id }));
    }

    case "filter-by-project": {
      return {
        model: modifyFields(model, {
          projectFilter: (current) =>
            Option.contains(current, thread.projectId)
              ? Option.none()
              : Option.some(thread.projectId),
        }),
      };
    }

    case "auto-settle:enabled":
    case "auto-settle:disabled": {
      return intent(
        Intent.SetAutoSettle({
          threadId: thread.id,
          enabled: id === "auto-settle:enabled",
        })
      );
    }

    case "copy-path": {
      return copy(pathOf(model, thread));
    }

    case "copy-branch": {
      return copy(thread.branch);
    }

    case "copy-thread-id": {
      return copy(Option.some(thread.id));
    }

    case "archive": {
      return intent(Intent.Archive({ threadId: thread.id }));
    }

    case "delete": {
      return intent(Intent.Delete({ threadId: thread.id }));
    }

    default: {
      return { model };
    }
  }
};

const chooseDraftAction = (
  model: Model,
  draftId: string,
  id: string
): UpdateReturn => {
  if (id === "discard") {
    return {
      model,
      outMessage: OutMessage.RequestedDiscardDraft({ draftId }),
    };
  }

  if (id === "copy-path") {
    const path = Option.flatMap(
      Array.findFirst(
        model.context.drafts,
        (draft) => draft.draftId === draftId
      ),
      (draft) =>
        Option.flatMap(draft.projectId, (projectId) =>
          Option.map(
            findProject(model, projectId),
            (project) => project.workspaceRoot
          )
        )
    );

    return Option.match(path, {
      onNone: () => ({ model }),
      onSome: (text) => ({ model, commands: [CopyText({ text })] }),
    });
  }

  return { model };
};

const toggleShelf = (model: Model, shelf: Shelf): UpdateReturn => {
  const shelves =
    shelf === "snoozed"
      ? modifyFields(model.shelves, { snoozedExpanded: (open) => !open })
      : modifyFields(model.shelves, {
          settledExpanded: (open) => !open,
          settledPages: () => 0,
        });

  return {
    model: modifyFields(model, { shelves: () => shelves }),
    commands: [
      SaveShelves({
        snoozedExpanded: shelves.snoozedExpanded,
        settledExpanded: shelves.settledExpanded,
      }),
    ],
  };
};

const traverse = (model: Model, direction: "previous" | "next"): UpdateReturn =>
  Option.match(
    resolveAdjacentThreadId({
      threadIds: visibleOrderOf(model),
      currentThreadId: Option.map(model.context.openThreadId, String),
      direction,
    }),
    {
      onNone: () => ({ model }),
      onSome: (threadId) => ({ model, commands: [navigateToThread(threadId)] }),
    }
  );

const onOpenThread = (
  model: Model,
  act: (thread: ThreadShell) => UpdateReturn
): UpdateReturn =>
  Option.match(
    Option.flatMap(model.context.openThreadId, (threadId) =>
      findThread(model, threadId)
    ),
    { onNone: () => ({ model }), onSome: act }
  );

const pressShortcut = (model: Model, command: string): UpdateReturn => {
  switch (command) {
    case "sidebar.toggle": {
      return {
        model: model.isMobile
          ? modifyFields(model, { isSheetOpen: (open) => !open })
          : modifyFields(model, { isOpen: (open) => !open }),
      };
    }

    case "chat.new":
    case "chat.newLocal":
    case "chat.newWithoutProject": {
      return { model, commands: [MintDraftId()] };
    }

    case "thread.previous":
    case "thread.next": {
      return traverse(
        model,
        command === "thread.previous" ? "previous" : "next"
      );
    }

    case "thread.settle": {
      return onOpenThread(model, (thread) =>
        Option.contains(thread.settledOverride, "settled")
          ? { model }
          : settle(model, thread)
      );
    }

    case "thread.pin": {
      return onOpenThread(model, (thread) =>
        issue(model, [
          Option.isSome(thread.pinnedAt)
            ? Intent.Unpin({ threadId: thread.id })
            : Intent.Pin({ threadId: thread.id }),
        ])
      );
    }

    case "thread.undo": {
      return undo(model);
    }

    default: {
      return { model };
    }
  }
};

const pressSearchKey = (model: Model, key: string): UpdateReturn => {
  const results = searchResultsOf(model);

  switch (key) {
    case "ArrowDown": {
      return {
        model: modifyFields(model, {
          activeSearchIndex: (index) =>
            results.length === 0 ? 0 : Math.min(index + 1, results.length - 1),
        }),
      };
    }

    case "ArrowUp": {
      return {
        model: modifyFields(model, {
          activeSearchIndex: (index) => Math.max(index - 1, 0),
        }),
      };
    }

    case "Enter": {
      return Option.match(Array.get(results, model.activeSearchIndex), {
        onNone: () => ({ model }),
        onSome: (thread) => ({
          model: modifyFields(model, {
            search: () => "",
            activeSearchIndex: () => 0,
          }),
          commands: [navigateToThread(thread.id)],
        }),
      });
    }

    case "Escape": {
      return {
        model: modifyFields(model, {
          search: () => "",
          activeSearchIndex: () => 0,
        }),
      };
    }

    default: {
      return { model };
    }
  }
};

const browse = (model: Model, path: Option.Option<string>): UpdateReturn => {
  const request = Option.match(model.addProject, {
    onNone: () => 0,
    onSome: (dialog) => dialog.request + 1,
  });

  return {
    model: modifyFields(model, {
      addProject: () =>
        Option.some({
          listing: Listing.Loading({ path }),
          request,
        }),
    }),
    commands: [BrowseFolder({ request, path })],
  };
};

const isCurrentListing = (model: Model, request: number): boolean =>
  Option.exists(model.addProject, (dialog) => dialog.request === request);

/**
 * Brings the derived state in line after the shell, the open thread or the clock moved: drops
 * pending changes the shell now shows, sends a visit for the open thread when one is due, and
 * updates the favicon badge.
 */
const settleDerived = (model: Model): UpdateReturn => {
  const threads = Option.match(model.context.shell, {
    onNone: () => [],
    onSome: (shell) => shell.threads,
  });

  // A change the brain has not shown within the TTL is dropped, and the row shows the brain's state.
  const pending = outstandingChanges(threads, model.pending).filter(
    (change) =>
      model.nowMs - DateTime.toEpochMillis(change.at) < PENDING_CHANGE_TTL_MS
  );

  const withPending =
    pending.length === model.pending.length
      ? model
      : modifyFields(model, { pending: () => pending });

  if (model.nowMs === 0) {
    return { model: withPending };
  }

  const now = nowOf(model);

  // A visit is planned only while live and while none for the open thread is waiting to show:
  // otherwise every tick past the throttle queues another one behind the user's next message.
  const visitWaiting = Option.exists(
    withPending.context.openThreadId,
    (threadId) =>
      pending.some(
        (change) =>
          Predicate.isTagged(change.intent, "Visit") &&
          change.intent.threadId === threadId
      )
  );

  const planned =
    withPending.context.connection === "Live" && !visitWaiting
      ? planVisit(
          withPending.visits,
          Option.flatMap(withPending.context.openThreadId, (threadId) =>
            Array.findFirst(threads, (thread) => thread.id === threadId)
          ),
          now
        )
      : { state: withPending.visits, visit: Option.none() };

  const count = badgeCount(
    threads,
    Option.map(withPending.context.openThreadId, String)
  );

  const visited = modifyFields(withPending, {
    visits: () => planned.state,
    badgeCount: () => count,
  });

  const issued = issue(
    visited,
    Option.toArray(
      Option.map(planned.visit, ({ at, threadId }) =>
        Intent.Visit({ threadId, at })
      )
    )
  );

  return {
    model: issued.model,
    commands: [
      ...issued.commands,
      ...onlyIf(count !== model.badgeCount, SetBadge({ count })),
    ],
  };
};

/** Tells the sidebar the shell, the open page, the connection and the drafts. */
export const inform = (model: Model, context: SidebarContext): UpdateReturn => {
  const routeChanged =
    !Equal.equals(model.context.openThreadId, context.openThreadId) ||
    !Equal.equals(model.context.openDraftId, context.openDraftId);

  const informed = modifyFields(model, {
    context: () => context,
    isSheetOpen: (open) => open && !routeChanged,
  });

  return settleDerived(informed);
};

/** Opens the Add project dialog at the home folder (the hero's Add project). */
export const openAddProject = (model: Model): UpdateReturn =>
  browse(model, Option.none());

/** The sidebar as the page starts: empty, reading this device's saved shelves and platform. */
export const init = (): UpdateReturn => ({
  model: initial,
  commands: [LoadShelves(), DetectPlatform(), ReadClock()],
});

const step = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    Ticked: ({ nowMs }) =>
      settleDerived(modifyFields(model, { nowMs: () => nowMs })),
    DetectedPlatform: ({ isMac }) => ({
      model: modifyFields(model, { isMac: () => isMac }),
    }),
    LoadedShelves: ({ settledExpanded, snoozedExpanded }) => ({
      model: modifyFields(model, {
        shelves: (shelves) =>
          modifyFields(shelves, {
            snoozedExpanded: (current) =>
              Option.getOrElse(snoozedExpanded, () => current),
            settledExpanded: (current) =>
              Option.getOrElse(settledExpanded, () => current),
          }),
      }),
    }),
    CompletedSaveShelves: () => ({ model }),
    CompletedSetBadge: () => ({ model }),
    CompletedNavigate: () => ({ model }),
    CompletedMotion: () => ({ model }),
    CompletedScrollFade: () => ({ model }),
    CompletedPlaceMenu: () => ({ model }),
    CompletedFocus: () => ({ model }),
    IgnoredClick: () => ({ model }),
    ChangedViewport: ({ isMobile }) => ({
      model: modifyFields(model, {
        isMobile: () => isMobile,
        isSheetOpen: (open) => open && isMobile,
      }),
    }),

    ChangedSearch: ({ value }) => ({
      model: modifyFields(model, {
        search: () => value,
        activeSearchIndex: () => 0,
      }),
    }),
    PressedSearchKey: ({ key }) => pressSearchKey(model, key),
    ClickedClearSearch: () => ({
      model: modifyFields(model, {
        search: () => "",
        activeSearchIndex: () => 0,
      }),
      commands: [FocusElement({ selector: SEARCH_INPUT_SELECTOR })],
    }),
    HoveredSearchResult: ({ index }) => ({
      model: modifyFields(model, { activeSearchIndex: () => index }),
    }),
    ChoseSearchResult: ({ threadId }) => ({
      model: modifyFields(model, {
        search: () => "",
        activeSearchIndex: () => 0,
      }),
      commands: [navigateToThread(threadId)],
    }),

    ClickedFilterTrigger: () => ({
      model: modifyFields(model, {
        filterMenu: (menu) =>
          Option.isSome(menu) ? Option.none() : Option.some({ query: "" }),
      }),
    }),
    ChangedFilterQuery: ({ value }) => ({
      model: modifyFields(model, {
        filterMenu: () => Option.some({ query: value }),
      }),
    }),
    ChoseProjectFilter: ({ projectId }) => ({
      model: modifyFields(model, {
        projectFilter: () => projectId,
        filterMenu: () => Option.none(),
        shelves: (shelves) => modifyFields(shelves, { settledPages: () => 0 }),
      }),
    }),
    DismissedFilterMenu: () => ({
      model: modifyFields(model, { filterMenu: () => Option.none() }),
    }),

    ClickedNewThread: () => ({ model, commands: [MintDraftId()] }),
    MintedDraftId: ({ draftId }) => ({
      model,
      commands: [NavigateTo({ url: draftRouter({ draftId }) })],
    }),
    ClickedToggleSheet: () => ({
      model: modifyFields(model, { isSheetOpen: (open) => !open }),
    }),
    ClickedSidebarControl: () => pressShortcut(model, "sidebar.toggle"),
    ClickedRail: () => ({
      model: modifyFields(model, { isOpen: (open) => !open }),
    }),
    ClickedSheetBackdrop: () => ({
      model: modifyFields(model, { isSheetOpen: () => false }),
    }),

    ClickedRow: ({ threadId }) => ({
      model: closeMenu(model),
      commands: [navigateToThread(threadId)],
    }),
    PressedRow: ({ x, y }) => ({
      model: modifyFields(model, { lastPointer: () => ({ x, y }) }),
    }),
    OpenedRowMenu: ({ threadId }) => ({
      model: modifyFields(model, {
        contextMenu: () =>
          Option.some({
            target: MenuTarget.Thread({ threadId }),
            x: model.lastPointer.x,
            y: model.lastPointer.y,
            highlighted: Option.none(),
            childHighlighted: Option.none(),
          }),
      }),
    }),
    DoubleClickedRow: ({ threadId }) =>
      withThread(model, threadId, (thread) => startRename(model, thread)),
    ChangedRenameTitle: ({ value }) => ({
      model: modifyFields(model, {
        renaming: (renaming) =>
          Option.map(renaming, (current) => ({ ...current, title: value })),
      }),
    }),
    PressedRenameKey: ({ key }) =>
      key === "Escape"
        ? { model: modifyFields(model, { renaming: () => Option.none() }) }
        : commitRename(model),
    BlurredRename: () => commitRename(model),

    ClickedSettle: ({ threadId }) =>
      withThread(model, threadId, (thread) => settle(model, thread)),
    ClickedUnsettle: ({ threadId }) =>
      issue(model, [Intent.Unsettle({ threadId })]),
    ClickedUnsnooze: ({ threadId }) =>
      issue(model, [Intent.Unsnooze({ threadId })]),
    ClickedUnpin: ({ threadId }) => issue(model, [Intent.Unpin({ threadId })]),
    ClickedSnoozeButton: ({ threadId }) =>
      withThread(model, threadId, (thread) => ({
        model: modifyFields(model, {
          contextMenu: () =>
            Option.some({
              target: MenuTarget.Thread({ threadId }),
              x: model.lastPointer.x,
              y: model.lastPointer.y,
              // The menu opens with its Snooze item highlighted, so its submenu shows.
              highlighted: Option.liftPredicate(
                threadMenuOf(model, thread).findIndex(
                  (item) => item.id === "snooze"
                ),
                (index) => index >= 0
              ),
              childHighlighted: Option.none(),
            }),
        }),
      })),
    ClickedRetry: ({ taskId, threadId }) => ({
      model,
      commands: [RetryTask({ threadId, taskId })],
    }),
    SucceededRetry: () => ({ model }),
    // A retry that failed says so, as the hold banner's does (T39).
    FailedRetry: ({ message: reason }) => ({
      model,
      outMessage: OutMessage.RequestedNotice({ message: reason }),
    }),
    ClickedDismissWoke: ({ threadId }) =>
      withThread(model, threadId, (thread) =>
        isThreadWoke(thread, nowOf(model))
          ? issue(
              model,
              Option.toArray(
                Option.map(threadWokeAt(thread, nowOf(model)), (at) =>
                  Intent.Visit({ threadId, at })
                )
              )
            )
          : { model }
      ),
    ToggledShelf: ({ shelf }) => toggleShelf(model, shelf),
    ClickedShowMoreSettled: () => ({
      model: modifyFields(model, {
        shelves: (shelves) =>
          modifyFields(shelves, { settledPages: (pages) => pages + 1 }),
      }),
    }),

    ClickedDraft: ({ draftId }) => ({
      model: closeMenu(model),
      commands: [NavigateTo({ url: draftRouter({ draftId }) })],
    }),
    ClickedDiscardDraft: ({ draftId }) => ({
      model,
      outMessage: OutMessage.RequestedDiscardDraft({ draftId }),
    }),
    OpenedDraftMenu: ({ draftId }) => ({
      model: modifyFields(model, {
        contextMenu: () =>
          Option.some({
            target: MenuTarget.Draft({ draftId }),
            x: model.lastPointer.x,
            y: model.lastPointer.y,
            highlighted: Option.none(),
            childHighlighted: Option.none(),
          }),
      }),
    }),

    HoveredMenuItem: ({ index }) => ({
      model: modifyFields(model, {
        contextMenu: (menu) =>
          Option.map(menu, (open) =>
            open.highlighted.pipe(Option.contains(index))
              ? open
              : {
                  ...open,
                  highlighted: Option.some(index),
                  childHighlighted: Option.none(),
                }
          ),
      }),
    }),
    HoveredSubmenuItem: ({ index }) => ({
      model: modifyFields(model, {
        contextMenu: (menu) =>
          Option.map(menu, (open) => ({
            ...open,
            childHighlighted: Option.some(index),
          })),
      }),
    }),
    ChoseMenuItem: ({ id }) =>
      Option.match(model.contextMenu, {
        onNone: () => ({ model }),
        onSome: (menu) =>
          MenuTarget.match(menu.target, {
            Thread: ({ threadId }) =>
              withThread(closeMenu(model), threadId, (thread) =>
                chooseThreadAction(closeMenu(model), thread, id)
              ),
            Draft: ({ draftId }) =>
              chooseDraftAction(closeMenu(model), draftId, id),
          }),
      }),
    DismissedMenu: () => ({ model: closeMenu(model) }),
    CompletedCopy: () => ({ model }),

    ClickedUndo: () => undo(model),
    ExpiredUndo: ({ version }) => ({
      model: modifyFields(model, {
        undo: (notice) =>
          Option.filter(notice, (current) => current.version !== version),
      }),
    }),
    IssuedCommands: ({ commands }) => ({
      model,
      outMessage: OutMessage.RequestedDispatch({ commands }),
    }),

    PressedShortcut: ({ command }) => pressShortcut(model, command),

    ClickedAddProject: () => browse(model, Option.none()),
    ReceivedListing: ({ request, result }) => ({
      model: isCurrentListing(model, request)
        ? modifyFields(model, {
            addProject: (dialog) =>
              Option.map(dialog, (open) => ({
                ...open,
                listing: Listing.Loaded({ result }),
              })),
          })
        : model,
    }),
    FailedListing: ({ message: reason, request }) => ({
      model: isCurrentListing(model, request)
        ? modifyFields(model, {
            addProject: (dialog) =>
              Option.map(dialog, (open) => ({
                ...open,
                listing: Listing.Failed({ message: reason }),
              })),
          })
        : model,
    }),
    ClickedFolder: ({ path }) => browse(model, Option.some(path)),
    ClickedAddFolder: ({ path }) =>
      issue(modifyFields(model, { addProject: () => Option.none() }), [
        Intent.AddProject({ workspaceRoot: path }),
      ]),
    DismissedAddProject: () => ({
      model: modifyFields(model, { addProject: () => Option.none() }),
    }),
  });

/** The sidebar's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  step(model, message);
