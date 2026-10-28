// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadShell.test.ts
// ("counts a subagent question on its parent only while the subagent runs", "brings a parent back
// from Working while a nested subagent waits for approval", "keeps navigation stable on hidden
// subagent updates") and apps/web/src/components/Sidebar.logic.test.ts ("sidebar thread lineage
// helpers") at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a child's question counts on its
// parent only while the child's run is live, a nested approval reaches the root and wins over
// input, the asking descendants and their banner title, subagent rows left out of the sidebar, and
// an open subagent mapped to its nearest visible ancestor across orphans and loops. Changed: Cairn's
// shell rows and plain functions instead of atoms. Added: a brief counts with no live run. Not
// ported: forks, environments, atom reference stability.
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

import { ApprovalId, ProjectId, RunId, ThreadId } from "@cairn/protocol/Ids";
import type { RuntimeRequestKind } from "@cairn/protocol/Policy";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { partitionSidebarThreads } from "./Sidebar.ts";
import {
  childInputsTitle,
  childrenAsking,
  isSubagentThread,
  pendingSubagentRequests,
  sidebarRowThreadId,
  subagentRequestOf,
} from "./SubagentRollup.ts";
import type { RollupRow } from "./SubagentRollup.ts";

const NOW = DateTime.makeUnsafe("2026-04-10T12:00:00.000Z");

const NAMES = [
  "root",
  "child",
  "grandchild",
  "review",
  "review-helper",
  "sibling",
  "orphan",
  "missing",
  "unknown",
  "loop-a",
  "loop-b",
  "subagent",
  "archived",
  "defaults",
];

