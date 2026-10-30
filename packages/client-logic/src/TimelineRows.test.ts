// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/MessagesTimeline.logic.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the cases for the rows Cairn keeps (folds and
// their labels, trailing work after the answer, the working header and the live activity row, single
// tool calls, separated running tools, the answer's metadata, expanded groups, integration sources,
// stable rows, message duration starts and the user message collapse) with their expected ids and
// labels. Changed: entries are Cairn timeline entries (turn ids for run ids, epoch milliseconds for
// ISO times), and a turn's duration comes from its turn record. Removed: cases for superseded
// attempts, subagents, steering, worktree setup, plans, citations, T3 tools, diffs and the minimap.
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

import { ConversationView, ThreadStreamItem } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Result, Schema } from "effect";

import coding from "../../../judges/fixtures/transcripts/coding.json" with { type: "json" };
import interruptedFrames from "../../../judges/fixtures/transcripts/interrupted.frames.json" with { type: "json" };
import interrupted from "../../../judges/fixtures/transcripts/interrupted.json" with { type: "json" };
import streamingToolsFrames from "../../../judges/fixtures/transcripts/streaming-tools.frames.json" with { type: "json" };
import streamingFrames from "../../../judges/fixtures/transcripts/streaming.frames.json" with { type: "json" };
import thinking from "../../../judges/fixtures/transcripts/thinking.json" with { type: "json" };
import { applyThreadStreamItem } from "./ThreadView.ts";
import type { ThreadViewState } from "./ThreadView.ts";
import { formatDuration } from "./Time.ts";
import { entriesFromPi } from "./TimelineEntries.ts";
import type {
  Timeline,
  TimelineEntry,
  TimelineMessage,
  TimelineTurn,
  TurnStatus,
  WorkEntry,
} from "./TimelineEntries.ts";
import { computeMessageDurationStart } from "./TimelineFolds.ts";
import {
  computeStableTimelineRows,
  deriveTimelineRows,
  deriveTimelineRowsCached,
  EMPTY_TURN_ROWS,
  EMPTY_STABLE_ROWS,
  resolveAssistantMessageCopyState,
  shouldCollapseUserMessage,
  workGroupId,
} from "./TimelineRows.ts";
import type {
  TimelineRow,
  TimelineRowsInput,
  TurnRowsCache,
} from "./TimelineRows.ts";

