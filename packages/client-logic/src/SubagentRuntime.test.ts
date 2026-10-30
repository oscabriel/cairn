// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/subagentDisplay.test.ts
// ("subagentGroupSummary", "subagentDetailPreview"), the plain subagent case of
// packages/client-runtime/src/state/subagentRuntime.test.ts ("leaves a plain subagent flat": its
// title) and apps/web/src/components/chat/V2LifecycleRow.logic.test.ts (a live child shows its live
// state, not the outcome a note reported earlier) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: a mixed group stays live while any member is, a settled group with a failed member says it
// failed, a single member's singular label, a live row previews its progress and a settled one its
// result, nothing previews nothing, and a child resumed since its note shows what it does now.
// Changed: Cairn's states (a brief waiting for Go, a started child's own shell row). Added: the
// tally's order, the group's span, linking spawn calls to their briefs newest first, every state a
// row takes, and the way back from a child's `cairn.child` document. Not ported: model labels,
// workspaces and workflow members (5E's `WorkflowSteps.test.ts`).
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

import { ConversationId, EntryId, RunId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import type { Entry } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";

import { asking, rowId, shellRow } from "./ShellRowTestKit.ts";
import type { SubagentRequest } from "./SubagentRollup.ts";
import type { SubagentState } from "./SubagentRuntime.ts";
import {
  formatSubagentDisplayTitle,
  isActiveSubagentState,
  isTerminalSubagentState,
  parentThreadIdOf,
  spawnCallsOf,
  subagentDetailPreview,
  subagentGroupSummary,
  subagentGroupTiming,
  subagentLinksOf,
  subagentRowContextOf,
  subagentRowOf,
  summarizeSubagentStates,
} from "./SubagentRuntime.ts";

type Json = Schema.Json;

const PARENT = rowId(1);

const CHILD_A = rowId(11);

const CHILD_B = rowId(12);

let nextEntry = 1;

const entry = (kind: string, fields: Partial<Entry> = {}): Entry => {
  const id = nextEntry;

  nextEntry += 1;

  return {
    id: EntryId.make(id),
    conversationId: ConversationId.make(1),
    kind,
    ...fields,
  };
};

/** An assistant message calling `subagent_spawn` once per description, at `timestamp`. */
const spawning = (
  timestamp: number,
  calls: ReadonlyArray<readonly [id: string, description: string]>
): Entry =>
  entry("pi.assistant", {
    model: [
      {
        role: "assistant",
        content: calls.map(([id, description]) => ({
          type: "toolCall",
          id,
          name: "subagent_spawn",
          arguments: { description, brief: `Do: ${description}` },
        })),
        timestamp,
      },
    ],
  });

const result = (toolCallId: string, isError = false): Entry =>
  entry("pi.tool-result", {
    model: [
      {
        role: "toolResult",
        toolCallId,
        toolName: "subagent_spawn",
        content: [
          { type: "text", text: "The brief is waiting for the user's Go." },
        ],
        isError,
        timestamp: 0,
      },
    ],
  });

const note = (
  child: string,
  seq: number,
  outcome: "completed" | "failed" | "stopped",
  summary: string,
  error: string | null = null
): Entry =>
  entry("cairn.subagent-result", {
    data: { subagent: child, seq, outcome, summary, error },
  });

/** The parent's answer to brief `briefId`, as a note or as the input entry the server wrote. */
const answer = (briefId: string, started: boolean, text: string): Entry =>
  entry("cairn.brief-answer", {
    data: started
      ? { briefId, decision: "accept", started, childThreadId: CHILD_A }
      : { briefId, decision: "accepted", started },
    model: [
      { role: "user", content: [{ type: "text", text }], timestamp: 3000 },
    ],
  });

const brief = (fields: { readonly [key: string]: Json }): Json => ({
  id: "call-1",
  toolTaskId: 1,
  tool: "subagent_spawn",
  kind: "brief",
  summary: "Count the files",
  status: "pending",
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
  ...fields,
});

const items = (...records: ReadonlyArray<Json>): Json => ({
  items: Object.fromEntries(
    records.map((record, index) => [`r${String(index)}`, record])
  ),
});

const registryItem = (fields: { readonly [key: string]: Json }): Json => ({
  threadId: CHILD_A,
  conversationId: 2,
  anchorTaskId: 7,
  briefApprovalId: "call-1",
  description: "Count the files",
  dispatch: { spec: null, resolved: null, previewed: null, dispatchedAt: 2000 },
  isolation: "shared",
  worktree: null,
  status: "working",
  wake: "answer",
  settlements: [],
  runs: [],
  delivered: 0,
  questions: {},
  inputs: {},
  ...fields,
});

/** A child's registry item settled once, with `outcome`. */
const settled = (outcome: "completed" | "failed" | "stopped"): Json =>
  registryItem({
    status: "settled",
    settlements: [
      { seq: 1, outcome, answerEntry: 9, reportedAt: 6000, inputs: [] },
    ],
    delivered: 1,
  });

const NO_ROWS = subagentRowContextOf(new Map(), new Map());

const contextWith = (
  rows: ReadonlyArray<ThreadShell>,
  requests: ReadonlyArray<readonly [ThreadId, SubagentRequest]> = []
) =>
  subagentRowContextOf(
    new Map(rows.map((row) => [row.id, row] as const)),
    new Map(requests)
  );

/** The one row of a parent that spawned "Count the files" (call `c1`, brief `call-1`). */
const onlyRow = (
  briefFields: { readonly [key: string]: Json },
  registry: ReadonlyArray<Json> = [],
  extraEntries: ReadonlyArray<Entry> = [],
  context = NO_ROWS
) => {
  const links = subagentLinksOf({
    entries: [
      spawning(1000, [["c1", "Count the files"]]),
      result("c1"),
      ...extraEntries,
    ],
    docs: {
      "cairn.approvals": items(brief(briefFields)),
      "cairn.subagents": items(...registry),
    },
  });

  assert.strictEqual(links.length, 1);

  const [link] = links;

  if (link === undefined) {
    throw new Error("no link");
  }

  return subagentRowOf(link, context);
};

describe(subagentGroupSummary, () => {
  it.each(["go", "working", "asking-parent"] as const)(
    "keeps a mixed group live while a member is %s",
    (state) => {
      assert.deepStrictEqual(
        subagentGroupSummary([{ state: "done" }, { state }]),
        { label: "2 subagents", active: true, failed: false }
      );
    }
  );

  it("settles the label without disguising a failed member as success", () => {
    const states: ReadonlyArray<SubagentState> = [
      "done",
      "failed",
      "stopped",
      "declined",
    ];

    assert.deepStrictEqual(
      subagentGroupSummary(states.map((state) => ({ state }))),
      { label: "4 subagents", active: false, failed: true }
    );
  });

  it("uses a singular label for one member", () => {
    assert.deepStrictEqual(subagentGroupSummary([{ state: "stopped" }]), {
      label: "1 subagent",
      active: false,
      failed: false,
    });
  });
});

describe(summarizeSubagentStates, () => {
  it("counts each kind once, in a fixed order, and leaves out the empty ones", () => {
    assert.strictEqual(
      summarizeSubagentStates([
        "done",
        "working",
        "failed",
        "waiting",
        "go",
        "parked",
        "expired",
      ]),
      "1 need you · 2 working · 1 held · 1 done · 1 failed · 1 not started"
    );
    assert.strictEqual(summarizeSubagentStates([]), "");
  });
});

describe("the state sets", () => {
  it("splits every state into live or ended, never both", () => {
    const all: ReadonlyArray<SubagentState> = [
      "go",
      "declined",
      "expired",
      "cancelled",
      "unstarted",
      "approval",
      "input",
      "asking-parent",
      "working",
      "waiting",
      "parked",
      "limited",
      "done",
      "failed",
      "stopped",
    ];

    for (const state of all) {
      assert.notStrictEqual(
        isActiveSubagentState(state),
        isTerminalSubagentState(state)
      );
    }

    assert.deepStrictEqual(all.filter(isTerminalSubagentState), [
      "declined",
      "expired",
      "cancelled",
      "unstarted",
      "done",
      "failed",
      "stopped",
    ]);
  });
});

describe(subagentDetailPreview, () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = {
      progress: Option.some("Reading files"),
      result: Option.some("Found two\n  problems"),
    };

    assert.deepStrictEqual(
      subagentDetailPreview({ ...details, state: "working" }),
      Option.some("Reading files")
    );
    assert.deepStrictEqual(
      subagentDetailPreview({ ...details, state: "done" }),
      Option.some("Found two problems")
    );
    assert.deepStrictEqual(
      subagentDetailPreview({
        state: "failed",
        progress: Option.some("Last progress"),
        result: Option.some(" "),
      }),
      Option.some("Last progress")
    );
    assert.deepStrictEqual(
      subagentDetailPreview({
        state: "go",
        progress: Option.none(),
        result: Option.none(),
      }),
      Option.none()
    );
  });

  it("keeps a long result to 280 characters", () => {
    const preview = subagentDetailPreview({
      state: "done",
      result: Option.some("x".repeat(400)),
      progress: Option.none(),
    });

    assert.isTrue(
      Option.exists(
        preview,
        (text) => text.length === 281 && text.endsWith("…")
      )
    );
  });
});

