// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/MessagesTimeline.logic.ts
// (`deriveTurnFolds`, `deriveTerminalAssistantMessageIds`, `computeMessageDurationStart`) and
// packages/shared/src/orchestrationTiming.ts (`formatDuration`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a settled turn's intermediate messages and work
// fold behind one row anchored right under its prompt, labelled "Worked for <duration>"; the
// terminal answer stays visible; trailing settled work after it folds too, failures and running
// work never do; a turn that is still working, failed, or streaming never folds; the duration
// rules. Changed: a turn is Cairn's (a user message to the next one, `TimelineEntries.ts`), so the
// run id is the turn id, the duration is the turn's own elapsed time, and every interrupted turn
// (not only the latest) reads "You stopped after <duration>". Removed: superseded attempts,
// subagents, resource cards, questions and runless imported turns.
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

import type {
  TimelineEntry,
  TimelineMessage,
  TimelineTurn,
} from "./TimelineEntries.ts";
import { turnElapsedMs } from "./TimelineEntries.ts";
import { workEntryIndicatesToolFailure } from "./ToolSummary.ts";

/** A duration as t3code writes it: `850ms`, `4.2s`, `37s`, `1h 2m 5s`. */
export const formatDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0ms";
  }

  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }

  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;

    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }

  const totalSeconds = Math.round(durationMs / 1000);

  // The unit is chosen after rounding, so 59.5 seconds never reads "60s".
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(seconds > 0 ? [`${seconds}s`] : []),
  ].join(" ");
};

/**
 * For each message, when its duration starts: the turn's prompt for the first answer, the previous
 * settled answer's end for later ones. A streaming answer does not move the boundary.
 */
export const computeMessageDurationStart = (
  messages: ReadonlyArray<TimelineMessage>
): ReadonlyMap<string, number> => {
  const result = new Map<string, number>();
  let lastBoundary: Option.Option<number> = Option.none();

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = Option.some(message.createdAt);
    }

    result.set(
      message.id,
      Option.getOrElse(lastBoundary, () => message.createdAt)
    );

    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = Option.some(message.updatedAt);
    }
  }

  return result;
};

/** The last assistant message of each turn: the one the answer's metadata and copy belong to. */
export const terminalAssistantMessageIds = (
  entries: ReadonlyArray<TimelineEntry>
): ReadonlySet<string> => {
  const lastByTurn = new Map<string, string>();

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "assistant") {
      lastByTurn.set(entry.message.turnId, entry.message.id);
    }
  }

  return new Set(lastByTurn.values());
};

/** The turn an entry folds with; none for prompts and checkpoints. */
export const entryFoldTurnId = (
  entry: TimelineEntry
): Option.Option<string> => {
  if (entry.kind === "message") {
    return entry.message.role === "assistant"
      ? Option.some(entry.message.turnId)
      : Option.none();
  }

  return entry.kind === "work"
    ? Option.some(entry.entry.turnId)
    : Option.none();
};

