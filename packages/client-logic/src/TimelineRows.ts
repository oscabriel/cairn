// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/MessagesTimeline.logic.ts
// (`deriveMessagesTimelineRows`, `attachTrailingToolGroupsToAssistant`,
// `computeStableMessagesTimelineRows`, `isRowUnchanged`, `shouldCollapseUserMessage`,
// `resolveAssistantMessageCopyState`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the row
// kinds `message`, `assistant-meta`, `work`, `work-live`, `work-toggle`, `working`, `thinking`,
// `turn-fold` and `context-compaction`, with t3code's ids (`work-group:<entryId>`,
// `<groupId>:details`, `live-activity-row`, `working-indicator-row`, `turn-fold:<turn>`); grouping of
// adjacent work of one turn, the live row for the working turn's tail, the "thinking" row while the
// model has nothing to show, the working header under the prompt, folds, the answer's metadata
// moved below its trailing tool groups, `continuesWorkLog`, stable rows that keep a row's identity
// when it did not change, and the 8 line or 600 character collapse of a user message. Changed: rows
// come from Cairn's timeline (`TimelineEntries.ts`), whose run id is the turn; a failed turn's error
// is its own `error` row (t3code draws failure items as work rows) that offers Retry on the newest
// turn; a checkpoint entry becomes a `changed-files` row at the end of its turn. Removed: worktree
// setup, superseded attempts, subagents, plans, HTML renders, MCP apps, created-thread summaries,
// turn diffs and rollback, citations, the minimap and the streaming-only fast path (stable rows
// keep settled rows' identity instead).
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
import { Equal, Option } from "effect";

import type { TurnDiffFile } from "./DiffTree.ts";
import type {
  Timeline,
  TimelineEntry,
  TimelineMessage,
  TimelineTurn,
  WorkEntry,
} from "./TimelineEntries.ts";
import {
  computeMessageDurationStart,
  deriveTurnFolds,
  terminalAssistantMessageIds,
} from "./TimelineFolds.ts";
import type { TurnFold } from "./TimelineFolds.ts";
import type { ToolGroupSummaryKind } from "./ToolSummary.ts";
import {
  singleToolCallLabel,
  summarizeToolGroup,
  toolGroupSummaryKind,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIsToolLike,
  workEntryIsVisibleInGroup,
} from "./ToolSummary.ts";

/** The id of the one live activity row (the working turn's latest tool or thought). */
export const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

/** The id of the working header under the working turn's prompt. */
export const WORKING_ROW_ID = "working-indicator-row";

type RowContent =
  | {
      readonly kind: "work";
      readonly id: string;
      readonly createdAt: number;
      readonly groupedEntries: ReadonlyArray<WorkEntry>;
      /** True for the details row under an expanded group's header. */
      readonly isExpandedToolGroup: boolean;
      readonly displayLabel: Option.Option<string>;
    }
  | {
      readonly kind: "work-live";
      readonly id: string;
      readonly createdAt: number;
      readonly entry: WorkEntry;
      readonly groupedEntries: ReadonlyArray<WorkEntry>;
      readonly groupId: string;
      readonly expanded: boolean;
      readonly active: boolean;
      readonly thought: Option.Option<WorkEntry>;
    }
  | {
      readonly kind: "working";
      readonly id: string;
      readonly createdAt: Option.Option<number>;
    }
  | {
      readonly kind: "thinking";
      readonly id: string;
      readonly createdAt: Option.Option<number>;
      /** Set when the working turn's latest call failed: the row opens that call's group. */
      readonly groupId: Option.Option<string>;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "work-toggle";
      readonly id: string;
      readonly createdAt: number;
      readonly turnId: string;
      readonly groupId: string;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly summary: string;
      readonly summaryKind: ToolGroupSummaryKind;
      readonly hasFailure: boolean;
    }
  | {
      readonly kind: "turn-fold";
      readonly id: string;
      readonly createdAt: number;
      readonly turnId: string;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "context-compaction";
      readonly id: string;
      readonly createdAt: number;
      readonly label: string;
    }
  | {
      readonly kind: "error";
      readonly id: string;
      readonly createdAt: number;
      readonly entry: WorkEntry;
      /** The newest turn's error, while nothing runs: Retry sends its prompt again. */
      readonly retryable: boolean;
    }
  | {
      readonly kind: "message";
      readonly id: string;
      readonly createdAt: number;
      readonly message: TimelineMessage;
      /** When the answer's duration starts (the prompt, or the previous answer's end). */
      readonly durationStart: number;
      readonly showAssistantMeta: boolean;
      readonly showAssistantCopyButton: boolean;
      readonly assistantCopyStreaming: boolean;
    }
  | {
      /** A turn's changed-files card, after the turn's last row. */
      readonly kind: "changed-files";
      readonly id: string;
      readonly createdAt: number;
      readonly turn: number;
      readonly files: ReadonlyArray<TurnDiffFile>;
      readonly moreFiles: number;
    }
  | {
      readonly kind: "assistant-meta";
      readonly id: string;
      readonly createdAt: number;
      readonly message: TimelineMessage;
      readonly showAssistantCopyButton: boolean;
      readonly assistantCopyStreaming: boolean;
    };