describe(formatSubagentDisplayTitle, () => {
  it("drops a Subagent: prefix and cuts a long description at 80 characters", () => {
    assert.strictEqual(
      formatSubagentDisplayTitle("Subagent: Count the files"),
      "Count the files"
    );
    assert.strictEqual(formatSubagentDisplayTitle("  "), "Subagent");

    const long = formatSubagentDisplayTitle("x".repeat(100));

    assert.strictEqual(long.length, 80);
    assert.isTrue(long.endsWith("..."));
  });
});

describe(subagentGroupTiming, () => {
  it("spans the first start to the last end once every member ended", () => {
    assert.deepStrictEqual(
      subagentGroupTiming([
        {
          state: "done",
          startedAt: Option.some(2000),
          completedAt: Option.some(5000),
        },
        {
          state: "failed",
          startedAt: Option.some(1000),
          completedAt: Option.some(4000),
        },
      ]),
      { startedAt: Option.some(1000), completedAt: Option.some(5000) }
    );
  });

  it("has no end while a member is live or an end is unknown", () => {
    assert.deepStrictEqual(
      subagentGroupTiming([
        {
          state: "done",
          startedAt: Option.some(2000),
          completedAt: Option.some(5000),
        },
        {
          state: "working",
          startedAt: Option.some(1000),
          completedAt: Option.none(),
        },
      ]).completedAt,
      Option.none()
    );
    assert.deepStrictEqual(
      subagentGroupTiming([
        {
          state: "stopped",
          startedAt: Option.none(),
          completedAt: Option.none(),
        },
      ]),
      { startedAt: Option.none(), completedAt: Option.none() }
    );
  });
});