/** One folded turn: the entries it hides and the row's label. */
export interface TurnFold {
  readonly turnId: string;
  /** The entry the fold row is placed before: the first entry after the prompt. */
  readonly anchorEntryId: string;
  readonly createdAt: number;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

interface TurnGroup {
  readonly entries: Array<TimelineEntry>;
  terminalEntryId: Option.Option<string>;
  hasStreamingMessage: boolean;
  readonly startBoundary: Option.Option<number>;
  readonly anchorEntryId: string;
}

/** What the fold rules read. */
export interface TurnFoldInput {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly turns: ReadonlyArray<TimelineTurn>;
  /** Turns that never fold: the working one and failed ones. */
  readonly unfoldedTurnIds: ReadonlySet<string>;
}

/** The label a folded turn shows. */
export const foldLabel = (turn: Option.Option<TimelineTurn>): string => {
  const duration = Option.map(
    Option.flatMap(turn, turnElapsedMs),
    formatDuration
  );

  const interrupted = Option.exists(
    turn,
    (found) => found.status === "interrupted"
  );

  if (interrupted) {
    return Option.match(duration, {
      onNone: () => "You stopped this response",
      onSome: (text) => `You stopped after ${text}`,
    });
  }

  return Option.match(duration, {
    onNone: () => "Worked",
    onSome: (text) => `Worked for ${text}`,
  });
};

const isCompactionEntry = (entry: TimelineEntry): boolean =>
  entry.kind === "work" && entry.entry.kind === "compaction";

/** Groups the entries after each prompt by turn, with the place each turn's fold row goes. */
const groupTurns = (
  entries: ReadonlyArray<TimelineEntry>
): ReadonlyMap<string, TurnGroup> => {
  const terminalIds = terminalAssistantMessageIds(entries);
  const groups = new Map<string, TurnGroup>();

  let pendingBoundary: Option.Option<{
    readonly createdAt: number;
    readonly anchorEntryId: string;
  }> = Option.none();

  const startGroup = (entry: TimelineEntry): TurnGroup => {
    const group: TurnGroup = {
      entries: [],
      terminalEntryId: Option.none(),
      hasStreamingMessage: false,
      startBoundary: Option.map(
        pendingBoundary,
        (boundary) => boundary.createdAt
      ),
      anchorEntryId: Option.match(pendingBoundary, {
        onNone: () => entry.id,
        onSome: (boundary) => boundary.anchorEntryId,
      }),
    };

    pendingBoundary = Option.none();

    return group;
  };

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingBoundary = Option.map(
        Option.fromUndefinedOr(entries[index + 1]),
        (next) => ({
          createdAt: entry.createdAt,
          anchorEntryId: next.id,
        })
      );
      continue;
    }

    const turnId = entryFoldTurnId(entry);

    if (Option.isNone(turnId)) {
      continue;
    }

    const group = groups.get(turnId.value) ?? startGroup(entry);

    groups.set(turnId.value, group);
    group.entries.push(entry);

    if (entry.kind === "message") {
      if (terminalIds.has(entry.message.id)) {
        group.terminalEntryId = Option.some(entry.id);
      }

      group.hasStreamingMessage ||= entry.message.streaming;
    }
  }

  return groups;
};

/**
 * What a settled turn's fold hides: everything before its answer, and after it the settled work
 * that did not fail; compactions always.
 */
const hiddenEntryIdsOf = (group: TurnGroup): ReadonlySet<string> => {
  const terminalIndex = Option.match(group.terminalEntryId, {
    onNone: () => group.entries.length,
    onSome: (id) => group.entries.findIndex((entry) => entry.id === id),
  });

  const hidden = new Set<string>();

  for (const [index, entry] of group.entries.entries()) {
    const isFoldableTrailingActivity =
      entry.kind === "work" &&
      entry.entry.status !== "inProgress" &&
      !workEntryIndicatesToolFailure(entry.entry);

    const hides =
      !Option.contains(group.terminalEntryId, entry.id) &&
      (isCompactionEntry(entry) ||
        index < terminalIndex ||
        isFoldableTrailingActivity);

    if (hides) {
      hidden.add(entry.id);
    }
  }

  return hidden;
};

/** Every turn that folds, keyed by the entry its row is placed before. */
export const deriveTurnFolds = (
  input: TurnFoldInput
): ReadonlyMap<string, TurnFold> => {
  const turnsById = new Map(
    input.turns.map((turn) => [turn.id, turn] as const)
  );

  const folds = new Map<string, TurnFold>();

  for (const [turnId, group] of groupTurns(input.entries)) {
    const turn = turnsById.get(turnId);

    // Only a settled turn folds: one with no record (no prompt yet) or still running stays open.
    const settled =
      turn !== undefined &&
      turn.status !== "running" &&
      !input.unfoldedTurnIds.has(turnId) &&
      !group.hasStreamingMessage;

    const hidden = settled ? hiddenEntryIdsOf(group) : new Set<string>();

    const hidesNonCompactionWork = group.entries.some(
      (entry) => hidden.has(entry.id) && !isCompactionEntry(entry)
    );

    const [first] = group.entries;

    if (turn === undefined || !hidesNonCompactionWork || first === undefined) {
      continue;
    }

    folds.set(group.anchorEntryId, {
      turnId,
      anchorEntryId: group.anchorEntryId,
      createdAt: Option.getOrElse(group.startBoundary, () => first.createdAt),
      hiddenEntryIds: hidden,
      label: foldLabel(Option.some(turn)),
    });
  }

  return folds;
};
