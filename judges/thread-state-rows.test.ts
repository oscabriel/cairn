// Thread-state rows judge (phase 2 package 1E): every row of docs/golden/thread-states.md, in the
// status table and in "States without a status value", has a case here. A case either builds the
// shell rows the doc describes and checks that the one thread-state function (`threadState` in
// `@cairn/client-logic/ThreadState`) puts the thread in the doc's category with the label map's
// words, or checks the shelf the doc names, or says which surface other than a thread's row reads
// the state. The first test fails when the doc gains a row with no case or a case loses its row;
// the last proves the comparison fails on a doc whose category disagrees.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  sectionOf,
  partitionSidebarThreads,
} from "@cairn/client-logic/Sidebar";
import type { SidebarSection } from "@cairn/client-logic/Sidebar";
import {
  pendingSubagentRequests,
  sidebarRowThreadId,
  subagentRequestFor,
} from "@cairn/client-logic/SubagentRollup";
import { HOLD_LABELS, threadState } from "@cairn/client-logic/ThreadState";
import type {
  ThreadCategory,
  ThreadState,
} from "@cairn/client-logic/ThreadState";
import {
  ApprovalId,
  ProjectId,
  RunId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import type { RuntimeRequestKind } from "@cairn/protocol/Policy";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

const docPath = path.join(
  import.meta.dirname,
  "..",
  "docs",
  "golden",
  "thread-states.md"
);

const time = (iso: string) => DateTime.makeUnsafe(iso);

const NOW = time("2026-04-10T12:00:00.000Z");

const threadId = (n: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(n).padStart(4, "0")}`
  );

const base = ThreadShell.make({
  id: threadId(1),
  projectId: ProjectId.make("prj_1"),
  title: "A thread",
  provider: "opencode-go",
  modelId: "small",
  thinkingLevel: "off",
  runtimeMode: "full-access",
  branch: Option.none(),
  worktreePath: Option.none(),
  activity: "idle",
  activeRunId: Option.none(),
  latestRunRequestedAt: Option.none(),
  latestRunStartedAt: Option.none(),
  latestRunCompletedAt: Option.none(),
  queueLength: 0,
  lastError: Option.none(),
  lastErrorClass: Option.none(),
  usageLimitResetAt: Option.none(),
  waitingFor: "none",
  pendingRuntimeRequest: Option.none(),
  latestVisibleMessage: Option.none(),
  latestUserMessageAt: Option.none(),
  createdAt: time("2026-04-10T08:00:00Z"),
  updatedAt: time("2026-04-10T08:00:00Z"),
  archivedAt: Option.none(),
  settledOverride: Option.none(),
  settledAt: Option.none(),
  unsettledAt: Option.none(),
  snoozedUntil: Option.none(),
  snoozedAt: Option.none(),
  pinnedAt: Option.none(),
  pinOrderKey: Option.none(),
  activeOrderKey: Option.none(),
  autoSettleDisabledAt: Option.none(),
  lastVisitedAt: Option.none(),
  parkedTaskIds: [],
  ...BARE_ROW_FIELDS,
});

const running: ThreadShell = {
  ...base,
  activity: "running",
  activeRunId: Option.some(RunId.make(1)),
};

const asking = (
  kind: RuntimeRequestKind,
  origin: Option.Option<ThreadId> = Option.none()
): ThreadShell => {
  // A run holds every request but a brief and criteria, which leave the row idle (invariant 1).
  const heldByRun = kind !== "brief" && kind !== "criteria";

  const host: ThreadShell = heldByRun
    ? { ...running, activity: "waiting" }
    : base;

  return {
    ...host,
    pendingRuntimeRequest: Option.some({
      id: ApprovalId.make("apr_1"),
      kind,
      createdAt: time("2026-04-10T11:00:00Z"),
      origin,
    }),
  };
};

const failed = (errorClass: ThreadShell["lastErrorClass"]): ThreadShell => ({
  ...base,
  activity: "failed",
  lastError: Option.some("The run failed. Send again to retry."),
  lastErrorClass: errorClass,
  latestRunCompletedAt: Option.some(time("2026-04-10T11:00:00Z")),
  lastVisitedAt: Option.some(time("2026-04-10T11:30:00Z")),
});

const child = (overrides: Partial<ThreadShell> = {}): ThreadShell => ({
  ...running,
  id: threadId(2),
  lineage: Option.some({
    parentThreadId: base.id,
    relationshipToParent: "subagent",
    rootThreadId: base.id,
  }),
  ...overrides,
});

const tally = (counts: Partial<ThreadShell["subagents"]>): ThreadShell => ({
  ...base,
  subagents: { working: 0, asking: 0, settled: 0, failed: 0, ...counts },
});

/** What a case expects of the thread's state. */
interface Expect {
  /** The doc's category; checked against the row's. */
  readonly category?: ThreadCategory;
  /** Categories the thread must not be in, for a state the doc files as Ended. */
  readonly not?: ReadonlyArray<ThreadCategory>;
  /** The row's top label words; none for a row that shows its age. */
  readonly word?: Option.Option<string>;
  /** Whether the label map's cell for the row quotes `word` (false where it says "Not shown yet"). */
  readonly quoted?: boolean;
  /** The hold banner's badge word. */
  readonly hold?: string;
}

/** One doc row's case. */
type Case =
  | {
      readonly kind: "row";
      /** The thread whose state is read. */
      readonly thread: ThreadShell;
      /** Every row in the shell, for the rollup; the thread alone when absent. */
      readonly shell?: ReadonlyArray<ThreadShell>;
      readonly expect: Expect;
    }
  | { readonly kind: "shelf"; readonly check: () => void }
  | { readonly kind: "elsewhere"; readonly why: string };

const row = (
  thread: ThreadShell,
  expect: Expect,
  shell?: ReadonlyArray<ThreadShell>
): Case =>
  shell === undefined
    ? { kind: "row", thread, expect }
    : { kind: "row", thread, shell, expect };

const shelf = (thread: ThreadShell, section: SidebarSection): Case => ({
  kind: "shelf",
  check: () => {
    assert.strictEqual(sectionOf(thread, NOW), section);
  },
});

const elsewhere = (why: string): Case => ({ kind: "elsewhere", why });

const word = (text: string) => Option.some(text);

const ENDED: ReadonlyArray<ThreadCategory> = ["waiting-on-you", "held"];

const snoozedThenWoken: ThreadShell = {
  ...base,
  snoozedUntil: Option.some(time("2026-04-10T10:00:00Z")),
  snoozedAt: Option.some(time("2026-04-10T09:00:00Z")),
};

/** Every doc row, by `Schema value` for the status table and `state: Name` for the second table. */
const CASES = {
  "ThreadActivity idle": row(base, {
    category: "resting",
    word: Option.none(),
  }),
  "ThreadActivity preparing": row(
    { ...base, activity: "preparing" },
    { category: "active", word: word("Working") }
  ),
  "ThreadActivity running": row(running, {
    category: "active",
    word: word("Working"),
  }),
  "ThreadActivity waiting": row(asking("tool-call"), {
    category: "waiting-on-you",
    word: word("Approval"),
  }),
  "ThreadActivity parked": row(
    { ...running, activity: "parked", parkedTaskIds: [TaskId.make(7)] },
    { category: "held", word: word("Parked"), hold: "Parked" }
  ),
  "ThreadActivity failed": row(failed(Option.some("unknown")), {
    category: "failed",
    word: word("Failed"),
  }),
  "RunFailureClass usage_limit": row(failed(Option.some("usage_limit")), {
    category: "held",
    word: word("Limited"),
    hold: "Limited",
  }),
  "RunFailureClass provider_error": row(failed(Option.some("provider_error")), {
    category: "failed",
    word: word("Failed"),
  }),
  "RunFailureClass transport_error": row(
    failed(Option.some("transport_error")),
    {
      category: "failed",
      word: word("Failed"),
    }
  ),
  "RunFailureClass unknown": row(failed(Option.some("unknown")), {
    category: "failed",
    word: word("Failed"),
  }),
  "WaitingFor claude_slot": row(
    { ...running, waitingFor: "claude_slot" },
    { category: "held", word: word("Working"), hold: "Waiting" }
  ),
  "WaitingFor parent": row(child({ waitingFor: "parent" }), {
    category: "held",
    word: word("Asked its parent"),
  }),
  "WaitingFor none": row(base, { category: "resting", word: Option.none() }),
  "SettledOverride settled": shelf(
    { ...base, settledOverride: Option.some("settled") },
    "settled"
  ),
  "SettledOverride active": shelf(
    { ...base, settledOverride: Option.some("active") },
    "active"
  ),
  "RuntimeRequestKind executor-call": row(asking("executor-call"), {
    category: "waiting-on-you",
    word: word("Approval"),
  }),
  "RuntimeRequestKind tool-call": row(asking("tool-call"), {
    category: "waiting-on-you",
    word: word("Approval"),
  }),
  "RuntimeRequestKind user-input": row(asking("user-input"), {
    category: "waiting-on-you",
    word: word("Input"),
  }),
  "RuntimeRequestKind sign-in": row(asking("sign-in"), {
    category: "waiting-on-you",
    word: word("Input"),
  }),
  "RuntimeRequestKind brief": row(asking("brief"), {
    category: "waiting-on-you",
    word: word("Go"),
  }),
  "RuntimeRequestKind criteria": row(asking("criteria"), {
    category: "waiting-on-you",
    word: word("Approval"),
  }),
  "ApprovalStatus pending": row(asking("tool-call"), {
    category: "waiting-on-you",
    word: word("Approval"),
  }),
  // A record past `pending` leaves `pendingRuntimeRequest` (invariant 7): the run goes on, or ends.
  "ApprovalStatus accepted": row(running, {
    not: ENDED,
    word: word("Working"),
    quoted: false,
  }),
  "ApprovalStatus declined": row(running, {
    not: ENDED,
    word: word("Working"),
    quoted: false,
  }),
  "ApprovalStatus expired": row(running, {
    not: ENDED,
    word: word("Working"),
    quoted: false,
  }),
  "ApprovalStatus cancelled": row(base, { not: ENDED, word: Option.none() }),
  "ApprovalStatus revised": row(base, { not: ENDED, word: Option.none() }),
  "ExecutorStatus.state connected": elsewhere(
    "Executor's link, on the settings page"
  ),
  "ExecutorStatus.state needs-sign-in": elsewhere(
    "Executor's link, on the settings page"
  ),
  "ExecutorStatus.state unreachable": elsewhere(
    "Executor's link, on the settings page"
  ),
  "ExecutorStatus.state disabled": elsewhere(
    "Executor's link, on the settings page"
  ),
  "ProviderStatus.state ready": elsewhere(
    "a provider's credential, on the settings page"
  ),
  "ProviderStatus.state missing": elsewhere(
    "a provider's credential, on the settings page"
  ),
  "ProviderStatus.state refused": elsewhere(
    "a provider's credential, on the settings page"
  ),
  "ProviderStatus.state unknown": elsewhere(
    "a provider's credential, on the settings page"
  ),
  "UsageReading read": elsewhere("a provider's plan windows, on the meters"),
  "UsageReading unreadable": elsewhere(
    "a provider's plan windows, on the meters"
  ),
  "UsageReading unsupported": elsewhere(
    "a provider's plan windows, on the meters"
  ),
  "BudgetState none": elsewhere(
    "the spend meters (6G) and the budget notice (4E)"
  ),
  "BudgetState within": elsewhere(
    "the spend meters (6G) and the budget notice (4E)"
  ),
  "BudgetState warned": elsewhere(
    "the spend meters (6G) and the budget notice (4E)"
  ),
  "BudgetState exhausted": elsewhere(
    "the spend meters (6G) and the budget notice (4E)"
  ),
  "CriterionState open": elsewhere(
    "a goal's criterion, on the goal strip (6H)"
  ),
  "CriterionState met": elsewhere("a goal's criterion, on the goal strip (6H)"),
  "CriterionState failed": elsewhere(
    "a goal's criterion, on the goal strip (6H)"
  ),
  // A parent's children: counted on its row (`subagents`), and their requests rolled up to it.
  "SubagentStatus working": row(tally({ working: 1 }), {
    category: "active",
    word: word("Waiting"),
    quoted: false,
  }),
  "SubagentStatus waiting": row(
    tally({ asking: 1 }),
    { category: "waiting-on-you", word: word("Input"), quoted: false },
    [
      tally({ asking: 1 }),
      {
        ...child(),
        pendingRuntimeRequest: asking("user-input").pendingRuntimeRequest,
      },
    ]
  ),
  "SubagentStatus settled": row(tally({ settled: 1 }), {
    not: [...ENDED, "active"],
    word: Option.none(),
  }),
  "SubagentQuestionState pending": row(child({ waitingFor: "parent" }), {
    category: "held",
    word: word("Asked its parent"),
    quoted: false,
  }),
  "SubagentQuestionState answered": row(child(), {
    not: ENDED,
    word: word("Working"),
    quoted: false,
  }),
  // An escalated question is mirrored into the parent's own approvals, naming the child as origin.
  "SubagentQuestionState escalated": row(
    asking("user-input", Option.some(threadId(2))),
    {
      category: "waiting-on-you",
      word: word("Input"),
      quoted: false,
    }
  ),
  "EscalationStatus open": row(asking("user-input", Option.some(threadId(2))), {
    category: "waiting-on-you",
    word: word("Input"),
    quoted: false,
  }),
  "EscalationStatus resolved": row(running, {
    not: ENDED,
    word: word("Working"),
    quoted: false,
  }),
  // A settlement ends the child's input; the child's row says how its run ended.
  "SettlementOutcome completed": row(
    { ...base, id: threadId(2), lineage: child().lineage },
    {
      not: [...ENDED, "active"],
      word: Option.none(),
    }
  ),
  "SettlementOutcome stopped": row(
    { ...base, id: threadId(2), lineage: child().lineage },
    {
      not: [...ENDED, "active"],
      word: Option.none(),
    }
  ),
  "SettlementOutcome failed": row(
    {
      ...failed(Option.some("unknown")),
      id: threadId(2),
      lineage: child().lineage,
    },
    { category: "failed", word: word("Failed"), quoted: false }
  ),
  "WorkflowState proposed": elsewhere(
    "a workflow, on its launch card and steps panel (6F)"
  ),
  "WorkflowState approved": elsewhere("a workflow, on its steps panel (6F)"),
  "WorkflowState running": elsewhere("a workflow, on its steps panel (6F)"),
  "WorkflowState finished": elsewhere("a workflow, on its steps panel (6F)"),
  "WorkflowState failed": elsewhere("a workflow, on its steps panel (6F)"),
  "WorkflowState stopped": elsewhere("a workflow, on its steps panel (6F)"),
  "WorkflowState declined": elsewhere("a workflow, on its steps panel (6F)"),
  "NodeState reserved": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState running": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState held": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState settled": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState failed": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState stopped": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState refused": elsewhere("a workflow node, on the steps panel (6F)"),
  "NodeState start_unknown": elsewhere(
    "a workflow node, on the steps panel (6F)"
  ),
  "NodeState stop_unknown": elsewhere(
    "a workflow node, on the steps panel (6F)"
  ),
  "PortalState opening": elsewhere("a portal, on its entry (6I)"),
  "PortalState open": elsewhere("a portal, on its entry (6I)"),
  "PortalState stopped": elsewhere("a portal, on its entry (6I)"),
  "PortalState removed": elsewhere("a portal, on its entry (6I)"),
  "state: Launch": row(
    { ...base, activity: "preparing" },
    { category: "active", word: word("Working") }
  ),
  "state: Run": row(running, { category: "active", word: word("Working") }),
  "state: Queued input": row(
    { ...base, queueLength: 1 },
    { category: "active", word: word("Working") }
  ),
  "state: Pending approval": row(asking("executor-call"), {
    category: "waiting-on-you",
    word: word("Approval"),
  }),
  "state: Subagent": {
    kind: "shelf",
    check: () => {
      const parent = base;
      const hidden = child();
      const partition = partitionSidebarThreads([parent, hidden], NOW);

      assert.deepStrictEqual(
        [
          ...partition.pinned,
          ...partition.active,
          ...partition.snoozed,
          ...partition.settled,
        ].map((thread) => thread.id),
        [parent.id]
      );
      assert.strictEqual(
        sidebarRowThreadId(hidden.id, [parent, hidden]),
        parent.id
      );
    },
  },
  "state: Children working": row(tally({ working: 2 }), {
    category: "active",
    word: word("Waiting"),
  }),
  "state: Goal": elsewhere(
    "the goal strip (6H) reads `goal`; the row's state is its run's"
  ),
  "state: Parked task": row(
    { ...base, parkedTaskIds: [TaskId.make(3)] },
    { category: "held", word: word("Parked"), hold: "Parked" }
  ),
  "state: Hold": row(
    { ...running, waitingFor: "claude_slot" },
    { category: "held", word: word("Working"), hold: "Waiting" }
  ),
  "state: Unseen": row(
    {
      ...base,
      latestRunCompletedAt: Option.some(time("2026-04-10T11:00:00Z")),
    },
    { category: "resting", word: word("Done") }
  ),
  "state: Pinned": shelf({ ...base, pinnedAt: Option.some(NOW) }, "pinned"),
  "state: Snoozed": shelf(
    {
      ...base,
      snoozedUntil: Option.some(time("2026-04-11T09:00:00Z")),
      snoozedAt: Option.some(NOW),
    },
    "snoozed"
  ),
  "state: Woke": row(snoozedThenWoken, {
    category: "resting",
    word: word("Woke"),
  }),
  "state: Archived": {
    kind: "shelf",
    check: () => {
      const archived = { ...base, archivedAt: Option.some(NOW) };
      const partition = partitionSidebarThreads([archived], NOW);

      assert.strictEqual(
        partition.pinned.length +
          partition.active.length +
          partition.snoozed.length +
          partition.settled.length,
        0
      );
    },
  },
  "state: Deleted": elsewhere(
    "a tombstoned row leaves the shell stream, so no surface reads it"
  ),
} satisfies Readonly<Record<string, Case>>;

/** The cases by doc key. */
const CASE_BY_KEY = new Map<string, Case>(Object.entries(CASES));

/** The doc's category names, by the state function's categories. */
const CATEGORY_NAMES: Readonly<Record<ThreadCategory, string>> = {
  active: "Active",
  "waiting-on-you": "Waiting on you",
  held: "Held",
  resting: "Resting",
  failed: "Failed",
};

/** A doc section: from its heading to the next heading of the same or a higher level. */
const sectionOfDoc = (doc: string, heading: string): string => {
  const start = doc.indexOf(`\n${heading}\n`);

  if (start === -1) {
    return "";
  }

  const level = heading.split(" ")[0] ?? "##";
  const next = new RegExp(`\\n#{2,${level.length}} `, "u");
  const rest = doc.slice(start + heading.length + 2);
  const end = rest.search(next);

  return end === -1 ? rest : rest.slice(0, end);
};