/** One row of the transcript, keyed by a stable `id`. */
export type TimelineRow = RowContent & {
  /** True when the next row is also part of the work log, so the two draw as one block. */
  readonly continuesWorkLog: boolean;
};

type Row = RowContent;

/** What the rows depend on besides the timeline: which folds and groups the user opened. */
export interface TimelineRowsInput {
  readonly timeline: Timeline;
  readonly expandedTurnIds: ReadonlySet<string>;
  readonly expandedWorkGroupIds: ReadonlySet<string>;
  /** The thread's working directory, for relative paths in labels. */
  readonly workspaceRoot: Option.Option<string>;
}

/** The group id of a run of work starting at `entryId`. */
export const workGroupId = (entryId: string): string => `work-group:${entryId}`;

const expandedWorkGroupRow = (
  groupId: string,
  createdAt: number,
  groupedEntries: ReadonlyArray<WorkEntry>
): Row => ({
  kind: "work",
  id: `${groupId}:details`,
  createdAt,
  groupedEntries,
  isExpandedToolGroup: true,
  displayLabel: Option.none(),
});

/** An answer's copy button: the text it copies and whether it shows. */
export interface AssistantCopyState {
  readonly text: Option.Option<string>;
  readonly visible: boolean;
}

/** The copy button of an answer: shown for a settled terminal answer with text. */
export const resolveAssistantMessageCopyState = (input: {
  readonly text: string;
  readonly showCopyButton: boolean;
  readonly streaming: boolean;
}): AssistantCopyState => {
  const hasText = input.text.trim().length > 0;

  return {
    text: hasText ? Option.some(input.text) : Option.none(),
    visible: input.showCopyButton && hasText && !input.streaming,
  };
};

const isUserMessage = (entry: TimelineEntry | undefined): boolean =>
  entry?.kind === "message" && entry.message.role === "user";

/** Breaks a run of work: errors and compactions take their own rows. */
const isGroupableWork = (
  entry: TimelineEntry | undefined
): entry is Extract<TimelineEntry, { readonly kind: "work" }> =>
  entry?.kind === "work" &&
  entry.entry.kind !== "error" &&
  entry.entry.kind !== "compaction";

const rowTime = (row: Row): Option.Option<number> =>
  row.kind === "working" || row.kind === "thinking"
    ? row.createdAt
    : Option.some(row.createdAt);