describe("spawn calls and their briefs", () => {
  it("reads each call with its description and whether its result came", () => {
    const calls = spawnCallsOf([
      spawning(1000, [
        ["c1", "  Count the files "],
        ["c2", "Read the README"],
      ]),
      result("c1"),
      result("c2", true),
      spawning(2000, [["c3", "List the docs"]]),
    ]);

    assert.deepStrictEqual(
      calls.map((call) => [
        call.callId,
        call.description,
        call.createdAt,
        call.result,
      ]),
      [
        ["c1", "Count the files", 1000, "ok"],
        ["c2", "Read the README", 1000, "error"],
        ["c3", "List the docs", 2000, "pending"],
      ]
    );
  });

  it("links newest first by description, skipping refusals and calls not asked yet", () => {
    const links = subagentLinksOf({
      entries: [
        // c0's brief is older than the loaded window's first brief: it pairs with nothing.
        spawning(500, [["c0", "Old work"]]),
        result("c0"),
        spawning(1000, [
          ["c1", "Count the files"],
          ["c2", "Count the files"],
          ["c3", "Refused one"],
        ]),
        result("c1"),
        result("c2"),
        result("c3", true),
        spawning(2000, [["c4", "Not asked yet"]]),
      ],
      docs: {
        "cairn.approvals": items(
          // One step's calls ask in the same instant; their tool tasks order them, not their ids.
          brief({ id: "call-10", toolTaskId: 10, askedAt: 1001 }),
          brief({ id: "call-9", toolTaskId: 9, askedAt: 1001 }),
          // A workflow node's brief is not a spawn's.
          brief({
            id: "wf-1",
            tool: "agent",
            summary: "Not asked yet",
            askedAt: 2001,
          }),
          // A brief whose call is still live: no committed call names it.
          brief({ id: "call-9", summary: "Streaming call", askedAt: 3000 })
        ),
      },
    });

    assert.deepStrictEqual(
      links.map(({ call, brief: record }) => [call.callId, record.id]),
      [
        ["c1", "call-9"],
        ["c2", "call-10"],
      ]
    );
  });

  it("reads the way back from a child's cairn.child document only", () => {
    assert.deepStrictEqual(
      parentThreadIdOf({
        "cairn.child": {
          key: "call-1",
          parentThreadId: PARENT,
          parentConversationId: 1,
          rootThreadId: PARENT,
          depth: 1,
        },
      }),
      Option.some(PARENT)
    );
    assert.deepStrictEqual(parentThreadIdOf({}), Option.none());
  });
});

