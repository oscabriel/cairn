// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the section and adjacent-thread cases; the status
// and top status cases moved to ThreadState.test.ts and the lineage cases to SubagentRollup.test.ts
// (package 1E). Changed: rows are Cairn's shell rows. Removed: drag, sweep, multi-select, pull
// request, fork, prewarm, jump hint, stage badge, project sort and Working shelf cases (not
// ported), and the recede, accessibility, search, preferred-order, paging, monogram and
// leaving-a-thread cases, which went with the classic sidebar (ADR 0050). Added: the partition
// into shelves and the managed list's groups.
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

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  managedGroupsOf,
  partitionSidebarThreads,
  resolveAdjacentThreadId,
  resolveSidebarThreadSection,
} from "./Sidebar.ts";
import type { ThreadCategory } from "./ThreadState.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const some = (iso: string) => Option.some(time(iso));

const NOW = time("2026-04-10T12:00:00.000Z");

const threadId = (suffix: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(suffix).padStart(4, "0")}`
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
  ...BARE_ROW_FIELDS,
});

const thread = (
  suffix: number,
  overrides: Partial<ThreadShell> = {}
): ThreadShell => ({ ...base, id: threadId(suffix), ...overrides });

describe(resolveSidebarThreadSection, () => {
  it("keeps a pinned thread in the pinned shelf", () => {
    assert.strictEqual(
      resolveSidebarThreadSection({
        snoozed: false,
        settled: false,
        pinned: true,
      }),
      "pinned"
    );
  });

  it("keeps lifecycle shelves authoritative over a stale pin", () => {
    assert.strictEqual(
      resolveSidebarThreadSection({
        snoozed: true,
        settled: true,
        pinned: true,
      }),
      "snoozed"
    );
    assert.strictEqual(
      resolveSidebarThreadSection({
        snoozed: false,
        settled: true,
        pinned: true,
      }),
      "settled"
    );
  });
});

describe(partitionSidebarThreads, () => {
  it("puts each thread on its shelf, in each shelf's order", () => {
    const pinned = thread(1, { pinnedAt: some("2026-04-10T09:00:00Z") });
    const activeOld = thread(2, { createdAt: time("2026-04-10T07:00:00Z") });
    const activeNew = thread(3, { createdAt: time("2026-04-10T10:00:00Z") });

    const snoozedLate = thread(4, {
      snoozedUntil: some("2026-04-12T09:00:00Z"),
      snoozedAt: some("2026-04-10T09:00:00Z"),
    });

    const snoozedSoon = thread(5, {
      snoozedUntil: some("2026-04-11T09:00:00Z"),
      snoozedAt: some("2026-04-10T09:00:00Z"),
    });

    const settled = thread(6, {
      settledOverride: Option.some("settled"),
      settledAt: some("2026-04-10T09:00:00Z"),
      pinnedAt: some("2026-04-10T09:00:00Z"),
    });

    const archived = thread(7, { archivedAt: some("2026-04-10T09:00:00Z") });

    const partition = partitionSidebarThreads(
      [
        activeOld,
        pinned,
        snoozedLate,
        settled,
        activeNew,
        snoozedSoon,
        archived,
      ],
      NOW
    );

    assert.deepStrictEqual(partition.pinned, [pinned]);
    assert.deepStrictEqual(partition.active, [activeNew, activeOld]);
    assert.deepStrictEqual(partition.snoozed, [snoozedSoon, snoozedLate]);
    assert.deepStrictEqual(partition.settled, [settled]);
  });

  it("keeps only the filtered project's threads", () => {
    const mine = thread(1);
    const other = thread(2, { projectId: ProjectId.make("prj_2") });

    assert.deepStrictEqual(
      partitionSidebarThreads(
        [mine, other],
        NOW,
        Option.some(ProjectId.make("prj_2"))
      ).active,
      [other]
    );
  });

  it("returns a woken thread to the active shelf", () => {
    const woken = thread(1, {
      snoozedUntil: some("2026-04-10T10:00:00Z"),
      snoozedAt: some("2026-04-10T09:00:00Z"),
    });

    assert.deepStrictEqual(partitionSidebarThreads([woken], NOW).active, [
      woken,
    ]);
  });
});

const traversalIds = ["thread-1", "thread-2", "thread-3"];

const adjacent = (current: string | null, direction: "previous" | "next") =>
  Option.getOrNull(
    resolveAdjacentThreadId({
      threadIds: traversalIds,
      currentThreadId: Option.fromNullOr(current),
      direction,
    })
  );

describe(resolveAdjacentThreadId, () => {
  it("resolves neighbours in sidebar order", () => {
    assert.strictEqual(adjacent("thread-2", "previous"), "thread-1");
    assert.strictEqual(adjacent("thread-2", "next"), "thread-3");
    assert.strictEqual(adjacent(null, "next"), "thread-1");
    assert.strictEqual(adjacent(null, "previous"), "thread-3");
    assert.strictEqual(adjacent("thread-1", "previous"), null);
    assert.strictEqual(adjacent("missing", "next"), null);
  });
});

describe(managedGroupsOf, () => {
  it("lifts the rows that ask above the other live ones and folds the resting and failed ones", () => {
    const rows: ReadonlyArray<readonly [string, ThreadCategory]> = [
      ["new-working", "active"],
      ["new-done", "resting"],
      ["held", "held"],
      ["asking", "waiting-on-you"],
      ["failed", "failed"],
      ["old-asking", "waiting-on-you"],
      ["old-idle", "resting"],
    ];

    const groups = managedGroupsOf(rows, ([, category]) => category);

    assert.deepStrictEqual(
      {
        live: groups.live.map(([name]) => name),
        resting: groups.resting.map(([name]) => name),
      },
      {
        live: ["asking", "old-asking", "new-working", "held"],
        resting: ["new-done", "failed", "old-idle"],
      }
    );
  });
});
