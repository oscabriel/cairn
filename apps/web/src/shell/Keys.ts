// The shell's keyboard (U-11, ADR 0050). The key binding table (`@cairn/client-logic/Keybindings`)
// holds only what the shell answers: New thread, and Previous and Next thread, which walk the rows
// the sidebar list draws in the order it draws them (the project thread, the managed threads it
// shows, the resting ones while their fold is open, the earlier project threads while theirs is),
// each opening its row as a click would (`Update.ts`). The scratch thread's Cmd+J or Ctrl+J and
// Escape are the shell's own (`Subscription.ts`; an open overlay is a dialog that takes its Escape,
// `ui/Sheet.ts`). The settings page's Keyboard section lists every
// one of them from here, so no key acts unlisted.

import {
  formatShortcutLabel,
  KEYBINDINGS,
  shortcutsFor,
  toFoldkitKeys,
} from "@cairn/client-logic/Keybindings";
import type { KeybindingCommand } from "@cairn/client-logic/Keybindings";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import type { KeyBinding } from "foldkit/dom";

import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { sidebarContentOf } from "./View.ts";

/** The table as Foldkit binds it; every binding fires while the user types. */
export const keyBindings: ReadonlyArray<KeyBinding<Message>> = KEYBINDINGS.map(
  (binding) => ({
    keys: toFoldkitKeys(binding.shortcut),
    whileTyping: "Allow",
    mapEvent: () => Message.PressedShortcut({ command: binding.command }),
  })
);

/**
 * A row the sidebar list draws: its thread, and the earlier project thread it opens read only when
 * it is a row of the "Previous" fold.
 */
export interface DrawnRow {
  readonly threadId: ThreadId;
  readonly earlier: Option.Option<ThreadShell>;
}

const toThread = (threadId: ThreadId): DrawnRow => ({
  threadId,
  earlier: Option.none(),
});

/** The rows the sidebar list draws for the selected project, top to bottom. */
export const drawnRowsOf = (model: Model): ReadonlyArray<DrawnRow> => {
  const content = sidebarContentOf(model);
  const { managed } = content;

  return [
    ...Option.toArray(
      Option.map(content.projectThread, (top) => toThread(top.thread.id))
    ),
    ...managed.live.visibleRows.map((row) => toThread(row.thread.id)),
    ...(managed.isRestingOpen ? managed.resting.visibleRows : []).map((row) =>
      toThread(row.thread.id)
    ),
    ...Option.toArray(managed.openResting).map((row) =>
      toThread(row.thread.id)
    ),
    ...Option.match(content.previous, {
      onNone: () => [],
      onSome: (previous) =>
        previous.isOpen
          ? previous.rows.map((row) => ({
              threadId: row.thread.id,
              earlier: Option.some(row.thread),
            }))
          : [],
    }),
  ];
};

/** One line of the settings page's Keyboard section. */
export interface KeyboardRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Each chord that does it, as the platform prints it. */
  readonly keys: ReadonlyArray<string>;
}

const labelsFor = (
  command: KeybindingCommand,
  isMac: boolean
): ReadonlyArray<string> =>
  shortcutsFor(command).map((shortcut) => formatShortcutLabel(shortcut, isMac));

/** Every key the shell answers, for the settings page. */
export const keyboardRowsOf = (isMac: boolean): ReadonlyArray<KeyboardRow> => [
  {
    id: "new-thread",
    title: "New thread",
    description:
      "Opens the project thread of the project you are in, or a new thread where it has none.",
    keys: labelsFor("chat.new", isMac),
  },
  {
    id: "previous-thread",
    title: "Previous thread",
    description: "Opens the row above the open thread in the sidebar.",
    keys: labelsFor("thread.previous", isMac),
  },
  {
    id: "next-thread",
    title: "Next thread",
    description: "Opens the row below the open thread in the sidebar.",
    keys: labelsFor("thread.next", isMac),
  },
  {
    id: "scratch",
    title: "Scratch thread",
    description: "Shows or hides the scratch thread, even while you type.",
    keys: [isMac ? "⌘J" : "Ctrl+J"],
  },
  {
    id: "close",
    title: "Close",
    description:
      "Closes the open dialog, menu, add-project picker, panel sheet or scratch thread.",
    keys: ["Esc"],
  },
];