describe("a child's row", () => {
  it("waits for Go before any child, with no link", () => {
    const row = onlyRow({});

    assert.strictEqual(row.state, "go");
    assert.strictEqual(row.label.word, "Waiting for Go");
    assert.strictEqual(row.title, "Count the files");
    assert.deepStrictEqual(row.childThreadId, Option.none());
  });

  it.each([
    ["declined", "Declined"],
    ["expired", "Expired"],
    ["cancelled", "Cancelled"],
  ] as const)("ends %s without a child when its brief does", (status, word) => {
    const row = onlyRow({ status, answeredAt: 1500 });

    assert.strictEqual(row.label.word, word);
    assert.isTrue(isTerminalSubagentState(row.state));
    assert.deepStrictEqual(row.completedAt, Option.some(1500));
  });

  it("reads a started child's live state from its own shell row", () => {
    const started = {
      status: "accepted",
      started: { childThreadId: CHILD_A },
    };

    const registry = [registryItem({})];

    const cases: ReadonlyArray<readonly [Partial<ThreadShell>, SubagentState]> =
      [
        [
          { activity: "running", activeRunId: Option.some(RunId.make(3)) },
          "working",
        ],
        [asking("q-1"), "input"],
        [{ waitingFor: "parent", activity: "waiting" }, "asking-parent"],
        [{ activity: "failed", lastError: Option.some("boom") }, "failed"],
        [
          { activity: "failed", lastErrorClass: Option.some("usage_limit") },
          "limited",
        ],
        [{ activity: "parked" }, "parked"],
      ];

    for (const [fields, state] of cases) {
      const row = onlyRow(
        started,
        registry,
        [],
        contextWith([shellRow(11, fields)])
      );

      assert.strictEqual(row.state, state, JSON.stringify(fields));
      assert.deepStrictEqual(row.childThreadId, Option.some(CHILD_A));
      assert.deepStrictEqual(row.startedAt, Option.some(2000));
    }
  });

  it("shows a grandchild's approval on the child's row", () => {
    const row = onlyRow(
      { status: "accepted", started: { childThreadId: CHILD_A } },
      [registryItem({})],
      [],
      contextWith([shellRow(11, { activity: "idle" })], [[CHILD_A, "approval"]])
    );

    assert.strictEqual(row.state, "approval");
    assert.strictEqual(row.label.word, "Approval");
  });

  it("reads a resting child by its latest settlement, and its note as the detail", () => {
    const done = onlyRow(
      { status: "accepted" },
      [settled("completed")],
      [note(CHILD_A, 1, "completed", "There are\n3 files.")],
      contextWith([shellRow(11)])
    );

    assert.strictEqual(done.state, "done");
    assert.strictEqual(done.label.word, "Done");
    assert.deepStrictEqual(done.detail, Option.some("There are 3 files."));
    assert.deepStrictEqual(done.completedAt, Option.some(6000));

    const failed = onlyRow(
      { status: "accepted" },
      [settled("failed")],
      [note(CHILD_A, 1, "failed", "not reported", "The model failed.")],
      contextWith([shellRow(11)])
    );

    assert.strictEqual(failed.state, "failed");
    assert.deepStrictEqual(failed.detail, Option.some("The model failed."));

    const stopped = onlyRow(
      { status: "accepted" },
      [settled("stopped")],
      [],
      contextWith([shellRow(11)])
    );

    assert.strictEqual(stopped.label.word, "Stopped");
  });

  it("shows what a child does now once it is sent more after its note", () => {
    const row = onlyRow(
      { status: "accepted" },
      [
        registryItem({
          status: "working",
          settlements: [
            {
              seq: 1,
              outcome: "completed",
              answerEntry: 9,
              reportedAt: 6000,
              inputs: [],
            },
          ],
          delivered: 1,
        }),
      ],
      [note(CHILD_A, 1, "completed", "Counted 3 files.")],
      contextWith([
        shellRow(11, {
          activity: "running",
          activeRunId: Option.some(RunId.make(4)),
        }),
      ])
    );

    assert.strictEqual(row.state, "working");
    assert.deepStrictEqual(row.completedAt, Option.none());
  });

  it("works while Go's start makes the child, and ends unstarted once the parent is told it started nothing", () => {
    const accepted = { status: "accepted", answeredAt: 1500 };
    const making = onlyRow(accepted);

    assert.strictEqual(making.state, "working");
    assert.isTrue(subagentGroupSummary([making]).active);

    const why =
      'The user approved the brief "Count the files", but a budget is reached, so nothing started: at its line';

    const row = onlyRow(accepted, [], [answer("call-1", false, why)]);

    assert.strictEqual(row.state, "unstarted");
    assert.strictEqual(row.label.word, "Not started");
    assert.strictEqual(row.label.tone, "error");
    assert.deepStrictEqual(row.childThreadId, Option.none());
    assert.deepStrictEqual(row.detail, Option.some(why));
    assert.deepStrictEqual(row.completedAt, Option.some(1500));

    // Told as a follow-up input (the parent was not halted), whose message carries one string.
    const input = answer("call-1", false, why);

    const told = onlyRow(
      accepted,
      [],
      [{ ...input, model: [{ role: "user", content: why, timestamp: 3000 }] }]
    );

    assert.strictEqual(told.state, "unstarted");
    assert.deepStrictEqual(told.detail, Option.some(why));
    assert.isTrue(isTerminalSubagentState(row.state));
    assert.strictEqual(summarizeSubagentStates([row.state]), "1 not started");
    assert.isFalse(subagentGroupSummary([row]).active);
    assert.deepStrictEqual(
      subagentGroupTiming([
        {
          state: row.state,
          startedAt: Option.some(1000),
          completedAt: row.completedAt,
        },
      ]).completedAt,
      Option.some(1500)
    );

    // Another brief's tell, and Go's own answer, leave it working.
    assert.strictEqual(
      onlyRow(accepted, [], [answer("call-2", false, "other")]).state,
      "working"
    );
    assert.strictEqual(
      onlyRow(accepted, [], [answer("call-1", true, "started")]).state,
      "working"
    );
  });

  it("falls back to the registry when the child's row is not in the shell", () => {
    assert.strictEqual(
      onlyRow({ status: "accepted" }, [registryItem({ status: "waiting" })])
        .state,
      "asking-parent"
    );
    assert.strictEqual(
      onlyRow({ status: "accepted" }, [registryItem({})]).state,
      "working"
    );
    assert.strictEqual(
      onlyRow({ status: "accepted", started: { childThreadId: CHILD_B } })
        .state,
      "working"
    );
  });

  it("keeps the newest note of each child", () => {
    const row = onlyRow(
      { status: "accepted" },
      [
        registryItem({
          status: "settled",
          settlements: [
            {
              seq: 1,
              outcome: "completed",
              answerEntry: 9,
              reportedAt: 6000,
              inputs: [],
            },
            {
              seq: 2,
              outcome: "completed",
              answerEntry: 12,
              reportedAt: 8000,
              inputs: [],
            },
          ],
          delivered: 2,
        }),
      ],
      [
        note(CHILD_A, 2, "completed", "Second answer"),
        note(CHILD_A, 1, "completed", "First answer"),
      ],
      contextWith([shellRow(11)])
    );

    assert.deepStrictEqual(row.detail, Option.some("Second answer"));
    assert.deepStrictEqual(row.completedAt, Option.some(8000));
  });
});