const at = (time: string) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-01-01T00:00:${time}Z`));

const TURN = "turn-1";

const messageOf = (
  id: string,
  role: "user" | "assistant",
  text: string,
  options: {
    readonly turnId?: string;
    readonly createdAt: string;
    readonly updatedAt?: string;
    readonly streaming?: boolean;
  }
): TimelineMessage => ({
  id,
  role,
  text,
  turnId: options.turnId ?? TURN,
  entryId: Option.none(),
  createdAt: at(options.createdAt),
  updatedAt: at(options.updatedAt ?? options.createdAt),
  streaming: options.streaming ?? false,
  attachments: [],
  attachmentNames: [],
  images: [],
  skills: [],
});

const message = (...args: Parameters<typeof messageOf>): TimelineEntry => {
  const value = messageOf(...args);

  return {
    kind: "message",
    id: value.id,
    createdAt: value.createdAt,
    message: value,
  };
};

const workOf = (
  id: string,
  createdAt: string,
  overrides: Partial<WorkEntry> = {}
): WorkEntry => ({
  id,
  kind: "tool",
  turnId: TURN,
  createdAt: at(createdAt),
  completedAt: Option.some(at(createdAt)),
  status: "completed",
  toolName: Option.some("bash"),
  action: "command",
  command: Option.none(),
  changedFiles: [],
  readPaths: [],
  detail: Option.none(),
  output: Option.none(),
  source: Option.none(),
  nestedCalls: [],
  ...overrides,
});

const work = (
  id: string,
  createdAt: string,
  overrides: Partial<WorkEntry> = {}
): TimelineEntry => {
  const entry = workOf(id, createdAt, overrides);

  return { kind: "work", id, createdAt: entry.createdAt, entry };
};

const turn = (
  id: string,
  startedAt: string,
  endedAt: string | undefined,
  status: TurnStatus
): TimelineTurn => ({
  id,
  userEntryId: Option.none(),
  startedAt: at(startedAt),
  endedAt: endedAt === undefined ? Option.none() : Option.some(at(endedAt)),
  status,
  error: Option.none(),
});

const timelineOf = (
  entries: ReadonlyArray<TimelineEntry>,
  options: {
    readonly turns?: ReadonlyArray<TimelineTurn>;
    readonly working?: boolean;
    readonly startedAt?: string;
  } = {}
): Timeline => ({
  entries,
  turns: options.turns ?? [],
  isWorking: options.working ?? false,
  activeTurnId: options.working === true ? Option.some(TURN) : Option.none(),
  activeTurnStartedAt:
    options.working === true
      ? Option.some(at(options.startedAt ?? "00"))
      : Option.none(),
});

/** The rows of `timeline`, checked against the per-turn cached derivation on the way. */
const rowsOf = (
  timeline: Timeline,
  options: Partial<Omit<TimelineRowsInput, "timeline">> = {}
): ReadonlyArray<TimelineRow> => {
  const input = {
    timeline,
    expandedTurnIds: options.expandedTurnIds ?? new Set<string>(),
    expandedWorkGroupIds: options.expandedWorkGroupIds ?? new Set<string>(),
    workspaceRoot: options.workspaceRoot ?? Option.none(),
  };

  const rows = deriveTimelineRows(input);

  assert.deepStrictEqual(
    deriveTimelineRowsCached(input, EMPTY_TURN_ROWS).rows,
    rows
  );

  return rows;
};

const ids = (rows: ReadonlyArray<TimelineRow>) => rows.map((row) => row.id);

const deriveRows = (
  status: WorkEntry["status"] | null,
  expandedWorkGroupIds: ReadonlySet<string> = new Set()
) =>
  rowsOf(
    timelineOf(
      status === null
        ? []
        : [
            work("latest-command-entry", "05", {
              command: Option.some("rg toolCall"),
              status,
            }),
          ],
      { turns: [turn(TURN, "00", undefined, "running")], working: true }
    ),
    { expandedWorkGroupIds }
  );

const activity = (rows: ReadonlyArray<TimelineRow>) =>
  rows.find((row) => row.id === "live-activity-row");

describe(computeMessageDurationStart, () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      messageOf("a1", "assistant", "Hello", {
        createdAt: "05",
        updatedAt: "06",
      }),
    ]);

    assert.deepStrictEqual([...result], [["a1", at("05")]]);
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      messageOf("u1", "user", "Hi", { createdAt: "00" }),
      messageOf("a1", "assistant", "Hello", {
        createdAt: "30",
        updatedAt: "31",
      }),
    ]);

    assert.strictEqual(result.get("a1"), at("00"));
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      messageOf("u1", "user", "Hi", { createdAt: "00" }),
      messageOf("a1", "assistant", "First", {
        createdAt: "30",
        updatedAt: "31",
      }),
      messageOf("a2", "assistant", "Second", {
        createdAt: "55",
        updatedAt: "56",
      }),
    ]);

    assert.strictEqual(result.get("a2"), at("31"));
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      messageOf("u1", "user", "Hi", { createdAt: "00" }),
      messageOf("a1", "assistant", "First", {
        createdAt: "30",
        updatedAt: "31",
        streaming: true,
      }),
      messageOf("a2", "assistant", "Second", {
        createdAt: "55",
        updatedAt: "56",
      }),
    ]);

    assert.strictEqual(result.get("a2"), at("00"));
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      messageOf("u1", "user", "First", { createdAt: "00" }),
      messageOf("a1", "assistant", "Reply", {
        createdAt: "30",
        updatedAt: "31",
      }),
      messageOf("u2", "user", "Second", { createdAt: "40" }),
      messageOf("a2", "assistant", "Reply 2", {
        createdAt: "50",
        updatedAt: "51",
      }),
    ]);

    assert.strictEqual(result.get("a2"), at("40"));
  });

  it("returns an empty map for empty input", () => {
    assert.strictEqual(computeMessageDurationStart([]).size, 0);
  });
});

describe(formatDuration, () => {
  it("formats like t3code", () => {
    assert.deepStrictEqual(
      [450, 4200, 9990, 22_000, 59_500, 61_000, 3_725_000].map(formatDuration),
      ["450ms", "4.2s", "10s", "22s", "1m", "1m 1s", "1h 2m 5s"]
    );
  });
});

describe(resolveAssistantMessageCopyState, () => {
  it("returns enabled copy state for completed assistant messages", () => {
    assert.deepStrictEqual(
      resolveAssistantMessageCopyState({
        text: "Ship it",
        showCopyButton: true,
        streaming: false,
      }),
      { text: Option.some("Ship it"), visible: true }
    );
  });

  it("hides copy while an assistant message is still streaming", () => {
    assert.isFalse(
      resolveAssistantMessageCopyState({
        text: "Ship it",
        showCopyButton: true,
        streaming: true,
      }).visible
    );
  });

  it("hides copy for empty completed assistant messages", () => {
    assert.deepStrictEqual(
      resolveAssistantMessageCopyState({
        text: "  ",
        showCopyButton: true,
        streaming: false,
      }),
      { text: Option.none(), visible: false }
    );
  });

  it("hides copy for non-terminal assistant messages", () => {
    assert.isFalse(
      resolveAssistantMessageCopyState({
        text: "Ship it",
        showCopyButton: false,
        streaming: false,
      }).visible
    );
  });
});

describe(deriveTimelineRows, () => {
  it("folds the first assistant message and settled work before the terminal response", () => {
    const entries = [
      message("user-entry", "user", "Build it", { createdAt: "00" }),
      message("assistant-first-entry", "assistant", "Checklist", {
        createdAt: "05",
        updatedAt: "06",
      }),
      work("work-entry-1", "08"),
      message("assistant-final-entry", "assistant", "Done", {
        createdAt: "20",
        updatedAt: "22",
      }),
    ];

    const timeline = timelineOf(entries, {
      turns: [turn(TURN, "00", "22", "completed")],
    });

    const collapsed = rowsOf(timeline);
    const fold = collapsed.find((row) => row.kind === "turn-fold");

    assert.strictEqual(
      fold?.kind === "turn-fold" ? fold.label : "",
      "Worked for 22s"
    );
    // The fold counts the work it hides: the one bash call.
    assert.deepStrictEqual(fold?.kind === "turn-fold" ? fold.tally : [], [
      { count: 1, word: "command" },
    ]);
    assert.deepStrictEqual(ids(collapsed), [
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expanded = rowsOf(timeline, { expandedTurnIds: new Set([TURN]) });

    assert.deepStrictEqual(ids(expanded), [
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    assert.isTrue(
      expanded.some((row) => row.kind === "turn-fold" && row.expanded)
    );
  });

  it.each([1, 2, 3])(
    "folds %i completed activities after the terminal response",
    (count) => {
      const entries = [
        work("work-entry-before-text", "01", {
          kind: "reasoning",
          detail: Option.some("Plan"),
        }),
        message(
          "assistant-final-entry",
          "assistant",
          "CI is re-running. Waiting.",
          {
            createdAt: "05",
            updatedAt: "06",
          }
        ),
        ...Array.from({ length: count }, (_, index) =>
          work(`work-entry-after-text-${index}`, `0${index + 7}`)
        ),
      ];

      const turns = [turn(TURN, "00", "10", "completed")];
      const rows = rowsOf(timelineOf(entries, { turns }));

      assert.deepStrictEqual(ids(rows), [
        "turn-fold:turn-1",
        "assistant-final-entry",
      ]);

      const expanded = rowsOf(timelineOf(entries, { turns }), {
        expandedTurnIds: new Set([TURN]),
      });

      assert.isTrue(
        expanded.some(
          (row) =>
            row.id === "work-entry-after-text-0" ||
            (row.kind === "work-toggle" &&
              row.id === "work-toggle:work-entry-after-text-0" &&
              row.hiddenCount === count)
        )
      );

      const failed = entries.map((entry) =>
        entry.kind === "work" && entry.id === "work-entry-after-text-0"
          ? { ...entry, entry: { ...entry.entry, status: "failed" as const } }
          : entry
      );

      assert.isTrue(
        rowsOf(timelineOf(failed, { turns })).some(
          (row) =>
            row.id === "work-entry-after-text-0" ||
            row.id === "work-toggle:work-entry-after-text-0"
        )
      );

      const pending = entries.map((entry) =>
        entry.kind === "work" && entry.id === "work-entry-after-text-0"
          ? {
              ...entry,
              entry: { ...entry.entry, status: "inProgress" as const },
            }
          : entry
      );

      const pendingRows = rowsOf(
        timelineOf(pending, {
          turns: [turn(TURN, "00", undefined, "running")],
          working: true,
        })
      );

      assert.isTrue(
        pendingRows.some(
          (row) =>
            row.kind === "work-live" &&
            row.entry.id === "work-entry-after-text-0"
        )
      );
    }
  );

  it("folds all assistant messages before the terminal message", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message(
            "assistant-first-entry",
            "assistant",
            "The main result is ready.",
            {
              createdAt: "01",
              updatedAt: "02",
            }
          ),
          message(
            "assistant-middle-entry",
            "assistant",
            "Checking one more detail.",
            {
              createdAt: "03",
              updatedAt: "04",
            }
          ),
          message(
            "assistant-final-entry",
            "assistant",
            "Verification finished.",
            {
              createdAt: "05",
              updatedAt: "06",
            }
          ),
        ],
        { turns: [turn(TURN, "00", "06", "completed")] }
      )
    );

    assert.deepStrictEqual(ids(rows), [
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);
  });

  it("uses the turn's timings and the stopped label for an interrupted turn", () => {
    const rows = rowsOf(
      timelineOf([work("work-entry-1", "05", { status: "stopped" })], {
        turns: [turn(TURN, "00", "47", "interrupted")],
      })
    );

    assert.deepStrictEqual(
      rows.map((row) =>
        row.kind === "turn-fold"
          ? [row.kind, row.label, row.expanded]
          : row.kind
      ),
      [["turn-fold", "You stopped after 47s", false]]
    );
  });

  it("does not fold the active in-progress turn", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message("assistant-thought-entry", "assistant", "Working on it.", {
            createdAt: "05",
            updatedAt: "06",
          }),
          work("work-entry-1", "08", { status: "inProgress" }),
        ],
        { turns: [turn(TURN, "00", undefined, "running")], working: true }
      )
    );

    assert.isFalse(rows.some((row) => row.kind === "turn-fold"));
    assert.deepStrictEqual(ids(rows), [
      "working-indicator-row",
      "assistant-thought-entry",
      "live-activity-row",
    ]);
  });

  it("does not fold a failed turn and offers Retry on its error", () => {
    const failedTurn = {
      ...turn(TURN, "00", "09", "failed"),
      error: Option.some("Boom"),
    };

    const rows = rowsOf(
      timelineOf(
        [
          message("user-entry", "user", "Build it", { createdAt: "00" }),
          work("command-entry", "02"),
          message("assistant-entry", "assistant", "Trying.", {
            createdAt: "03",
          }),
          work("error-entry", "09", {
            kind: "error",
            status: "failed",
            detail: Option.some("Boom"),
          }),
        ],
        { turns: [failedTurn] }
      )
    );

    assert.deepStrictEqual(ids(rows), [
      "user-entry",
      "command-entry",
      "assistant-entry",
      "error-entry",
    ]);
    assert.isTrue(rows.some((row) => row.kind === "error" && row.retryable));
  });

  it("renders a single completed tool call directly", () => {
    const rows = rowsOf(
      timelineOf(
        [
          work("completed-command-entry", "05", {
            command: Option.some("rg toolCall"),
          }),
          message(
            "assistant-commentary-entry",
            "assistant",
            "Checking another thing.",
            {
              createdAt: "06",
            }
          ),
          work("running-command-entry", "07", {
            command: Option.some("vp test run"),
            status: "inProgress",
          }),
        ],
        { turns: [turn(TURN, "00", undefined, "running")], working: true }
      )
    );

    assert.deepStrictEqual(
      rows.map((row) => row.kind),
      ["working", "work", "message", "work-live"]
    );

    const single = rows.find((row) => row.kind === "work");

    assert.deepStrictEqual(
      single?.kind === "work"
        ? [single.isExpandedToolGroup, single.displayLabel]
        : [],
      [false, Option.some("rg toolCall")]
    );
  });

  it("keeps separated in-progress tool runs visible", () => {
    const rows = rowsOf(
      timelineOf(
        [
          work("first-running-entry", "05", {
            command: Option.some("rg first"),
            status: "inProgress",
          }),
          message(
            "assistant-commentary-entry",
            "assistant",
            "Starting another command.",
            {
              createdAt: "06",
            }
          ),
          work("second-running-entry", "07", {
            command: Option.some("rg second"),
            status: "inProgress",
          }),
        ],
        { turns: [turn(TURN, "00", undefined, "running")], working: true }
      )
    );

    assert.deepStrictEqual(
      rows.map((row) => row.kind),
      ["working", "work-live", "message", "work-live"]
    );
    assert.deepStrictEqual(
      rows.flatMap((row) => (row.kind === "work-live" ? [row.entry.id] : [])),
      ["first-running-entry", "second-running-entry"]
    );
  });

  it("reuses one activity row for initial thinking and the latest tool", () => {
    const initial = deriveRows(null);
    const running = deriveRows("inProgress");
    const completed = deriveRows("completed");
    const failed = deriveRows("failed");

    assert.strictEqual(activity(initial)?.kind, "thinking");

    const runningRow = activity(running);
    const completedRow = activity(completed);

    assert.isTrue(runningRow?.kind === "work-live" && runningRow.active);
    assert.isTrue(completedRow?.kind === "work-live" && completedRow.active);
    assert.isFalse(failed.some((row) => row.kind === "work-live"));

    const failedThinking = failed.at(-1);

    assert.strictEqual(failedThinking?.id, "live-activity-row");

    const groupId =
      failedThinking?.kind === "thinking"
        ? Option.getOrNull(failedThinking.groupId)
        : null;

    assert.strictEqual(groupId, "work-group:latest-command-entry");

    const expandedFailed = deriveRows("failed", new Set([groupId ?? ""]));
    const [header, details] = expandedFailed.slice(-2);

    assert.isTrue(header?.kind === "thinking" && header.expanded);
    assert.isTrue(
      details?.kind === "work" &&
        details.isExpandedToolGroup &&
        details.groupedEntries[0]?.id === "latest-command-entry"
    );

    for (const rows of [initial, running, completed, failed]) {
      assert.strictEqual(
        rows.filter((row) => row.id === "live-activity-row").length,
        1
      );
    }
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message("assistant-thought-entry", "assistant", "Checking first.", {
            createdAt: "10",
            updatedAt: "11",
          }),
          message("assistant-final-entry", "assistant", "Done.", {
            createdAt: "20",
            updatedAt: "30",
          }),
        ],
        { turns: [turn(TURN, "00", "30", "completed")] }
      ),
      { expandedTurnIds: new Set([TURN]) }
    );

    assert.deepStrictEqual(
      rows.flatMap((row) =>
        row.kind === "message" && row.message.role === "assistant"
          ? [row.showAssistantMeta]
          : []
      ),
      [false, true]
    );
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message("assistant-thought-entry", "assistant", "Working on it.", {
            createdAt: "10",
            updatedAt: "11",
          }),
        ],
        { turns: [turn(TURN, "00", undefined, "running")], working: true }
      )
    );

    const assistant = rows.find((row) => row.kind === "message");

    assert.isTrue(
      assistant?.kind === "message" &&
        !assistant.showAssistantMeta &&
        !assistant.showAssistantCopyButton
    );
    assert.strictEqual(rows.at(-1)?.kind, "thinking");
  });

  it("expands tools through the same activity group", () => {
    const entries = [
      work("work-entry-1", "01", {
        toolName: Option.some("read"),
        action: "read",
      }),
      work("work-entry-2", "02", {
        toolName: Option.some("custom"),
        action: "other",
      }),
      work("work-entry-3", "03", {
        toolName: Option.some("other"),
        action: "other",
      }),
    ];

    const collapsed = rowsOf(timelineOf(entries));

    const expanded = rowsOf(timelineOf(entries), {
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    const toggle = collapsed.find((row) => row.kind === "work-toggle");

    assert.deepStrictEqual(ids(collapsed), ["work-toggle:work-entry-1"]);
    assert.isTrue(
      toggle?.kind === "work-toggle" &&
        toggle.groupId === "work-group:work-entry-1" &&
        toggle.hiddenCount === 3 &&
        !toggle.expanded &&
        toggle.summary === "Read 1 file and used 2 tools"
    );
    assert.deepStrictEqual(ids(expanded), [
      "work-toggle:work-entry-1",
      "work-group:work-entry-1:details",
    ]);

    const details = expanded.find((row) => row.kind === "work");

    assert.isTrue(details?.kind === "work" && details.isExpandedToolGroup);
    assert.deepStrictEqual(
      details?.kind === "work"
        ? details.groupedEntries.map((entry) => entry.id)
        : [],
      ["work-entry-1", "work-entry-2", "work-entry-3"]
    );
  });

  it("deduplicates integration sources ahead of ordinary actions", () => {
    const github = Option.some({ key: "executor:github", name: "github" });

    const rows = rowsOf(
      timelineOf([
        work("call-1", "01", {
          toolName: Option.some("codemode"),
          action: "other",
          source: github,
        }),
        work("call-2", "02", {
          toolName: Option.some("codemode"),
          action: "other",
          source: github,
        }),
        work("command", "03", { command: Option.some("git status") }),
      ])
    );

    const toggle = rows.find((row) => row.kind === "work-toggle");

    assert.strictEqual(
      toggle?.kind === "work-toggle" ? toggle.summary : "",
      "Used github integration and ran 1 command"
    );
  });

  it("moves an answer's metadata below its trailing tool group", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message("user-entry", "user", "Go", {
            createdAt: "00",
            turnId: TURN,
          }),
          message("answer", "assistant", "Done.", { createdAt: "05" }),
          work("trailing-1", "06", { status: "failed" }),
          work("trailing-2", "07", { status: "failed" }),
        ],
        { turns: [turn(TURN, "00", "07", "completed")] }
      )
    );

    assert.deepStrictEqual(ids(rows), [
      "user-entry",
      "answer",
      "work-toggle:trailing-1",
      "assistant-meta:answer",
    ]);
    assert.isTrue(rows[1]?.kind === "message" && !rows[1].showAssistantMeta);
  });

  it("marks consecutive work log rows as one block", () => {
    const rows = rowsOf(
      timelineOf(
        [
          work("a", "01", { command: Option.some("ls") }),
          work("b", "02", { command: Option.some("pwd") }),
          work("c", "03", {
            kind: "error",
            status: "failed",
            detail: Option.some("x"),
          }),
        ],
        { turns: [turn(TURN, "00", "03", "failed")] }
      ),
      { expandedWorkGroupIds: new Set(["work-group:a"]) }
    );

    assert.deepStrictEqual(
      rows.map((row) => [row.kind, row.continuesWorkLog]),
      [
        ["work-toggle", true],
        ["work", false],
        ["error", false],
      ]
    );
  });

  it("ends the working turn's live tail at an error row", () => {
    const rows = rowsOf(
      timelineOf(
        [
          work("a", "01", { command: Option.some("ls") }),
          work("b", "02", {
            kind: "error",
            status: "failed",
            detail: Option.some("x"),
          }),
        ],
        { turns: [turn(TURN, "00", undefined, "running")], working: true }
      )
    );

    assert.deepStrictEqual(
      rows.map((row) => [row.kind, row.continuesWorkLog]),
      [
        ["working", false],
        ["work", false],
        ["error", false],
        ["thinking", false],
      ]
    );
  });
});

const twoUsers = () =>
  rowsOf(
    timelineOf([
      message("entry-user-1", "user", "First", { createdAt: "00" }),
      message("entry-user-2", "user", "Second", { createdAt: "10" }),
    ])
  );

const twoWorkRows = () =>
  rowsOf(
    timelineOf([
      work("entry-work-1", "00", {
        kind: "reasoning",
        detail: Option.some("Inspecting repository state"),
      }),
      work("entry-work-2", "01", {
        toolName: Option.some("read"),
        action: "read",
      }),
    ])
  );

describe(computeStableTimelineRows, () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const initial = computeStableTimelineRows(twoUsers(), EMPTY_STABLE_ROWS);
    const repeated = computeStableTimelineRows(twoUsers(), initial);

    assert.strictEqual(repeated, initial);
    assert.strictEqual(repeated.result, initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const first = twoWorkRows();
    const initial = computeStableTimelineRows(first, EMPTY_STABLE_ROWS);
    const second = twoWorkRows();

    assert.notStrictEqual(second[0], first[0]);

    const repeated = computeStableTimelineRows(second, initial);

    assert.strictEqual(repeated, initial);
    assert.strictEqual(repeated.result[0], initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const first = twoUsers();
    const initial = computeStableTimelineRows(first, EMPTY_STABLE_ROWS);
    const [a, b] = first;

    if (a === undefined || b === undefined) {
      assert.fail("two rows expected");
    }

    const reordered = computeStableTimelineRows([b, a], initial);

    assert.notStrictEqual(reordered, initial);
    assert.strictEqual(reordered.result[0], initial.result[1]);
    assert.strictEqual(reordered.result[1], initial.result[0]);
  });

  it("keeps a settled row's identity while the live answer streams", () => {
    const base = [
      message("u", "user", "Hi", { createdAt: "00" }),
      work("tool", "01", { command: Option.some("ls") }),
    ];

    const streaming = (text: string) =>
      rowsOf(
        timelineOf(
          [
            ...base,
            message("msg:turn-1:0", "assistant", text, {
              createdAt: "02",
              streaming: true,
            }),
          ],
          { turns: [turn(TURN, "00", undefined, "running")], working: true }
        )
      );

    const first = computeStableTimelineRows(
      streaming("Hel"),
      EMPTY_STABLE_ROWS
    );

    const second = computeStableTimelineRows(streaming("Hello"), first);

    const userRow = (rows: typeof first) =>
      rows.result.find((row) => row.id === "u");

    const answerRow = (rows: typeof first) =>
      rows.result.find((row) => row.id === "msg:turn-1:0");

    assert.strictEqual(userRow(second), userRow(first));
    assert.notStrictEqual(answerRow(second), answerRow(first));
  });
});

describe(shouldCollapseUserMessage, () => {
  it("collapses past 8 lines or 600 visible characters", () => {
    assert.isFalse(shouldCollapseUserMessage("short"));
    assert.isTrue(shouldCollapseUserMessage("x".repeat(601)));
    assert.isTrue(
      shouldCollapseUserMessage(
        Array.from({ length: 9 }, () => "line").join("\n")
      )
    );
    assert.isFalse(shouldCollapseUserMessage("   "));
  });

  it("measures file links by their label", () => {
    const links = Array.from(
      { length: 8 },
      (_, index) =>
        `[file${index}.ts](/workspace/projects/example/packages/some/deeply/nested/directory/file${index}.ts)`
    );

    const text = `Compare ${links.join(", ")}.`;

    assert.isAbove(text.length, 600);
    assert.isFalse(shouldCollapseUserMessage(text));
  });
});

const checkpoint = (
  entryId: string,
  turnId: string,
  files: number
): TimelineEntry => ({
  kind: "checkpoint",
  id: `checkpoint:${entryId}`,
  createdAt: at("05"),
  turnId,
  ref: `refs/cairn/checkpoints/t/turn/1`,
  turn: 1,
  files: Array.from({ length: files }, (_, index) => ({
    path: `src/file-${String(index)}.ts`,
    additions: 1,
    deletions: 0,
  })),
  moreFiles: 0,
});

describe("changed-files rows", () => {
  it("places a turn's card after its answer and before the next turn's prompt", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message("u1", "user", "First", { turnId: "turn-a", createdAt: "00" }),
          message("a1", "assistant", "Done", {
            turnId: "turn-a",
            createdAt: "02",
          }),
          message("u2", "user", "Second", {
            turnId: "turn-b",
            createdAt: "10",
          }),
          checkpoint("9", "turn-a", 2),
        ],
        {
          turns: [
            turn("turn-a", "00", "02", "completed"),
            turn("turn-b", "10", "12", "completed"),
          ],
        }
      )
    );

    const order = ids(rows);

    assert.isAbove(order.indexOf("checkpoint:9"), order.indexOf("a1"));
    assert.isBelow(order.indexOf("checkpoint:9"), order.indexOf("u2"));
  });

  it("makes no row for a checkpoint that lists nothing", () => {
    const rows = rowsOf(
      timelineOf(
        [
          message("u1", "user", "First", { turnId: "turn-a", createdAt: "00" }),
          checkpoint("9", "turn-a", 0),
        ],
        { turns: [turn("turn-a", "00", "02", "completed")] }
      )
    );

    assert.notInclude(ids(rows), "checkpoint:9");
  });
});

describe(deriveTimelineRowsCached, () => {
  const decodeFrames = Schema.decodeUnknownSync(Schema.Array(ThreadStreamItem));

  const decodeView = Schema.decodeUnknownSync(ConversationView);

  /** Every recorded run as the client sees it, one view per frame; whole transcripts are one frame. */
  const recorded: ReadonlyArray<ReadonlyArray<ThreadViewState["view"]>> = [
    ...[streamingFrames, streamingToolsFrames, interruptedFrames].map(
      (frames) => {
        let state = Option.none<ThreadViewState>();

        return decodeFrames(frames).flatMap((item) => {
          const next = applyThreadStreamItem(state, item);

          if (Result.isFailure(next)) {
            return [];
          }

          state = Option.some(next.success);

          return [next.success.view];
        });
      }
    ),
    [decodeView(coding)],
    [decodeView(thinking)],
    [decodeView(interrupted)],
  ];

  it("derives the same rows as the whole derivation on every recorded frame, folded or opened", () => {
    for (const views of recorded) {
      for (const open of [false, true]) {
        let cache = EMPTY_TURN_ROWS;

        for (const view of views) {
          const timeline = entriesFromPi(view);

          const input = {
            timeline,
            expandedTurnIds: new Set(
              open ? timeline.turns.map(({ id }) => id) : []
            ),
            expandedWorkGroupIds: new Set(
              open ? timeline.entries.map((entry) => workGroupId(entry.id)) : []
            ),
            workspaceRoot: Option.some("/home/owner/project"),
          };

          const derived = deriveTimelineRowsCached(input, cache);

          ({ cache } = derived);
          assert.deepStrictEqual(derived.rows, deriveTimelineRows(input));
        }
      }
    }
  });

  it("hands back a settled turn's rows unchanged while only the last turn streams", () => {
    const [views = []] = recorded;
    const first = views.at(0);
    const last = views.at(-1);

    assert.isDefined(first);
    assert.isDefined(last);

    // Two turns of history in front: the recorded transcript, then the streaming run's frames.
    const older = decodeView(coding).entries;

    // The caller keeps the toggles' sets while they do not change, as the web app's memo does.
    const closed = new Set<string>();

    const derive = (view: ThreadViewState["view"], cache: TurnRowsCache) =>
      deriveTimelineRowsCached(
        {
          timeline: entriesFromPi(view, older),
          expandedTurnIds: closed,
          expandedWorkGroupIds: closed,
          workspaceRoot: Option.none(),
        },
        cache
      );

    const before = derive(first ?? decodeView(coding), EMPTY_TURN_ROWS);
    const after = derive(last ?? decodeView(coding), before.cache);

    const settled = [...before.cache.keys()];

    assert.isAbove(settled.length, 0);
    assert.isTrue(
      settled.every(
        (turnId) =>
          before.cache.get(turnId)?.rows === after.cache.get(turnId)?.rows
      )
    );
  });
});
