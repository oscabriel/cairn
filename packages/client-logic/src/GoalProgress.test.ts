// A goal's progress line, its row tally, and the strip's chips and evidence (briefs note section 3),
// over plain JSON documents as the thread stream carries them.

import { RunId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import { RoleSpec } from "@cairn/protocol/Roles";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";

import {
  criterionStateLabel,
  evidenceLines,
  goalOf,
  goalProgress,
  goalTallyOf,
  goalTallyShort,
  goalTallyState,
  goalTallyText,
  isGoal,
  judgeChip,
  judgeWarning,
} from "./GoalProgress.ts";
import type { ProgressRow } from "./GoalProgress.ts";
import { approvalRecordsOf } from "./PendingRequests.ts";
import { asking, rowId, shellRow } from "./ShellRowTestKit.ts";

type Json = Schema.Json;

const verdictJson = (ok: boolean, runId: string): Json => ({
  at: 20,
  ok,
  judge: {
    kind: "command",
    argv: ["npm", "test"],
    expectExit: 0,
    timeoutSec: 60,
  },
  evidence: {
    exit: ok ? 0 : 1,
    tail: ok ? "12 passed" : "3 failed",
    sha: "0123456789abcdef0123",
    model: null,
    note: null,
  },
  runId,
});

const criterionJson = (
  id: string,
  state: string,
  verdict: Json = null
): Json => ({
  id,
  text: `Criterion ${id}`,
  judge: {
    kind: "command",
    argv: ["npm", "test"],
    expectExit: 0,
    timeoutSec: 60,
  },
  state,
  verdict,
  tries: verdict === null ? 0 : 1,
  changedAt: 10,
});

const goalJson = (criteria: ReadonlyArray<Json>): Json => ({
  objective: "Ship the parser",
  criteria: [...criteria],
  envelope: null,
  closedAt: null,
  closedBy: null,
});

const recordJson = (id: string, kind: string, status: string): Json => ({
  id,
  toolTaskId: 1,
  tool: kind === "brief" ? "subagent_spawn" : "goal_criteria",
  kind,
  summary: id,
  status,
  askedAt: 1000,
  expiresAt: 9000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  payload: null,
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
});

const GOAL_THREAD = rowId(1);

const childOf = (
  n: number,
  parent: ThreadId,
  overrides: Partial<ProgressRow> = {}
): ProgressRow => ({
  ...shellRow(n),
  lineage: Option.some({
    parentThreadId: parent,
    relationshipToParent: "subagent",
    rootThreadId: GOAL_THREAD,
  }),
  ...overrides,
});

const running: Partial<ProgressRow> = {
  activity: "running",
  activeRunId: Option.some(RunId.make(1)),
};

describe("a goal's progress", () => {
  it("says criteria met, children working and asking, and briefs waiting for Go", () => {
    const goal = goalOf(
      goalJson([
        criterionJson("c1", "met", verdictJson(true, "judge-1")),
        criterionJson("c2", "met", verdictJson(true, "judge-2")),
        criterionJson("c3", "failed", verdictJson(false, "judge-3")),
        criterionJson("c4", "open"),
      ])
    );

    const rows: ReadonlyArray<ProgressRow> = [
      shellRow(1),
      childOf(2, GOAL_THREAD, running),
      childOf(3, rowId(2), running),
      childOf(4, GOAL_THREAD, asking("call-9")),
      childOf(5, GOAL_THREAD),
      // Another thread's child counts for that thread, not this goal.
      childOf(6, rowId(7), running),
    ];

    const records = approvalRecordsOf({
      items: {
        a: recordJson("brief-1", "brief", "pending"),
        b: recordJson("brief-2", "brief", "accepted"),
        c: recordJson("call-3", "criteria", "pending"),
      },
    });

    const progress = goalProgress(GOAL_THREAD, goal, rows, records);

    assert.strictEqual(
      progress.line,
      "2 of 4 criteria met, 1 not met, 2 subagents working, 1 subagent asking, 1 brief waiting for Go, 1 criteria proposal waiting for you"
    );
    assert.deepStrictEqual(progress.criteria, {
      total: 4,
      met: 2,
      failed: 1,
      open: 1,
    });
  });

  it("says when a thread has no criteria yet, and is not a goal then", () => {
    const goal = goalOf(goalJson([]));

    assert.strictEqual(
      goalProgress(GOAL_THREAD, goal, [], []).line,
      "No criteria yet"
    );
    assert.isFalse(isGoal(goal));
    assert.isTrue(Option.isNone(goalTallyOf(goal)));
    assert.isFalse(isGoal(goalOf(null)));
  });

  it("counts the row's tally from the criteria", () => {
    const goal = goalOf(
      goalJson([
        criterionJson("c1", "met", verdictJson(true, "judge-1")),
        criterionJson("c2", "failed", verdictJson(false, "judge-2")),
        criterionJson("c3", "open"),
      ])
    );

    assert.isTrue(isGoal(goal));
    assert.deepStrictEqual(
      goalTallyOf(goal),
      Option.some({ total: 3, met: 1, failed: 1 })
    );
  });

  it("reads a document it cannot decode as no goal", () => {
    assert.isTrue(Option.isNone(goalOf({ objective: 3 })));
  });
});

/** Whether a command judge of `argv` is warned as deciding nothing. */
const warned = (argv: ReadonlyArray<string>, expectExit = 0) =>
  Option.isSome(
    judgeWarning({
      kind: "command",
      argv: [argv[0] ?? "", ...argv.slice(1)],
      expectExit,
      timeoutSec: 60,
    })
  );

describe("the goal chip's words", () => {
  it("counts met criteria, says the failed ones, and sums the goal's state", () => {
    const open = { total: 4, met: 2, failed: 0 };
    const failing = { total: 4, met: 2, failed: 1 };
    const done = { total: 3, met: 3, failed: 0 };

    assert.strictEqual(goalTallyText(open), "2 of 4 met");
    assert.strictEqual(goalTallyText(failing), "2 of 4 met, 1 not met");
    assert.strictEqual(goalTallyShort(failing), "2/4 met");
    assert.deepStrictEqual([open, failing, done].map(goalTallyState), [
      "open",
      "failed",
      "met",
    ]);
  });
});

describe("the strip's chips and evidence", () => {
  it("names each judge, a command's argv whole", () => {
    assert.deepStrictEqual(
      [
        judgeChip({
          kind: "command",
          argv: ["pnpm", "vitest", "run", "src/parser.test.ts"],
          expectExit: 0,
          timeoutSec: 60,
        }),
        judgeChip({
          kind: "command",
          argv: ["grep", "-q", "TODO", "x"],
          expectExit: 1,
          timeoutSec: 60,
        }),
        judgeChip({ kind: "user" }),
        judgeChip({
          kind: "model",
          spec: RoleSpec.make("@judge"),
          rubric: "clear",
        }),
      ],
      [
        "Command: pnpm vitest run src/parser.test.ts",
        "Command: grep -q TODO x (exit 1)",
        "You",
        "Model: @judge",
      ]
    );
  });

  it("warns that a judge which always passes decides nothing", () => {
    assert.deepStrictEqual(
      [
        warned(["true"]),
        warned([":"]),
        warned(["sh", "-c", "true"]),
        warned(["/bin/bash", "-c", "exit 0"]),
        warned(["echo", "done"]),
        warned(["sh", "-c", "echo ok"]),
        warned(["npm", "test"]),
        warned(["sh", "-c", "npm test && true"]),
        warned(["true"], 1),
      ],
      [true, true, true, true, true, true, false, false, false]
    );
    assert.isTrue(Option.isNone(judgeWarning({ kind: "user" })));
  });

  it("draws a state as mark and word", () => {
    assert.deepStrictEqual(
      (["met", "failed", "open"] as const).map(criterionStateLabel),
      [
        { glyph: "✓", word: "Met" },
        { glyph: "✗", word: "Not met" },
        { glyph: "○", word: "Open" },
      ]
    );
  });

  it("lists a verdict's evidence", () => {
    const goal = goalOf(
      goalJson([criterionJson("c1", "failed", verdictJson(false, "judge-4"))])
    );

    const verdict = Option.flatMap(goal, (found) =>
      Option.fromNullOr(found.criteria[0]?.verdict ?? null)
    );

    assert.deepStrictEqual(
      Option.map(verdict, evidenceLines),
      Option.some([
        "Did not pass (judge-4)",
        "Exit 1",
        "At 0123456789ab",
        "3 failed",
      ])
    );
  });
});
