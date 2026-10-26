// The sidebar's Messages, and the OutMessages it hands the root: commands for the outbox, and a draft
// the user discarded (the composer owns drafts).

import { ProjectId, TaskId, ThreadId } from "@cairn/protocol/Ids";
import { BrowseResult } from "@cairn/protocol/Projects";
import { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

/** A shelf that can be opened and closed. */
export const Shelf = Schema.Literals(["snoozed", "settled"]);

export type Shelf = typeof Shelf.Type;

/** Everything the sidebar reacts to. */
export const Message = defineMessageUnion({
  /** The clock Subscription's tick. */
  Ticked: { nowMs: Schema.Finite },
  DetectedPlatform: { isMac: Schema.Boolean },
  LoadedShelves: {
    snoozedExpanded: Schema.Option(Schema.Boolean),
    settledExpanded: Schema.Option(Schema.Boolean),
  },
  CompletedSaveShelves: {},
  CompletedSetBadge: {},
  CompletedNavigate: {},
  CompletedMotion: {},
  CompletedScrollFade: {},
  CompletedPlaceMenu: {},
  CompletedFocus: {},
  /** A click inside a control that must not reach the row under it (the rename field). */
  IgnoredClick: {},
  /** The viewport crossed the `md` breakpoint. */
  ChangedViewport: { isMobile: Schema.Boolean },

  ChangedSearch: { value: Schema.String },
  /** A navigation key in the search field: ArrowDown, ArrowUp, Enter or Escape. */
  PressedSearchKey: { key: Schema.String },
  ClickedClearSearch: {},
  HoveredSearchResult: { index: Schema.Int },
  ChoseSearchResult: { threadId: ThreadId },

  ClickedFilterTrigger: {},
  ChangedFilterQuery: { value: Schema.String },
  ChoseProjectFilter: { projectId: Schema.Option(ProjectId) },
  DismissedFilterMenu: {},

  ClickedNewThread: {},
  /** A new draft id was minted for "New thread". */
  MintedDraftId: { draftId: Schema.String },
  ClickedToggleSheet: {},
  /** The sidebar control at the top left: the sheet on a phone, the column on a desktop. */
  ClickedSidebarControl: {},
  /** A click on the column's edge rail, which collapses or restores the column. */
  ClickedRail: {},
  ClickedSheetBackdrop: {},

  ClickedRow: { threadId: ThreadId },
  /** The pointer went down on a row, where a context menu would open. */
  PressedRow: { x: Schema.Finite, y: Schema.Finite },
  OpenedRowMenu: { threadId: ThreadId },
  DoubleClickedRow: { threadId: ThreadId },
  ChangedRenameTitle: { value: Schema.String },
  /** Enter or Escape in the rename field. */
  PressedRenameKey: { key: Schema.String },
  BlurredRename: {},

  ClickedSettle: { threadId: ThreadId },
  ClickedUnsettle: { threadId: ThreadId },
  ClickedUnsnooze: { threadId: ThreadId },
  ClickedUnpin: { threadId: ThreadId },
  ClickedSnoozeButton: { threadId: ThreadId },
  ClickedRetry: { threadId: ThreadId, taskId: TaskId },
  SucceededRetry: {},
  FailedRetry: { message: Schema.String },
  ClickedDismissWoke: { threadId: ThreadId },
  ToggledShelf: { shelf: Shelf },
  ClickedShowMoreSettled: {},

  ClickedDraft: { draftId: Schema.String },
  ClickedDiscardDraft: { draftId: Schema.String },
  OpenedDraftMenu: { draftId: Schema.String },

  HoveredMenuItem: { index: Schema.Int },
  HoveredSubmenuItem: { index: Schema.Int },
  /** A leaf menu item was chosen, by its action id. */
  ChoseMenuItem: { id: Schema.String },
  DismissedMenu: {},
  CompletedCopy: { succeeded: Schema.Boolean },

  ClickedUndo: {},
  ExpiredUndo: { version: Schema.Int },
  /** The command ids for these intents were minted; they go to the outbox. */
  IssuedCommands: { commands: Schema.Array(ShellCommand) },

  /** A shortcut from the key bindings fired, by command name. */
  PressedShortcut: { command: Schema.String },

  ClickedAddProject: {},
  ReceivedListing: { request: Schema.Int, result: BrowseResult },
  FailedListing: { request: Schema.Int, message: Schema.String },
  ClickedFolder: { path: Schema.String },
  ClickedAddFolder: { path: Schema.String },
  DismissedAddProject: {},
});

export type Message = typeof Message.Type;

/** What the sidebar asks of the root. */
export const OutMessage = defineMessageUnion({
  /** Send these shell commands through the outbox, in order. */
  RequestedDispatch: { commands: Schema.Array(ShellCommand) },
  /** The user discarded this unsent draft. */
  RequestedDiscardDraft: { draftId: Schema.String },
  /** Something the user asked for failed; the root's notice bar says why. */
  RequestedNotice: { message: Schema.String },
});

export type OutMessage = typeof OutMessage.Type;
