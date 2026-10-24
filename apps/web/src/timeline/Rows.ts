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
  TurnRowsCache,
} from "@cairn/client-logic/TimelineRows";
import {
  computeStableTimelineRows,
  deriveTimelineRowsCached,
  EMPTY_STABLE_ROWS,
  EMPTY_TURN_ROWS,
} from "@cairn/client-logic/TimelineRows";
import { Option } from "effect";

import type { ThreadUi } from "./Model.ts";

/** The control at the top of a thread with older entries to page in. */
export interface HistoryItem {
  readonly kind: "history";
  readonly id: "history-control";
}

/** A turn's changed-files row. */
export type ChangedFilesRow = Extract<
  TimelineRow,
  { readonly kind: "changed-files" }
>;

/**
 * A message row; an answer that ends its turn carries the turn's changed-files card, which t3code
 * draws inside the answer's row rather than as a row of its own.
 */
export type MessageItem = Extract<TimelineRow, { readonly kind: "message" }> & {
  readonly changedFiles: Option.Option<ChangedFilesRow>;
};

/** One item of the scroll list. */
export type ListItem =
  | Exclude<TimelineRow, { readonly kind: "message" }>
  | MessageItem
  | HistoryItem;

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

/** The merged items, by message row and then by card row, so a stable row keeps its item. */
const mergedRows = new WeakMap<TimelineRow, WeakMap<object, MessageItem>>();

/** Stands for "no card" in `mergedRows`. */
const NO_CARD = {};

const messageItem = (
  row: Extract<TimelineRow, { readonly kind: "message" }>,
  card: Option.Option<ChangedFilesRow>
): MessageItem => {
  const byCard = mergedRows.get(row) ?? new WeakMap<object, MessageItem>();

  mergedRows.set(row, byCard);

  const key: object = Option.getOrElse(card, () => NO_CARD);
  const known = byCard.get(key);

  if (known !== undefined) {
    return known;
  }

  const item: MessageItem = { ...row, changedFiles: card };

  byCard.set(key, item);

  return item;
};

/**
 * The answer a changed-files row belongs to: the last assistant message of its turn, found walking
 * back from the card and stopping at the turn's user message. t3code keys the card by its turn's
 * assistant message, so tool rows between that answer and the card do not separate them.
 */
const answerIndexOf = (
  rows: ReadonlyArray<TimelineRow>,
  cardIndex: number
): Option.Option<number> => {
  for (let index = cardIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];

    if (row?.kind === "message") {
      return row.message.role === "assistant"
        ? Option.some(index)
        : Option.none();
    }
  }

  return Option.none();
};

/** Moves each changed-files row into its turn's answer, as t3code draws the card. */
const attachCards = (
  rows: ReadonlyArray<TimelineRow>
): ReadonlyArray<ListItem> => {
  const cardByAnswer = new Map<number, ChangedFilesRow>();

  for (const [index, row] of rows.entries()) {
    if (row.kind === "changed-files") {
      Option.map(answerIndexOf(rows, index), (answer) =>
        cardByAnswer.set(answer, row)
      );
    }
  }

  const attached = new Set(cardByAnswer.values());

  return rows.flatMap((row, index): ReadonlyArray<ListItem> => {
    if (row.kind === "changed-files" && attached.has(row)) {
      return [];
    }

    if (row.kind !== "message") {
      return [row];
    }

    return [messageItem(row, Option.fromUndefinedOr(cardByAnswer.get(index)))];
  });
};

/** The last derivation, so a view whose inputs did not change reuses it. */
const memo = new Map<"last", Memo>();

const stableByThread = new Map<string, StableTimelineRows>();

/** Each thread's settled turns' rows, reused while a turn's entries and toggles are unchanged. */
const turnRowsByThread = new Map<string, TurnRowsCache>();

/** The working directory each thread's transcript was last derived with (see `transcriptKeys`). */
const rootByThread = new Map<string, Option.Option<string>>();

/** One set per toggle list, so an unchanged list keeps its set and the turn cache keeps its rows. */
const toggleSets = new WeakMap<ReadonlyArray<string>, ReadonlySet<string>>();

const toggleSet = (ids: ReadonlyArray<string>): ReadonlySet<string> => {
  const known = toggleSets.get(ids);

  if (known !== undefined) {
    return known;
  }

  const set = new Set(ids);

  toggleSets.set(ids, set);

  return set;
};

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

  const derived = deriveTimelineRowsCached(
    {
      timeline,
      expandedTurnIds: toggleSet(ui.expandedTurnIds),
      expandedWorkGroupIds: toggleSet(ui.expandedWorkGroupIds),
      workspaceRoot,
    },
    turnRowsByThread.get(threadId) ?? EMPTY_TURN_ROWS
  );

  turnRowsByThread.set(threadId, derived.cache);
  rootByThread.set(threadId, workspaceRoot);

  const { rows } = derived;

  const stable = computeStableTimelineRows(
    rows,
    stableByThread.get(threadId) ?? EMPTY_STABLE_ROWS
  );

  stableByThread.set(threadId, stable);

  const transcript: Transcript = {
    items: state.value.hasMoreHistory
      ? [HISTORY_ITEM, ...attachCards(stable.result)]
      : attachCards(stable.result),
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

/**
 * The transcript of `state` as `ui` opens it, for the list's keys outside the view. Keys do not
 * depend on the working directory, so this derives with the one the thread's view last used: the
 * view then finds the transcript memoized instead of deriving it a second time with its own.
 */
export const transcriptForKeys = (
  threadId: string,
  state: Option.Option<ThreadViewState>,
  ui: ThreadUi
): Transcript =>
  transcriptOf(
    threadId,
    state,
    ui,
    rootByThread.get(threadId) ?? Option.none()
  );

const LINE_PX = 22;

const CHARS_PER_LINE = 90;

/** Rounds a line count up to a power of two, so similar lengths share one estimate. */
const bucketLines = (lines: number): number =>
  2 ** Math.ceil(Math.log2(Math.max(1, lines)));

/** Each message's wrapped line count; a stable message is counted once, not every render. */
const lineCounts = new WeakMap<TimelineMessage, number>();

const textLines = (message: TimelineMessage): number => {
  const known = lineCounts.get(message);

  if (known !== undefined) {
    return known;
  }

  const lines = message.text
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)),
      0
    );

  lineCounts.set(message, lines);

  return lines;
};

const cardHeight = (card: ChangedFilesRow): number =>
  56 + 28 * Math.min(card.files.length, 12);

const messageHeight = (message: TimelineMessage, expanded: boolean): number => {
  const lines = bucketLines(textLines(message));

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
    return (
      messageHeight(item.message, expandedUserMessages.has(item.id)) +
      Option.match(item.changedFiles, {
        onNone: () => 0,
        onSome: (card) => 16 + cardHeight(card),
      })
    );
  }

  if (item.kind === "changed-files") {
    return cardHeight(item);
  }

  if (item.kind === "work" && item.isExpandedToolGroup) {
    return 12 + 28 * item.groupedEntries.length;
  }

  return FIXED_HEIGHTS[item.kind];
};