const moveMetaBelowTrailingWork = (
  rows: ReadonlyArray<Row>
): ReadonlyArray<Row> => {
  const withoutMeta = new Set<string>();
  const metaAfterIndex = new Map<number, Row>();

  for (const [messageIndex, row] of rows.entries()) {
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;

    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];

      if (candidate === undefined || candidate.kind === "message") {
        break;
      }

      if (
        candidate.kind === "work-toggle" &&
        candidate.turnId === row.message.turnId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }

      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some(
          (entry) => entry.turnId === row.message.turnId
        )
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(workEntryIsToolLike)
        ) {
          hasTrailingToolGroup = true;
        }

        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    withoutMeta.add(row.id);
    metaAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      createdAt: Option.getOrElse(
        Option.flatMap(
          Option.fromUndefinedOr(rows[lastTrailingWorkIndex]),
          rowTime
        ),
        () => row.message.updatedAt
      ),
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: Array<Row> = [];

  for (const [index, row] of rows.entries()) {
    result.push(
      row.kind === "message" && withoutMeta.has(row.id)
        ? { ...row, showAssistantMeta: false, showAssistantCopyButton: false }
        : row
    );

    const meta = metaAfterIndex.get(index);

    if (meta !== undefined) {
      result.push(meta);
    }
  }

  return result;
};

const isWorkLogRow = (row: Row | undefined): boolean =>
  row !== undefined &&
  (row.kind === "work" ||
    row.kind === "work-toggle" ||
    row.kind === "work-live" ||
    row.kind === "thinking");

/** Rows read from the entries at one index, and the index of the next entry to read. */
interface RowsStep {
  readonly rows: ReadonlyArray<Row>;
  readonly next: number;
}

/** A run of adjacent work of one turn, and the index after it. */
interface CollectedGroup {
  readonly grouped: ReadonlyArray<WorkEntry>;
  readonly next: number;
}

type WorkTimelineEntry = Extract<TimelineEntry, { readonly kind: "work" }>;

type LiveRow = Extract<Row, { readonly kind: "work-live" }>;

/** The working turn's trailing work, which the one live row stands for. */
interface ActiveTail {
  /** Every entry of the tail; hidden from the ordinary rows when the live row shows them. */
  readonly entries: ReadonlyArray<WorkTimelineEntry>;
  readonly visible: ReadonlyArray<WorkTimelineEntry>;
  readonly anchor: Option.Option<WorkTimelineEntry>;
  readonly row: Option.Option<LiveRow>;
  /** The tail's latest visible call failed: the thinking row stands in and opens its group. */
  readonly latestFailed: boolean;
  /** The entry the live row is placed at: the latest visible one. */
  readonly placementId: Option.Option<string>;
}

/** What every row builder reads, computed once per derivation. */
interface RowContext {
  readonly input: TimelineRowsInput;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly isWorking: boolean;
  readonly folds: ReadonlyMap<string, TurnFold>;
  readonly collapsed: ReadonlySet<string>;
  readonly terminalIds: ReadonlySet<string>;
  readonly durationStart: ReadonlyMap<string, number>;
  readonly latestTurn: Option.Option<TimelineTurn>;
  readonly headerIndex: number;
  readonly tail: ActiveTail;
  readonly hiddenByTail: ReadonlySet<string>;
}

const isActiveTurn = (input: TimelineRowsInput, turnId: string): boolean =>
  Option.contains(input.timeline.activeTurnId, turnId);

const isInActiveRun = (input: TimelineRowsInput, entry: WorkEntry): boolean =>
  input.timeline.isWorking &&
  entry.status === "inProgress" &&
  isActiveTurn(input, entry.turnId);

const isThoughtWithText = (entry: WorkTimelineEntry): boolean =>
  entry.entry.kind === "reasoning" &&
  Option.exists(entry.entry.detail, (detail) => detail.trim() !== "");

const trailingActiveWork = (
  input: TimelineRowsInput,
  entries: ReadonlyArray<TimelineEntry>,
  headerIndex: number,
  hidden: (entryId: string) => boolean
): ReadonlyArray<WorkTimelineEntry> => {
  const tail: Array<WorkTimelineEntry> = [];

  if (!input.timeline.isWorking || Option.isNone(input.timeline.activeTurnId)) {
    return tail;
  }

  for (let index = entries.length - 1; index >= headerIndex; index -= 1) {
    const entry = entries[index];

    if (
      !isGroupableWork(entry) ||
      !isActiveTurn(input, entry.entry.turnId) ||
      hidden(entry.id)
    ) {
      break;
    }

    tail.push(entry);
  }

  return tail.toReversed();
};

