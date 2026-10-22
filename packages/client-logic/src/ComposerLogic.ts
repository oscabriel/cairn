// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/composer-logic.ts (composerRequiresModifier, composerSubmissionIntentForKey,
// isPathSuggestionCurrent, pastedPathQueryLength), packages/client-runtime/src/state/
// composerDispatch.ts (resolveComposerDispatchMode, alternateComposerDispatchAction),
// apps/web/src/components/chat/composerMenuHighlight.ts (resolveComposerMenuActiveItemId) and the
// key half of composerFocusRedirect.ts (shouldTypeToFocusComposer). Kept: the send shortcut
// preference, the Enter rules (IME, key repeat, the open soft keyboard), the alternate send while a
// run is busy, the background send from a draft, and which suggestion stays highlighted. Changed:
// t3code resolves these keys through its keybinding compiler; Cairn has no remappable composer
// keys yet, so its default bindings (mod+Enter, mod+alt+Enter, mod+shift+Enter) are written out
// here. The `restart` dispatch mode, environments and nullable results are gone (`Option` instead).
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
import { Array, Option, Schema } from "effect";

import { detectComposerTrigger } from "./ComposerTrigger.ts";
import type { ComposerTrigger } from "./ComposerTrigger.ts";

/** Which key sends: Enter, mod+Enter only for multi-line drafts, or always mod+Enter. */
export const SendShortcut = Schema.Literals([
  "enter",
  "mod-enter-multiline",
  "mod-enter",
]);

export type SendShortcut = typeof SendShortcut.Type;

/** What a send does while a run is busy: wait for it (queue) or reach it now (steer). */
export const FollowUpBehavior = Schema.Literals(["queue", "steer"]);

export type FollowUpBehavior = typeof FollowUpBehavior.Type;

/**
 * What a send key asks for: an ordinary send, the alternate follow-up while a run is busy, or a
 * launch that leaves the user on a fresh draft.
 */
export type ComposerSubmissionIntent =
  | "foreground"
  | "alternate"
  | "background";

/** How a send reaches the thread: a new run when idle, else queued or steered into the busy run. */
export type ComposerDispatchMode = "auto" | FollowUpBehavior;

/** True when the send shortcut asks for mod+Enter for this draft. */
export const composerRequiresModifier = (
  sendShortcut: SendShortcut,
  prompt: string
): boolean =>
  sendShortcut === "mod-enter" ||
  (sendShortcut === "mod-enter-multiline" && /[\r\n]/u.test(prompt));

/** A keydown as the composer reads it. */
export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  /** True while an IME composes, or for the 229 keydown some browsers send for it. */
  readonly isComposing: boolean;
  readonly repeat: boolean;
}

/** Where the composer is when the key is pressed. */
export interface ComposerKeyContext {
  /** Command on macOS, Control elsewhere. */
  readonly isMac: boolean;
  readonly isSoftwareKeyboardOpen: boolean;
  /** The composer belongs to a thread not launched yet. */
  readonly isDraftThread: boolean;
  /** The thread has a run in progress. */
  readonly isRunning: boolean;
  readonly sendShortcut: SendShortcut;
  readonly prompt: string;
}

const hasMod = (event: ComposerKeyEvent, isMac: boolean): boolean =>
  isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/** The default composer bindings, in t3code's order: the last match wins. */
const boundCommand = (
  event: ComposerKeyEvent,
  context: ComposerKeyContext,
  requiresModifier: boolean
): Option.Option<"alternate" | "background" | "steerQueued"> => {
  if (event.key !== "Enter" || !hasMod(event, context.isMac)) {
    return Option.none();
  }

  const shortcut = {
    shift: event.shiftKey,
    alt: event.altKey,
  };

  // mod+shift+Enter steers a queued message; with a modifier-only send it is the alternate send.
  const alternateNeedsShift = requiresModifier;

  const matches: ReadonlyArray<
    Option.Option<"alternate" | "background" | "steerQueued">
  > = [
    shortcut.shift && !shortcut.alt
      ? Option.some("steerQueued")
      : Option.none(),
    context.isRunning && !shortcut.alt && shortcut.shift === alternateNeedsShift
      ? Option.some("alternate")
      : Option.none(),
    context.isDraftThread && !shortcut.shift
      ? Option.some("background")
      : Option.none(),
    !context.isDraftThread && shortcut.alt && !shortcut.shift
      ? Option.some("background")
      : Option.none(),
  ];

  return Option.flatten(Array.findLast(matches, Option.isSome));
};

