// Ported in behaviour from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.tsx (settle
// and advance, the shelves), apps/web/src/hooks/useThreadActions.ts (settle with undo, what undo
// restores) and apps/web/src/hooks/showThreadUndoNotice.ts (one notice, grouped, 5 seconds) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: every change goes to the brain as a shell
// command through the root's outbox, and is laid over the row at once until the shell shows it; a
// settled open thread advances to the next row. Nothing draws the classic sidebar since the 7A
// cutover: what is left runs the clock, the key bindings, visits and the favicon badge.
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
  DetectPlatform,
  IssueCommands,
  LoadShelves,
  ReadClock,
  MintDraftId,
  NavigateTo,
  SetBadge,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import { findThread, nowOf, visibleOrderOf } from "./Derived.ts";
import { Intent } from "./Intent.ts";
import { Message, OutMessage } from "./Message.ts";
import { initial } from "./Model.ts";
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

/** Starts or extends the undo notice; a Subscription ends it after 5 seconds. */
const showUndo = (model: Model, entry: UndoEntry): Model => {
  const version = Option.match(model.undo, {
    onNone: () => 0,
    onSome: (notice) => notice.version + 1,
  });

  const entries = Option.match(model.undo, {
    onNone: () => [entry],
    onSome: (notice) => [
      ...notice.entries.filter((kept) => kept.threadId !== entry.threadId),
      entry,
    ],
  });

  return modifyFields(model, {
    undo: () => Option.some({ entries, version }),
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

  const withUndo = showUndo(issued.model, {
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

/** Takes back every entry of the undo notice. */
const undo = (model: Model): UpdateReturn =>
  Option.match(model.undo, {
    onNone: () => ({ model }),
    onSome: (notice) => {
      const intents = notice.entries.flatMap((entry): ReadonlyArray<Intent> => [
        Intent.Unsettle({ threadId: entry.threadId }),
        ...onlyIf(entry.wasPinned, Intent.Pin({ threadId: entry.threadId })),
        ...Option.toArray(
          Option.map(entry.snoozedUntil, (until) =>
            Intent.Snooze({ threadId: entry.threadId, until })
          )
        ),
      ]);

      const issued = issue(
        modifyFields(model, { undo: () => Option.none() }),
        intents
      );

      return issued;
    },
  });

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

  const count = Option.match(withPending.context.shell, {
    onNone: () => 0,
    onSome: (shell) =>
      badgeCount(
        shell,
        withPending.context.openThreadId,
        withPending.context.scratchThreadId
      ),
  });

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
    CompletedSetBadge: () => ({ model }),
    CompletedNavigate: () => ({ model }),
    ChangedViewport: ({ isMobile }) => ({
      model: modifyFields(model, {
        isMobile: () => isMobile,
        isSheetOpen: (open) => open && isMobile,
      }),
    }),
    MintedDraftId: ({ draftId }) => ({
      model,
      commands: [NavigateTo({ url: draftRouter({ draftId }) })],
    }),
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
  });

/** The sidebar's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  step(model, message);
