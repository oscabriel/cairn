// The sidebar's state: what the root told it last (the shell, the open page, the connection), the
// user's view of the list (search, project filter, which shelves are open), the transient UI (rename,
// context menu, add-project dialog, the undo notice) and the changes the brain has not shown back.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BrowseResult } from "@cairn/protocol/Projects";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import type { ConnectionState } from "../connection/Reconnect.ts";
import { VisitState } from "../shell/Visited.ts";
import { PendingChange } from "./Pending.ts";

/** An unsent draft the composer keeps, as its row shows it. */
export const DraftSummary = Schema.Struct({
  draftId: Schema.String,
  projectId: Schema.Option(ProjectId),
  /** The first line of the draft, or "2 attachments". */
  preview: Schema.String,
});

export type DraftSummary = typeof DraftSummary.Type;

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
  /** The connection's state tag. */
  connection: ConnectionTag,
  drafts: Schema.Array(DraftSummary),
});

export type SidebarContext = typeof SidebarContext.Type;

/** Which shelves are open and how many settled pages are shown. Open state is saved per device. */
export const Shelves = Schema.Struct({
  snoozedExpanded: Schema.Boolean,
  settledExpanded: Schema.Boolean,
  settledPages: Schema.Int,
});

export type Shelves = typeof Shelves.Type;

/** What a context menu belongs to. */
export const MenuTarget = defineTaggedUnion({
  Thread: { threadId: ThreadId },
  Draft: { draftId: Schema.String },
});

export type MenuTarget = typeof MenuTarget.Type;

/** An open context menu: where it opened and which submenu is open. */
export const ContextMenu = Schema.Struct({
  target: MenuTarget,
  x: Schema.Finite,
  y: Schema.Finite,
  /** The highlighted top-level item; its submenu is open when it has one. */
  highlighted: Schema.Option(Schema.Int),
  /** The highlighted item of the open submenu. */
  childHighlighted: Schema.Option(Schema.Int),
});

export type ContextMenu = typeof ContextMenu.Type;

/** The settle or snooze the undo notice can take back, and what undoing it restores. */
export const UndoEntry = Schema.Struct({
  threadId: ThreadId,
  wasPinned: Schema.Boolean,
  snoozedUntil: Schema.Option(Schema.DateTimeUtc),
});

export type UndoEntry = typeof UndoEntry.Type;

/** The notice under the list for 5 seconds after a settle or snooze. */
export const UndoNotice = Schema.Struct({
  action: Schema.Literals(["Settled", "Snoozed"]),
  entries: Schema.Array(UndoEntry),
  /** Bumped with every new notice, so an older expiry timer leaves a newer notice alone. */
  version: Schema.Int,
});

export type UndoNotice = typeof UndoNotice.Type;

/** The add-project dialog's listing. */
export const Listing = defineTaggedUnion({
  Loading: { path: Schema.Option(Schema.String) },
  Loaded: { result: BrowseResult },
  Failed: { message: Schema.String },
});

export type Listing = typeof Listing.Type;

/** The open add-project dialog. */
export const AddProjectDialog = Schema.Struct({
  listing: Listing,
  /** Bumped per request, so a slow answer for a folder the user left is dropped. */
  request: Schema.Int,
});

export type AddProjectDialog = typeof AddProjectDialog.Type;

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
  search: Schema.String,
  activeSearchIndex: Schema.Int,
  projectFilter: Schema.Option(ProjectId),
  /** The project filter popup, with what was typed into it. */
  filterMenu: Schema.Option(Schema.Struct({ query: Schema.String })),
  shelves: Shelves,
  renaming: Schema.Option(
    Schema.Struct({ threadId: ThreadId, title: Schema.String })
  ),
  contextMenu: Schema.Option(ContextMenu),
  /** Where the pointer last went down on a row; a context menu opens there. */
  lastPointer: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  pending: Schema.Array(PendingChange),
  nextPendingId: Schema.Int,
  undo: Schema.Option(UndoNotice),
  addProject: Schema.Option(AddProjectDialog),
  visits: VisitState,
  badgeCount: Schema.Int,
});

export type Model = typeof Model.Type;

/** The context before the root has told the sidebar anything. */
export const emptyContext: SidebarContext = {
  shell: Option.none(),
  openThreadId: Option.none(),
  openDraftId: Option.none(),
  connection: "Connecting",
  drafts: [],
};

/** A sidebar with nothing in it yet. */
export const initial: Model = {
  context: emptyContext,
  nowMs: 0,
  isMac: false,
  isMobile: false,
  isOpen: true,
  isSheetOpen: false,
  search: "",
  activeSearchIndex: 0,
  projectFilter: Option.none(),
  filterMenu: Option.none(),
  shelves: { snoozedExpanded: false, settledExpanded: false, settledPages: 0 },
  renaming: Option.none(),
  contextMenu: Option.none(),
  lastPointer: { x: 0, y: 0 },
  pending: [],
  nextPendingId: 0,
  undo: Option.none(),
  addProject: Option.none(),
  visits: Option.none(),
  badgeCount: 0,
};