const deriveActiveTail = (
  input: TimelineRowsInput,
  entries: ReadonlyArray<WorkTimelineEntry>
): ActiveTail => {
  const visible = entries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true)
  );

  const anchor = Option.fromUndefinedOr(entries[0]);
  const latestVisible = Option.fromUndefinedOr(visible.at(-1));

  const latestRunning = Option.fromUndefinedOr(
    visible.findLast((entry) => entry.entry.status === "inProgress")
  );

  const keepsLive =
    Option.isSome(latestRunning) ||
    Option.exists(latestVisible, (entry) =>
      workEntryIndicatesToolSuccess(entry.entry)
    );

  const latestFailed =
    Option.isNone(latestRunning) &&
    Option.exists(latestVisible, (entry) =>
      workEntryIndicatesToolFailure(entry.entry)
    );

  const row = Option.flatMap(
    Option.all([anchor, latestVisible]),
    ([first, latest]) => {
      if (latestFailed) {
        return Option.none();
      }

      const groupId = workGroupId(first.id);

      return Option.some<LiveRow>({
        kind: "work-live",
        id: keepsLive ? LIVE_ACTIVITY_ROW_ID : `work-live:${first.id}`,
        createdAt: first.createdAt,
        entry: Option.getOrElse(latestRunning, () => latest).entry,
        groupedEntries: visible.map((entry) => entry.entry),
        groupId,
        expanded: input.expandedWorkGroupIds.has(groupId),
        active: keepsLive,
        thought: Option.map(
          Option.fromUndefinedOr(visible.findLast(isThoughtWithText)),
          (entry) => entry.entry
        ),
      });
    }
  );

  return {
    entries,
    visible,
    anchor,
    row,
    latestFailed,
    placementId: Option.map(latestVisible, (entry) => entry.id),
  };
};

const makeRowContext = (input: TimelineRowsInput): RowContext => {
  const { timeline } = input;

  const entries = timeline.entries.filter(
    (entry) => entry.kind !== "checkpoint"
  );

  const failedTurnIds = timeline.turns
    .filter((turn) => turn.status === "failed")
    .map((turn) => turn.id);

  const folds = deriveTurnFolds({
    entries,
    turns: timeline.turns,
    unfoldedTurnIds: new Set([
      ...Option.toArray(timeline.activeTurnId),
      ...failedTurnIds,
    ]),
  });

  const collapsed = new Set(
    [...folds.values()]
      .filter((fold) => !input.expandedTurnIds.has(fold.turnId))
      .flatMap((fold) => [...fold.hiddenEntryIds])
  );

  const headerIndex = timeline.isWorking
    ? entries.findLastIndex(isUserMessage) + 1
    : entries.length;

  const tail = deriveActiveTail(
    input,
    trailingActiveWork(
      input,
      entries,
      headerIndex,
      (id) => collapsed.has(id) || folds.has(id)
    )
  );

  return {
    input,
    entries,
    isWorking: timeline.isWorking,
    folds,
    collapsed,
    terminalIds: terminalAssistantMessageIds(entries),
    durationStart: computeMessageDurationStart(
      entries.flatMap((entry) =>
        entry.kind === "message" ? [entry.message] : []
      )
    ),
    latestTurn: Option.fromUndefinedOr(timeline.turns.at(-1)),
    headerIndex,
    tail,
    hiddenByTail: new Set(
      Option.isSome(tail.row) || tail.latestFailed
        ? tail.entries.map((entry) => entry.id)
        : []
    ),
  };
};

const workingRow = (context: RowContext): Row => ({
  kind: "working",
  id: WORKING_ROW_ID,
  createdAt: context.input.timeline.activeTurnStartedAt,
});

const placedLiveRows = (row: LiveRow): ReadonlyArray<Row> =>
  row.expanded
    ? [
        row,
        expandedWorkGroupRow(row.groupId, row.createdAt, row.groupedEntries),
      ]
    : [row];