const cellsOf = (line: string): ReadonlyArray<string> =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

const unquote = (cell: string) => cell.replaceAll("`", "");

/** The doc's rows, by key, with their category: both tables of "Statuses". */
const docRows = (doc: string): ReadonlyMap<string, string> => {
  const rows = new Map<string, string>();
  const statuses = sectionOfDoc(doc, "## Statuses");

  const [statusTable = "", stateTable = ""] = statuses.split(
    "\n### States without a status value\n"
  );

  for (const line of statusTable.split("\n")) {
    const cells = cellsOf(line);

    if (
      cells.length === 4 &&
      cells[0]?.startsWith("`") === true &&
      cells[1]?.startsWith("`") === true
    ) {
      rows.set(`${unquote(cells[0])} ${unquote(cells[1])}`, cells[2] ?? "");
    }
  }

  for (const line of stateTable.split("\n")) {
    const cells = cellsOf(line);

    if (
      cells.length === 3 &&
      cells[0] !== "State" &&
      !(cells[0]?.startsWith("---") ?? true)
    ) {
      rows.set(`state: ${cells[0] ?? ""}`, cells[2] ?? "");
    }
  }

  return rows;
};

/** The label map's "The UI shows" cell, by `Schema value`. */
const labelCells = (doc: string): ReadonlyMap<string, string> => {
  const cells = new Map<string, string>();

  for (const line of sectionOfDoc(doc, "## Label map").split("\n")) {
    const parts = cellsOf(line);

    if (
      parts.length === 4 &&
      parts[0]?.startsWith("`") === true &&
      parts[1]?.startsWith("`") === true
    ) {
      cells.set(`${unquote(parts[0])} ${unquote(parts[1])}`, parts[2] ?? "");
    }
  }

  return cells;
};

