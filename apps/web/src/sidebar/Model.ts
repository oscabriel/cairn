// The sidebar's state, which the app still runs for its clock, key bindings, visits and favicon badge
// (nothing draws the classic sidebar since the 7A cutover): what the root told it last (the shell,
// the open page, the connection), which shelves are open (the order the thread shortcuts walk), the
// undo notice and the changes the brain has not shown back.

import { ThreadId } from "@cairn/protocol/Ids";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { Option, Schema } from "effect";

import type { ConnectionState } from "../connection/Reconnect.ts";
import { VisitState } from "../shell/Visited.ts";
import { PendingChange } from "./Pending.ts";

/** The connection's state tags, as `ConnectionState` names them. */
export const ConnectionTag = Schema.Literals([
  "Connecting",
  "Syncing",
  "Live",
  "Backoff",
] satisfies ReadonlyArray<ConnectionState["_tag"]>);

export type ConnectionTag = typeof ConnectionTag.Type;

/** What the root tells the sidebar after every change. */
export const SidebarContext = Schema.Struct({
  shell: Schema.Option(ShellSnapshot),
  /** The thread the route names, when it names one. */
  openThreadId: Schema.Option(ThreadId),
  /** The draft the route names, when it names one. */
  openDraftId: Schema.Option(Schema.String),
  /** The scratch thread the next shell's overlay holds on this device, for the favicon badge. */
  scratchThreadId: Schema.Option(ThreadId),
  /** The connection's state tag. */
  connection: ConnectionTag,
});

export type SidebarContext = typeof SidebarContext.Type;

/** Which shelves are open and how many settled pages are shown. Open state is saved per device. */
export const Shelves = Schema.Struct({
  snoozedExpanded: Schema.Boolean,
  settledExpanded: Schema.Boolean,
  settledPages: Schema.Int,
});

export type Shelves = typeof Shelves.Type;

/** The settle the undo notice can take back, and what undoing it restores. */
export const UndoEntry = Schema.Struct({
  threadId: ThreadId,
  wasPinned: Schema.Boolean,
  snoozedUntil: Schema.Option(Schema.DateTimeUtc),
});

export type UndoEntry = typeof UndoEntry.Type;

/** The undo notice, for 5 seconds after a settle. */
export const UndoNotice = Schema.Struct({
  entries: Schema.Array(UndoEntry),
  /** Bumped with every new notice, so an older expiry timer leaves a newer notice alone. */
  version: Schema.Int,
});

export type UndoNotice = typeof UndoNotice.Type;

/** The sidebar's Model. */
export const Model = Schema.Struct({
  context: SidebarContext,
  /** The time the labels are computed at, in epoch milliseconds, from the clock Subscription. */
  nowMs: Schema.Finite,
  isMac: Schema.Boolean,
  /** True below the `md` breakpoint, where the sidebar is a sheet. */
  isMobile: Schema.Boolean,
  /** The desktop sidebar is shown (`mod+b` hides it). */
  isOpen: Schema.Boolean,
  /** The phone's sidebar sheet is open. */
  isSheetOpen: Schema.Boolean,
  shelves: Shelves,
  pending: Schema.Array(PendingChange),
  nextPendingId: Schema.Int,
  undo: Schema.Option(UndoNotice),
  visits: VisitState,
  badgeCount: Schema.Int,
});

export type Model = typeof Model.Type;

/** The context before the root has told the sidebar anything. */
export const emptyContext: SidebarContext = {
  shell: Option.none(),
  openThreadId: Option.none(),
  openDraftId: Option.none(),
  scratchThreadId: Option.none(),
  connection: "Connecting",
};

/** A sidebar with nothing in it yet. */
export const initial: Model = {
  context: emptyContext,
  nowMs: 0,
  isMac: false,
  isMobile: false,
  isOpen: true,
  isSheetOpen: false,
  shelves: { snoozedExpanded: false, settledExpanded: false, settledPages: 0 },
  pending: [],
  nextPendingId: 0,
  undo: Option.none(),
  visits: Option.none(),
  badgeCount: 0,
};