const foldRow = (context: RowContext, fold: TurnFold): Row => ({
  kind: "turn-fold",
  id: `turn-fold:${fold.turnId}`,
  createdAt: fold.createdAt,
  turnId: fold.turnId,
  label: fold.label,
  expanded: context.input.expandedTurnIds.has(fold.turnId),
});

const messageRow = (
  context: RowContext,
  entry: Extract<TimelineEntry, { readonly kind: "message" }>
): Row => {
  const { message } = entry;

  const stillInProgress =
    message.role === "assistant" && isActiveTurn(context.input, message.turnId);

  const showAssistantMeta =
    message.role === "assistant" &&
    context.terminalIds.has(message.id) &&
    !stillInProgress;

  return {
    kind: "message",
    id: entry.id,
    createdAt: entry.createdAt,
    message,
    durationStart: context.durationStart.get(message.id) ?? message.createdAt,
    showAssistantMeta,
    showAssistantCopyButton: showAssistantMeta,
    assistantCopyStreaming: message.streaming || stillInProgress,
  };
};

const errorRow = (context: RowContext, entry: WorkTimelineEntry): Row => ({
  kind: "error",
  id: entry.id,
  createdAt: entry.createdAt,
  entry: entry.entry,
  retryable:
    !context.isWorking &&
    Option.exists(
      context.latestTurn,
      (turn) => turn.id === entry.entry.turnId && turn.status === "failed"
    ),
});

/** The adjacent groupable work of one turn starting at `start`, and the index after it. */
const collectGroup = (
  context: RowContext,
  start: number,
  first: WorkTimelineEntry
): CollectedGroup => {
  const grouped: Array<WorkEntry> = [first.entry];
  let cursor = start + 1;

  for (; cursor < context.entries.length; cursor += 1) {
    const next = context.entries[cursor];

    const joins =
      isGroupableWork(next) &&
      !context.hiddenByTail.has(next.id) &&
      !context.collapsed.has(next.id) &&
      !context.folds.has(next.id) &&
      next.entry.turnId === first.entry.turnId;

    if (!joins) {
      break;
    }

    grouped.push(next.entry);
  }

  return { grouped, next: cursor };
};

/** A group's rows: the live row while one of its calls runs, a single call, or a toggle. */
const groupRows = (
  context: RowContext,
  first: WorkTimelineEntry,
  grouped: ReadonlyArray<WorkEntry>
): ReadonlyArray<Row> => {
  const { input } = context;

  const visible = grouped.filter((work) =>
    workEntryIsVisibleInGroup(work, isInActiveRun(input, work))
  );

  const groupId = workGroupId(first.id);
  const expanded = input.expandedWorkGroupIds.has(groupId);

  const details = expanded
    ? [expandedWorkGroupRow(groupId, first.createdAt, visible)]
    : [];

  const latestActive = visible.findLast((work) => isInActiveRun(input, work));
  const [single] = visible;

  if (single === undefined) {
    return [];
  }

  if (latestActive !== undefined) {
    return [
      {
        kind: "work-live",
        id: `work-live:${first.id}`,
        createdAt: first.createdAt,
        entry: latestActive,
        groupedEntries: visible,
        groupId,
        expanded,
        active: true,
        thought: Option.none(),
      },
      ...details,
    ];
  }

  if (visible.length === 1 && workEntryIsToolLike(single)) {
    return [
      {
        kind: "work",
        id: first.id,
        createdAt: first.createdAt,
        groupedEntries: visible,
        isExpandedToolGroup: false,
        displayLabel: Option.some(
          singleToolCallLabel(single, input.workspaceRoot)
        ),
      },
    ];
  }

  const latestTool = visible.findLast(workEntryIsToolLike);

  return [
    {
      kind: "work-toggle",
      id: `work-toggle:${first.id}`,
      createdAt: first.createdAt,
      turnId: first.entry.turnId,
      groupId,
      hiddenCount: visible.length,
      expanded,
      summary: summarizeToolGroup(visible).summary,
      summaryKind: toolGroupSummaryKind(visible),
      hasFailure:
        latestTool !== undefined && workEntryIndicatesToolFailure(latestTool),
    },
    ...details,
  ];
};