const stateOfCase = (
  thread: ThreadShell,
  shell: ReadonlyArray<ThreadShell>
): ThreadState =>
  threadState(thread, {
    now: NOW,
    subagentRequest: subagentRequestFor(
      pendingSubagentRequests(shell),
      thread.id
    ),
  });

/** What disagrees between one row case and the doc; empty when they agree. */
const disagreements = (
  key: string,
  testCase: Extract<Case, { kind: "row" }>,
  docCategory: string,
  labelCell: Option.Option<string>
): ReadonlyArray<string> => {
  const { expect } = testCase;

  const state = stateOfCase(
    testCase.thread,
    testCase.shell ?? [testCase.thread]
  );

  const problems: Array<string> = [];
  const shown = Option.map(state.label, (label) => label.word);

  if (expect.category !== undefined) {
    if (CATEGORY_NAMES[expect.category] !== docCategory) {
      problems.push(
        `${key}: the case expects ${expect.category}, the doc says ${docCategory}`
      );
    }

    if (CATEGORY_NAMES[state.category] !== docCategory) {
      problems.push(
        `${key}: the state is ${state.category}, the doc says ${docCategory}`
      );
    }
  }

  if (expect.not?.includes(state.category) === true) {
    problems.push(
      `${key}: the state is ${state.category}, which the doc's ${docCategory} rules out`
    );
  }

  if (
    expect.word !== undefined &&
    Option.getOrUndefined(shown) !== Option.getOrUndefined(expect.word)
  ) {
    problems.push(
      `${key}: the row says ${Option.getOrElse(shown, () => "nothing")}`
    );
  }

  if (expect.quoted !== false && Option.isSome(labelCell)) {
    for (const quoted of [
      ...Option.toArray(expect.word ?? Option.none()),
      ...Option.toArray(Option.fromUndefinedOr(expect.hold)),
    ]) {
      if (!labelCell.value.includes(`"${quoted}"`)) {
        problems.push(`${key}: the label map does not quote "${quoted}"`);
      }
    }
  }

  if (expect.hold !== undefined) {
    const hold = Option.map(state.hold, (held) => HOLD_LABELS[held._tag].word);

    if (!Option.contains(hold, expect.hold)) {
      problems.push(
        `${key}: the banner says ${Option.getOrElse(hold, () => "nothing")}`
      );
    }
  }

  return problems;
};

