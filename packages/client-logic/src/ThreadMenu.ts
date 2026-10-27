// Ported from github.com/pingdotgg/t3code, apps/web/src/components/threadActionMenu.logic.ts and the
// `ContextMenuItem` shape in packages/contracts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept:
// the row and draft menus, their order, labels, icons, separators, the snooze presets submenu, the
// auto-settle radio submenu and archive disabled while running. Trimmed from `ThreadActionMenuId`:
// "new-thread-on-branch" (a draft has no branch parameter in Phase 1), "project-settings" (no
// project settings page yet), "regenerate-title" (no shell command), "snooze:custom" (the custom
// snooze dialog is not ported) and the read-only `canOperate` gating (Cairn has one owner, who
// may always operate). Optional fields are explicit (`Option`, booleans), not absent keys.
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

import { Option } from "effect";

import { onlyIf } from "./OnlyIf.ts";
import type { SnoozePreset, SnoozePresetId } from "./ThreadSettled.ts";

/** Every action a thread row's context menu can carry. */
export type ThreadActionMenuId =
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${SnoozePresetId}`
  | "unsnooze"
  | "rename"
  | "mark-unread"
  | "filter-by-project"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

/** The ids a thread menu can carry, in menu order, for judges and tests. */
export const THREAD_ACTION_MENU_IDS: ReadonlyArray<ThreadActionMenuId> = [
  "pin",
  "unpin",
  "settle",
  "unsettle",
  "snooze",
  "snooze:hour",
  "snooze:three-hours",
  "snooze:evening",
  "snooze:tomorrow",
  "snooze:next-week",
  "unsnooze",
  "rename",
  "mark-unread",
  "filter-by-project",
  "auto-settle",
  "auto-settle:enabled",
  "auto-settle:disabled",
  "copy",
  "copy-path",
  "copy-branch",
  "copy-thread-id",
  "archive",
  "delete",
];

/** Every action an unsent draft row's context menu can carry. */
export type DraftActionMenuId = "copy" | "copy-path" | "discard";

/** The lucide icon an item shows, by name. */
export type ContextMenuIcon =
  | "archive"
  | "circle-check"
  | "clock"
  | "copy"
  | "folder"
  | "folder-tree"
  | "git-branch"
  | "hash"
  | "mail-open"
  | "pencil"
  | "pin"
  | "pin-off"
  | "timer"
  | "trash";

/** One item of a context menu; an item with children opens a submenu. */
export interface ContextMenuItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon: Option.Option<ContextMenuIcon>;
  readonly disabled: boolean;
  readonly destructive: boolean;
  /** A separator line above the item. */
  readonly separatorBefore: boolean;
  /** For a radio choice: whether it is the current one. */
  readonly checked: Option.Option<boolean>;
  readonly children: ReadonlyArray<ContextMenuItem<Id>>;
}

const item = <Id extends string>(
  id: Id,
  label: string,
  options: Partial<Omit<ContextMenuItem<Id>, "id" | "label">> = {}
): ContextMenuItem<Id> => ({
  id,
  label,
  icon: Option.none(),
  disabled: false,
  destructive: false,
  separatorBefore: false,
  checked: Option.none(),
  children: [],
  ...options,
});

/** What the thread menu needs to know about its row. */
export interface ThreadActionMenuState {
  readonly hasBranch: boolean;
  /** The project filter entry: none on surfaces with no scoped list. */
  readonly projectFilter: Option.Option<{
    readonly label: string;
    readonly isActive: boolean;
  }>;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  /** Archive is refused while a run is active, so it is disabled here rather than failing. */
  readonly isRunning: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/** A thread row's context menu. */
export const buildThreadActionMenuItems = (
  state: ThreadActionMenuState
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> => [
  state.isPinned
    ? item("unpin", "Unpin thread", { icon: Option.some("pin-off") })
    : item("pin", "Pin thread", { icon: Option.some("pin") }),
  state.isSettled
    ? item("unsettle", "Un-settle thread", {
        icon: Option.some("circle-check"),
      })
    : item("settle", "Settle thread", { icon: Option.some("circle-check") }),
  state.isSnoozed
    ? item("unsnooze", "Wake thread", { icon: Option.some("clock") })
    : item("snooze", "Snooze", {
        icon: Option.some("clock"),
        disabled: !state.canSnoozeNow,
        children: state.snoozePresets.map((preset) =>
          item<ThreadActionMenuId>(
            `snooze:${preset.id}`,
            `${preset.label} (${preset.whenLabel})`
          )
        ),
      }),
  item("rename", "Rename thread", {
    icon: Option.some("pencil"),
    separatorBefore: true,
  }),
  item("mark-unread", "Mark unread", { icon: Option.some("mail-open") }),
  ...Option.toArray(
    Option.map(state.projectFilter, (filter) =>
      item<ThreadActionMenuId>(
        "filter-by-project",
        filter.isActive ? "Show all projects" : `Filter by ${filter.label}`,
        { icon: Option.some("folder-tree") }
      )
    )
  ),
  item("auto-settle", "Auto-settle behavior", {
    icon: Option.some("timer"),
    children: [
      item<ThreadActionMenuId>("auto-settle:enabled", "Enabled", {
        checked: Option.some(state.autoSettleEnabled),
      }),
      item<ThreadActionMenuId>("auto-settle:disabled", "Disabled", {
        checked: Option.some(!state.autoSettleEnabled),
      }),
    ],
  }),
  item("copy", "Copy", {
    icon: Option.some("copy"),
    separatorBefore: true,
    children: [
      item<ThreadActionMenuId>("copy-path", "Path", {
        icon: Option.some("folder"),
      }),
      ...onlyIf(
        state.hasBranch,
        item<ThreadActionMenuId>("copy-branch", "Branch", {
          icon: Option.some("git-branch"),
        })
      ),
      item<ThreadActionMenuId>("copy-thread-id", "Thread ID", {
        icon: Option.some("hash"),
      }),
    ],
  }),
  item("archive", "Archive thread", {
    icon: Option.some("archive"),
    disabled: state.isRunning,
    separatorBefore: true,
  }),
  item("delete", "Delete", { icon: Option.some("trash"), destructive: true }),
];

/** An unsent draft row's context menu. */
export const buildDraftActionMenuItems = (options: {
  readonly hasPath: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> => [
  item("copy", "Copy", {
    icon: Option.some("copy"),
    disabled: !options.hasPath,
    children: options.hasPath
      ? [
          item<DraftActionMenuId>("copy-path", "Path", {
            icon: Option.some("folder"),
          }),
        ]
      : [],
  }),
  item("discard", "Discard draft", {
    icon: Option.some("trash"),
    destructive: true,
    separatorBefore: true,
  }),
];

/** Every id in a menu, submenus included, depth first. */
export const allMenuIds = <Id extends string>(
  items: ReadonlyArray<ContextMenuItem<Id>>
): Array<Id> =>
  items.flatMap((entry) => [entry.id, ...allMenuIds(entry.children)]);