/** The rows of the work entry at `index`, and the index of the next entry to read. */
const workRows = (
  context: RowContext,
  index: number,
  entry: WorkTimelineEntry
): RowsStep => {
  if (entry.entry.kind === "compaction") {
    return {
      rows: [
        {
          kind: "context-compaction",
          id: entry.id,
          createdAt: entry.createdAt,
          label: Option.getOrElse(
            entry.entry.detail,
            () => "Context compacted"
          ),
        },
      ],
      next: index + 1,
    };
  }

  if (entry.entry.kind === "error") {
    return { rows: [errorRow(context, entry)], next: index + 1 };
  }

  const { grouped, next } = collectGroup(context, index, entry);

  return { rows: groupRows(context, entry, grouped), next };
};

/** The thinking row (and its opened group) while the working turn shows no live call. */
const thinkingRows = (context: RowContext): ReadonlyArray<Row> => {
  const { input, tail } = context;
  const failedAnchor = tail.latestFailed ? tail.anchor : Option.none();
  const groupId = Option.map(failedAnchor, (anchor) => workGroupId(anchor.id));

  const expanded = Option.exists(groupId, (id) =>
    input.expandedWorkGroupIds.has(id)
  );

  const thinking: Row = {
    kind: "thinking",
    id: LIVE_ACTIVITY_ROW_ID,
    createdAt: input.timeline.activeTurnStartedAt,
    groupId,
    expanded,
  };

  if (!expanded) {
    return [thinking];
  }

  return [
    thinking,
    ...Option.toArray(
      Option.map(Option.all([groupId, failedAnchor]), ([id, anchor]) =>
        expandedWorkGroupRow(
          id,
          anchor.createdAt,
          tail.visible.map((entry) => entry.entry)
        )
      )
    ),
  ];
};

const isActiveLiveRow = (row: Row): boolean =>
  row.kind === "work-live" && row.active;

/** The rows of one entry, in order: the working header, the live row, a fold, then the entry's own. */
const entryRows = (
  context: RowContext,
  index: number,
  entry: TimelineEntry
): RowsStep => {
  const before: Array<Row> = [];

  if (context.isWorking && index === context.headerIndex) {
    before.push(workingRow(context));
  }

  if (Option.contains(context.tail.placementId, entry.id)) {
    before.push(
      ...Option.match(context.tail.row, {
        onNone: () => [],
        onSome: placedLiveRows,
      })
    );
  }

  const fold = context.folds.get(entry.id);

  if (fold !== undefined) {
    before.push(foldRow(context, fold));
  }

  if (context.collapsed.has(entry.id) || context.hiddenByTail.has(entry.id)) {
    return { rows: before, next: index + 1 };
  }

  if (entry.kind === "message") {
    return { rows: [...before, messageRow(context, entry)], next: index + 1 };
  }

  if (entry.kind === "work") {
    const work = workRows(context, index, entry);

    return { rows: [...before, ...work.rows], next: work.next };
  }

  return { rows: before, next: index + 1 };
};

/** Each turn's changed-files rows, keyed by turn id; a checkpoint that lists nothing makes none. */
const changedFilesByTurn = (
  timeline: TimelineRowsInput["timeline"]
): Map<string, Array<Row>> => {
  const byTurn = new Map<string, Array<Row>>();

  for (const entry of timeline.entries) {
    if (
      entry.kind !== "checkpoint" ||
      (entry.files.length === 0 && entry.moreFiles === 0)
    ) {
      continue;
    }

    const rows = byTurn.get(entry.turnId) ?? [];

    rows.push({
      kind: "changed-files",
      id: entry.id,
      createdAt: entry.createdAt,
      turn: entry.turn,
      files: entry.files,
      moreFiles: entry.moreFiles,
    });
    byTurn.set(entry.turnId, rows);
  }

  return byTurn;
};