/** Every disagreement between the cases and `doc`. */
const judge = (doc: string): ReadonlyArray<string> => {
  const rows = docRows(doc);
  const labels = labelCells(doc);

  return [...rows].flatMap(([key, category]) => {
    const testCase = CASE_BY_KEY.get(key);

    if (testCase === undefined || testCase.kind !== "row") {
      return [];
    }

    return disagreements(
      key,
      testCase,
      category,
      Option.fromUndefinedOr(labels.get(key))
    );
  });
};

const doc = readFileSync(docPath, "utf-8");

describe("thread-state rows", () => {
  it("has a case for every row of the doc, and no case without a row", () => {
    const rows = [...docRows(doc).keys()];

    assert.isAbove(rows.length, 90);
    assert.deepStrictEqual(
      rows.filter((key) => !CASE_BY_KEY.has(key)),
      [],
      "doc rows with no case"
    );
    assert.deepStrictEqual(
      [...CASE_BY_KEY.keys()].filter((key) => !rows.includes(key)),
      [],
      "cases with no doc row"
    );
  });

  it("puts every thread the doc describes in its category, with the label map's words", () => {
    assert.deepStrictEqual(judge(doc), []);
  });

  it("puts every shelf row on the doc's shelf", () => {
    const shelves = [...CASE_BY_KEY.values()].filter(
      (testCase) => testCase.kind === "shelf"
    );

    assert.strictEqual(shelves.length, 6);

    for (const testCase of shelves) {
      testCase.check();
    }
  });

  it("names the surface for every state a thread's row does not show", () => {
    for (const [key, testCase] of CASE_BY_KEY) {
      if (testCase.kind === "elsewhere") {
        assert.isAbove(testCase.why.length, 10, key);
      }
    }
  });

  it("fails on a doc whose category or words disagree (control)", () => {
    const wrongCategory = doc.replace(
      "| `RuntimeRequestKind` | `brief` | Waiting on you |",
      "| `RuntimeRequestKind` | `brief` | Held |"
    );

    const wrongWord = doc.replace(
      '| `RuntimeRequestKind` | `brief` | "Go"',
      '| `RuntimeRequestKind` | `brief` | "Approval"'
    );

    assert.notStrictEqual(wrongCategory, doc);
    assert.notStrictEqual(wrongWord, doc);
    assert.deepStrictEqual(judge(wrongCategory), [
      "RuntimeRequestKind brief: the case expects waiting-on-you, the doc says Held",
      "RuntimeRequestKind brief: the state is waiting-on-you, the doc says Held",
    ]);
    assert.deepStrictEqual(judge(wrongWord), [
      'RuntimeRequestKind brief: the label map does not quote "Go"',
    ]);
  });
});