/**
 * What a keydown in the composer asks for, or none when it should type as usual. IME composition,
 * key repeat and a plain Enter with the soft keyboard open never send.
 */
export const composerSubmissionIntentForKey = (
  event: ComposerKeyEvent,
  context: ComposerKeyContext
): Option.Option<ComposerSubmissionIntent> => {
  if (event.isComposing || event.repeat) {
    return Option.none();
  }

  if (
    context.isSoftwareKeyboardOpen &&
    event.key === "Enter" &&
    !event.metaKey &&
    !event.ctrlKey
  ) {
    return Option.none();
  }

  const requiresModifier = composerRequiresModifier(
    context.sendShortcut,
    context.prompt
  );

  const command = boundCommand(event, context, requiresModifier);

  if (Option.isSome(command)) {
    if (command.value === "alternate") {
      return Option.some("alternate");
    }

    if (command.value === "background") {
      return Option.some("background");
    }

    return Option.none();
  }

  if (event.key !== "Enter" || event.shiftKey || event.altKey) {
    return Option.none();
  }

  if (requiresModifier && !event.metaKey && !event.ctrlKey) {
    return Option.none();
  }

  return Option.some("foreground");
};

/** How a send reaches the thread, from whether a run is busy and the user's follow-up setting. */
export const resolveComposerDispatchMode = (
  running: boolean,
  alternate: boolean,
  followUp: FollowUpBehavior
): ComposerDispatchMode => {
  if (!running) {
    return "auto";
  }

  if (!alternate) {
    return followUp;
  }

  return followUp === "queue" ? "steer" : "queue";
};

/** The follow-up the alternate send (mod+Enter or mod+click) gives, for its label. */
export const alternateFollowUp = (
  followUp: FollowUpBehavior
): FollowUpBehavior => (followUp === "queue" ? "steer" : "queue");

/** The file search a suggestion list was loaded for. */
export interface PathSearchTarget {
  readonly projectId: string;
  readonly query: string;
}

/** True when the visible file suggestions still answer the trigger under the caret. */
export const isPathSuggestionCurrent = (
  searched: PathSearchTarget,
  trigger: Option.Option<ComposerTrigger>,
  projectId: string
): boolean =>
  Option.exists(
    trigger,
    (current) =>
      current.kind === "path" &&
      searched.projectId === projectId &&
      searched.query === current.query.trim()
  );

/**
 * How much of a paste continues an `@` query: the first word, when the text before the caret ends
 * in a file search.
 */
export const pastedPathQueryLength = (
  lineBefore: string,
  pasted: string
): number => {
  const trigger = detectComposerTrigger(lineBefore, lineBefore.length);

  if (!Option.exists(trigger, ({ kind }) => kind === "path")) {
    return 0;
  }

  return /^\S*/u.exec(pasted)?.[0].length ?? 0;
};

/**
 * The suggestion to highlight: the one the user moved to, while the query it was picked under is
 * still the query and it is still listed; else the first.
 */
export const resolveComposerMenuActiveItemId = (
  itemIds: ReadonlyArray<string>,
  highlighted: Option.Option<string>,
  currentSearchKey: string,
  highlightedSearchKey: Option.Option<string>
): Option.Option<string> => {
  const keep = Option.filter(
    highlighted,
    (id) =>
      Option.contains(highlightedSearchKey, currentSearchKey) &&
      itemIds.includes(id)
  );

  return Option.isSome(keep) ? keep : Array.head(itemIds);
};

/** A keydown that should start typing into the composer when focus is elsewhere. */
export const isTypeToFocusKey = (event: ComposerKeyEvent): boolean =>
  !event.isComposing &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  event.key.length === 1;