/**
 * Places each changed-files row at the end of its turn: before the first user message of a later
 * turn, or at the end of the transcript.
 */
const placeChangedFiles = (
  timeline: TimelineRowsInput["timeline"],
  rows: ReadonlyArray<Row>
): ReadonlyArray<Row> => {
  const pending = changedFilesByTurn(timeline);

  if (pending.size === 0) {
    return rows;
  }

  const order = new Map(timeline.turns.map((turn, index) => [turn.id, index]));
  const result: Array<Row> = [];

  const flushBefore = (turnIndex: number) => {
    for (const [turnId, cards] of pending) {
      if ((order.get(turnId) ?? -1) < turnIndex) {
        result.push(...cards);
        pending.delete(turnId);
      }
    }
  };

  for (const row of rows) {
    if (row.kind === "message" && row.message.role === "user") {
      flushBefore(order.get(row.message.turnId) ?? Number.POSITIVE_INFINITY);
    }

    result.push(row);
  }

  flushBefore(Number.POSITIVE_INFINITY);

  return result;
};

/** The transcript's rows: messages, folds, grouped work, the live row and the working header. */
export const deriveTimelineRows = (
  input: TimelineRowsInput
): ReadonlyArray<TimelineRow> => {
  const context = makeRowContext(input);
  const rows: Array<Row> = [];
  let index = 0;

  while (index < context.entries.length) {
    const entry = context.entries[index];

    if (entry === undefined) {
      break;
    }

    const step = entryRows(context, index, entry);

    rows.push(...step.rows);
    index = step.next;
  }

  if (context.isWorking && !rows.some((row) => row.kind === "working")) {
    rows.push(workingRow(context));
  }

  if (
    context.isWorking &&
    (!rows.some(isActiveLiveRow) || context.tail.latestFailed)
  ) {
    rows.push(...thinkingRows(context));
  }

  const result = placeChangedFiles(
    input.timeline,
    moveMetaBelowTrailingWork(rows)
  );

  return result.map((row, rowIndex) => ({
    ...row,
    continuesWorkLog: isWorkLogRow(row) && isWorkLogRow(result[rowIndex + 1]),
  }));
};

/** The previous derivation's rows by id, so unchanged rows keep their identity. */
export interface StableTimelineRows {
  readonly byId: ReadonlyMap<string, TimelineRow>;
  readonly result: ReadonlyArray<TimelineRow>;
}

/** No rows yet. */
export const EMPTY_STABLE_ROWS: StableTimelineRows = {
  byId: new Map(),
  result: [],
};

/**
 * True when two rows with one id render the same. Rows are plain immutable data, so Effect's
 * structural equality compares them field by field, entries and options included.
 */
export const isRowUnchanged = (a: TimelineRow, b: TimelineRow): boolean =>
  Equal.equals(a, b);

/**
 * Rows that did not change keep the previous object, and an unchanged list keeps the previous
 * array, so views memoized on a row (or on the list) skip their work.
 */
export const computeStableTimelineRows = (
  rows: ReadonlyArray<TimelineRow>,
  previous: StableTimelineRows
): StableTimelineRows => {
  const byId = new Map<string, TimelineRow>();
  let anyChanged = rows.length !== previous.result.length;

  const result = rows.map((row, index) => {
    const before = previous.byId.get(row.id);

    const next =
      before !== undefined && isRowUnchanged(before, row) ? before : row;

    byId.set(row.id, next);

    if (!anyChanged && previous.result[index] !== next) {
      anyChanged = true;
    }

    return next;
  });

  return anyChanged ? { byId, result } : previous;
};

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;

const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

const MARKDOWN_LINK = /!?\[(?<label>[^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/gu;

/** True when a user message is long enough to collapse: over 8 lines or 600 visible characters. */
export const shouldCollapseUserMessage = (text: string): boolean => {
  const visible = text.replaceAll(MARKDOWN_LINK, "$<label>");

  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
};
