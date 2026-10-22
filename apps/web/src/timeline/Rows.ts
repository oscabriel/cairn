// The list the transcript scrolls: client-logic's timeline rows for the page's thread view, kept
// stable across derivations (an unchanged row keeps its object, so its keyed lazy view is reused),
// with the "Load earlier turns" control first while older entries remain. Also each row's estimated
// height before it is measured, bucketed by length as t3code's `getItemType` does
// (github.com/pingdotgg/t3code, apps/web/src/components/chat/MessagesTimeline.tsx:1616-1627 at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92), so one long reply does not skew every estimate.
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import type {
  Timeline,
  TimelineMessage,
} from "@cairn/client-logic/TimelineEntries";
import { entriesFromPi } from "@cairn/client-logic/TimelineEntries";
import type {
  StableTimelineRows,
  TimelineRow,
} from "@cairn/client-logic/TimelineRows";
import {
  computeStableTimelineRows,
  deriveTimelineRows,
  EMPTY_STABLE_ROWS,
} from "@cairn/client-logic/TimelineRows";
import { Option } from "effect";

import type { ThreadUi } from "./Model.ts";

/** The control at the top of a thread with older entries to page in. */
export interface HistoryItem {
  readonly kind: "history";
  readonly id: "history-control";
}

/** One item of the scroll list. */
export type ListItem = TimelineRow | HistoryItem;

/** The derived transcript: the list and the timeline it came from. */
export interface Transcript {
  readonly items: ReadonlyArray<ListItem>;
  readonly timeline: Timeline;
  /** Each turn's prompt, for Retry. */
  readonly prompts: ReadonlyMap<string, TimelineMessage>;
}

const HISTORY_ITEM: HistoryItem = { kind: "history", id: "history-control" };

const EMPTY_TIMELINE: Timeline = {
  entries: [],
  turns: [],
  isWorking: false,
  activeTurnId: Option.none(),
  activeTurnStartedAt: Option.none(),
};

const EMPTY: Transcript = {
  items: [],
  timeline: EMPTY_TIMELINE,
  prompts: new Map(),
};

interface Memo {
  readonly threadId: string;
  readonly view: ThreadViewState["view"];
  readonly older: ThreadViewState["older"];
  readonly hasMoreHistory: boolean;
  readonly ui: ThreadUi;
  readonly workspaceRoot: Option.Option<string>;
  readonly transcript: Transcript;
}

/** The last derivation, so a view whose inputs did not change reuses it. */
const memo = new Map<"last", Memo>();

const stableByThread = new Map<string, StableTimelineRows>();

const promptsOf = (timeline: Timeline): ReadonlyMap<string, TimelineMessage> =>
  new Map(
    timeline.entries.flatMap((entry) =>
      entry.kind === "message" && entry.message.role === "user"
        ? [[entry.message.turnId, entry.message] as const]
        : []
    )
  );

const sameInputs = (
  previous: Memo,
  threadId: string,
  state: ThreadViewState,
  ui: ThreadUi,
  workspaceRoot: Option.Option<string>
): boolean =>
  previous.threadId === threadId &&
  previous.view === state.view &&
  previous.older === state.older &&
  previous.hasMoreHistory === state.hasMoreHistory &&
  previous.ui.expandedTurnIds === ui.expandedTurnIds &&
  previous.ui.expandedWorkGroupIds === ui.expandedWorkGroupIds &&
  Option.getOrUndefined(previous.workspaceRoot) ===
    Option.getOrUndefined(workspaceRoot);

/** The transcript of `state` as `ui` opens it; the same object while nothing it reads changed. */
export const transcriptOf = (
  threadId: string,
  state: Option.Option<ThreadViewState>,
  ui: ThreadUi,
  workspaceRoot: Option.Option<string>
): Transcript => {
  if (Option.isNone(state)) {
    return EMPTY;
  }

  const last = memo.get("last");

  if (
    last !== undefined &&
    sameInputs(last, threadId, state.value, ui, workspaceRoot)
  ) {
    return last.transcript;
  }

  const timeline = entriesFromPi(state.value.view, state.value.older);

  const rows = deriveTimelineRows({
    timeline,
    expandedTurnIds: new Set(ui.expandedTurnIds),
    expandedWorkGroupIds: new Set(ui.expandedWorkGroupIds),
    workspaceRoot,
  });

  const stable = computeStableTimelineRows(
    rows,
    stableByThread.get(threadId) ?? EMPTY_STABLE_ROWS
  );

  stableByThread.set(threadId, stable);

  const transcript: Transcript = {
    items: state.value.hasMoreHistory
      ? [HISTORY_ITEM, ...stable.result]
      : stable.result,
    timeline,
    prompts: promptsOf(timeline),
  };

  memo.set("last", {
    threadId,
    view: state.value.view,
    older: state.value.older,
    hasMoreHistory: state.value.hasMoreHistory,
    ui,
    workspaceRoot,
    transcript,
  });

  return transcript;
};

/** Every item's key, in order. */
export const itemKeys = (transcript: Transcript): ReadonlyArray<string> =>
  transcript.items.map((item) => item.id);

const LINE_PX = 22;

const CHARS_PER_LINE = 90;

/** Rounds a line count up to a power of two, so similar lengths share one estimate. */
const bucketLines = (lines: number): number =>
  2 ** Math.ceil(Math.log2(Math.max(1, lines)));

const textLines = (text: string): number =>
  text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)),
      0
    );

const messageHeight = (message: TimelineMessage, expanded: boolean): number => {
  const lines = bucketLines(textLines(message.text));

  if (message.role === "user") {
    return 64 + LINE_PX * (expanded ? lines : Math.min(lines, 8));
  }

  return 24 + LINE_PX * lines;
};

const FIXED_HEIGHTS: Readonly<
  Record<Exclude<ListItem["kind"], "message" | "changed-files">, number>
> = {
  history: 44,
  working: 32,
  thinking: 32,
  "work-live": 32,
  "work-toggle": 32,
  "turn-fold": 40,
  "context-compaction": 40,
  error: 72,
  "assistant-meta": 28,
  work: 32,
};

/** A row's height before it is measured. */
export const estimatedHeightOf = (
  item: ListItem,
  expandedUserMessages: ReadonlySet<string>
): number => {
  if (item.kind === "message") {
    return messageHeight(item.message, expandedUserMessages.has(item.id));
  }

  if (item.kind === "changed-files") {
    return 56 + 28 * Math.min(item.files.length, 12);
  }

  if (item.kind === "work" && item.isExpandedToolGroup) {
    return 12 + 28 * item.groupedEntries.length;
  }

  return FIXED_HEIGHTS[item.kind];
};