/** A thread id per test name, so assertions read by name. */
const id = (name: string) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(NAMES.indexOf(name) + 1).padStart(4, "0")}`
  );

const request = (kind: RuntimeRequestKind) =>
  Option.some({
    id: ApprovalId.make(`apr_${kind}`),
    kind,
    createdAt: NOW,
    origin: Option.none(),
  });

const lineage = (parent: ThreadId, root: ThreadId = parent) =>
  Option.some({
    parentThreadId: parent,
    relationshipToParent: "subagent" as const,
    rootThreadId: root,
  });

/** A top-level row, idle and asking nothing. */
const top = (name: string): RollupRow => ({
  id: id(name),
  title: name,
  lineage: Option.none(),
  activity: "idle",
  activeRunId: Option.none(),
  pendingRuntimeRequest: Option.none(),
});

/** A running subagent of `parent`. */
const subagentOf = (
  name: string,
  parent: ThreadId,
  root: ThreadId = parent
): RollupRow => ({
  ...top(name),
  lineage: lineage(parent, root),
  activity: "running",
  activeRunId: Option.some(RunId.make(NAMES.indexOf(name) + 1)),
});

/** The rest of a shell row, for the partition case. */
const ROW_DEFAULTS: ThreadShell = {
  id: id("defaults"),
  projectId: ProjectId.make("prj_1"),
  title: "defaults",
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
  createdAt: NOW,
  updatedAt: NOW,
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
  lineage: Option.none(),
  subagents: { working: 0, asking: 0, settled: 0, failed: 0 },
  goal: Option.none(),
  spend: Option.none(),
  pendingCount: 0,
};

/** A whole shell row from a rollup row. */
const shell = (
  row: RollupRow,
  overrides: Partial<ThreadShell> = {}
): ThreadShell => ({
  ...ROW_DEFAULTS,
  ...row,
  ...overrides,
});

describe("subagent request rollup", () => {
  it("counts a subagent question on its parent only while the subagent runs", () => {
    const root = top("root");

    const child = {
      ...subagentOf("child", root.id),
      pendingRuntimeRequest: request("user-input"),
    };

    assert.deepStrictEqual(
      [...pendingSubagentRequests([root, child])],
      [[root.id, "input"]]
    );
    assert.deepStrictEqual(
      childrenAsking(root.id, [root, child]).map((thread) => thread.id),
      [child.id]
    );

    const queued = { ...child, activity: "waiting" as const };

    assert.deepStrictEqual(
      childrenAsking(root.id, [root, queued]).map((thread) => thread.id),
      [child.id]
    );

    const finished = {
      ...child,
      activity: "idle" as const,
      activeRunId: Option.none(),
    };

    assert.deepStrictEqual(childrenAsking(root.id, [root, finished]), []);
    assert.strictEqual(pendingSubagentRequests([root, finished]).size, 0);
  });

  it("counts a brief with no live run, since no run holds one", () => {
    const root = top("root");

    const child = {
      ...subagentOf("child", root.id),
      activity: "idle" as const,
      activeRunId: Option.none(),
      pendingRuntimeRequest: request("brief"),
    };

    assert.deepStrictEqual(subagentRequestOf(child), Option.some("approval"));
    assert.deepStrictEqual(
      [...pendingSubagentRequests([root, child])],
      [[root.id, "approval"]]
    );
  });

  it("brings a nested subagent's approval to every ancestor, over input", () => {
    const root = top("root");
    const child = subagentOf("review", root.id);
    const grandchild = subagentOf("review-helper", child.id, root.id);

    const sibling = {
      ...subagentOf("sibling", root.id),
      pendingRuntimeRequest: request("user-input"),
    };

    const approving = {
      ...grandchild,
      pendingRuntimeRequest: request("executor-call"),
    };

    assert.strictEqual(
      pendingSubagentRequests([root, child, grandchild]).size,
      0
    );

    const requests = pendingSubagentRequests([root, child, approving, sibling]);

    assert.strictEqual(requests.get(root.id), "approval");
    assert.strictEqual(requests.get(child.id), "approval");
    assert.isFalse(requests.has(approving.id));

    const asking = childrenAsking(root.id, [root, child, approving]);

    assert.deepStrictEqual(
      asking.map((thread) => thread.id),
      [grandchild.id]
    );
    assert.strictEqual(childInputsTitle(asking), "Subagent needs approval");
    assert.strictEqual(
      childInputsTitle([approving, sibling]),
      "2 subagents need you"
    );
    assert.strictEqual(childInputsTitle([sibling]), "Subagent needs input");
  });

  it("stops walking a lineage that loops or leaves the shell", () => {
    const loopA = subagentOf("loop-a", id("loop-b"));

    const loopB = {
      ...subagentOf("loop-b", loopA.id),
      pendingRuntimeRequest: request("tool-call"),
    };

    const orphan = {
      ...subagentOf("orphan", id("missing")),
      pendingRuntimeRequest: request("user-input"),
    };

    const requests = pendingSubagentRequests([loopA, loopB, orphan]);

    assert.strictEqual(requests.get(loopA.id), "approval");
    assert.strictEqual(requests.get(id("missing")), "input");
    assert.strictEqual(requests.size, 2);
  });
});

describe("sidebar thread lineage helpers", () => {
  it("keeps only top-level, unarchived threads in the sidebar's shelves", () => {
    const root = shell(top("root"));
    const subagent = shell(subagentOf("subagent", root.id));
    const archived = shell(top("archived"), { archivedAt: Option.some(NOW) });
    const partition = partitionSidebarThreads([root, subagent, archived], NOW);

    assert.deepStrictEqual(
      [
        ...partition.pinned,
        ...partition.active,
        ...partition.snoozed,
        ...partition.settled,
      ].map((thread) => thread.id),
      [root.id]
    );
  });

  it("identifies subagent threads so the sidebar can hide them", () => {
    assert.isTrue(isSubagentThread(subagentOf("child", id("root"))));
    assert.isFalse(isSubagentThread(top("root")));
  });

  it("maps an open subagent to its nearest visible ancestor's sidebar row", () => {
    const root = top("root");
    const child = subagentOf("child", root.id);
    const grandchild = subagentOf("grandchild", child.id, root.id);
    const orphan = subagentOf("orphan", id("missing"));
    const threads = [root, child, grandchild, orphan];

    assert.strictEqual(sidebarRowThreadId(child.id, threads), root.id);
    assert.strictEqual(sidebarRowThreadId(grandchild.id, threads), root.id);
    assert.strictEqual(sidebarRowThreadId(root.id, threads), root.id);
    assert.strictEqual(sidebarRowThreadId(orphan.id, threads), orphan.id);
    assert.strictEqual(
      sidebarRowThreadId(id("unknown"), threads),
      id("unknown")
    );

    const loopA = subagentOf("loop-a", id("loop-b"));
    const loopB = subagentOf("loop-b", loopA.id);

    assert.strictEqual(sidebarRowThreadId(loopA.id, [loopA, loopB]), loopA.id);
  });
});
