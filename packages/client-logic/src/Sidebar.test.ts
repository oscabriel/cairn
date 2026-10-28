// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the section, recede, status, top status,
// accessibility, search, adjacent-thread and preferred-order cases. Changed: rows are Cairn's shell
// rows, so a runtime's status is `activity` and an approval or question is `pendingRuntimeRequest`.
// Removed: drag, sweep, multi-select, pull request, lineage, prewarm, jump hint, stage badge, project
// sort and Working shelf cases (not ported). Added: the partition into shelves, settled paging,
// parked rows, the project monogram and leaving an open thread.
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

import {
  ApprovalId,
  EntryId,
  ProjectId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  deriveProjectIdentity,
  isThreadWoke,
  nextThreadAfterLeaving,
  orderItemsByPreferredIds,
  partitionSidebarThreads,
  previewMatchIds,
  resolveAdjacentThreadId,
  resolveSidebarRowAccessibility,
  resolveSidebarThreadSection,
  resolveSidebarThreadStatus,
  resolveSidebarTopStatus,
  searchExcerpt,
  searchSidebarThreads,
  shouldRecedeSidebarThread,
  shouldShowSidebarDuration,
  splitHighlights,
  visibleSettledCount,
  visibleThreadOrder,
} from "./Sidebar.ts";

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
  parkedTaskIds: [],
  ...BARE_ROW_FIELDS,
});

const thread = (
  suffix: number,
  overrides: Partial<ThreadShell> = {}
): ThreadShell => ({ ...base, id: threadId(suffix), ...overrides });

const request = (
  kind: "tool-call" | "executor-call" | "user-input" | "sign-in"
) =>
  Option.some({
    id: ApprovalId.make("apr_1"),
    kind,
    createdAt: time("2026-04-10T11:00:00Z"),
    origin: Option.none(),
  });

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
    assert.isTrue(isThreadWoke(woken, NOW));
    assert.isFalse(
      isThreadWoke(
        { ...woken, lastVisitedAt: some("2026-04-10T11:00:00Z") },
        NOW
      )
    );
  });
});

describe(visibleSettledCount, () => {
  it("shows 10 settled rows, then 25 more per page, never more than there are", () => {
    assert.strictEqual(visibleSettledCount(146, 0), 10);
    assert.strictEqual(visibleSettledCount(146, 1), 35);
    assert.strictEqual(visibleSettledCount(146, 2), 60);
    assert.strictEqual(visibleSettledCount(12, 3), 12);
  });

  it("lists only the rows of open shelves, in sidebar order", () => {
    const partition = {
      pinned: [{ id: "p" }],
      active: [{ id: "a" }],
      snoozed: [{ id: "z" }],
      settled: Array.from({ length: 12 }, (_, index) => ({ id: `s${index}` })),
    };

    assert.deepStrictEqual(
      visibleThreadOrder(partition, {
        snoozedExpanded: false,
        settledExpanded: false,
        settledPages: 0,
      }),
      ["p", "a"]
    );
    assert.strictEqual(
      visibleThreadOrder(partition, {
        snoozedExpanded: true,
        settledExpanded: true,
        settledPages: 0,
      }).length,
      13
    );
  });
});

describe(resolveSidebarThreadStatus, () => {
  it("prioritizes approval over a running thread, and a question below approval", () => {
    assert.strictEqual(
      resolveSidebarThreadStatus({
        ...base,
        activity: "running",
        pendingRuntimeRequest: request("tool-call"),
      }),
      "approval"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({
        ...base,
        pendingRuntimeRequest: request("executor-call"),
      }),
      "approval"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({
        ...base,
        activity: "running",
        pendingRuntimeRequest: request("user-input"),
      }),
      "input"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({
        ...base,
        pendingRuntimeRequest: request("sign-in"),
      }),
      "input"
    );
  });

  it("reports working for preparing and running threads, and waiting for a waiting one", () => {
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...base, activity: "running" }),
      "working"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...base, activity: "preparing" }),
      "working"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...base, activity: "waiting" }),
      "waiting"
    );
  });

  it("keeps usage-limit stops Limited and visible", () => {
    const limited = {
      ...base,
      activity: "failed" as const,
      lastErrorClass: Option.some("usage_limit" as const),
    };

    assert.strictEqual(resolveSidebarThreadStatus(limited), "limited");
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...limited, activity: "running" }),
      "working"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...limited, activity: "idle" }),
      "ready"
    );
    assert.deepStrictEqual(
      resolveSidebarTopStatus({
        status: "limited",
        isUnread: false,
        isWoke: false,
      }),
      Option.some("limited")
    );
    assert.isFalse(
      shouldRecedeSidebarThread({
        status: "limited",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
      })
    );
  });

  it("reports failed only while the latest run failed", () => {
    assert.strictEqual(
      resolveSidebarThreadStatus({
        ...base,
        activity: "failed",
        lastErrorClass: Option.some("provider_error"),
      }),
      "failed"
    );

    const recovered: ThreadShell = {
      ...base,
      lastError: Option.some("persisted"),
    };

    assert.strictEqual(resolveSidebarThreadStatus(recovered), "ready");
  });

  it("reports parked when a task is parked, so the row can offer a retry", () => {
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...base, activity: "parked" }),
      "parked"
    );
    assert.strictEqual(
      resolveSidebarThreadStatus({ ...base, parkedTaskIds: [TaskId.make(7)] }),
      "parked"
    );
  });

  it("defaults to ready", () => {
    assert.strictEqual(resolveSidebarThreadStatus(base), "ready");
  });

  it("keeps a waiting thread visible ahead of unread and woke presentation", () => {
    assert.deepStrictEqual(
      resolveSidebarTopStatus({
        status: "waiting",
        isUnread: true,
        isWoke: true,
      }),
      Option.some("waiting")
    );
  });

  it("shows woke, then done, then nothing for a ready row", () => {
    assert.deepStrictEqual(
      resolveSidebarTopStatus({
        status: "ready",
        isUnread: true,
        isWoke: true,
      }),
      Option.some("woke")
    );
    assert.deepStrictEqual(
      resolveSidebarTopStatus({
        status: "ready",
        isUnread: true,
        isWoke: false,
      }),
      Option.some("done")
    );
    assert.isTrue(
      Option.isNone(
        resolveSidebarTopStatus({
          status: "ready",
          isUnread: false,
          isWoke: false,
        })
      )
    );
  });

  it("keeps Waiting static while Working shows elapsed duration", () => {
    assert.isFalse(shouldShowSidebarDuration("waiting"));
    assert.isTrue(shouldShowSidebarDuration("working"));
  });
});

describe(shouldRecedeSidebarThread, () => {
  it.each(["working", "waiting"] as const)(
    "recedes an inactive %s thread even when it is unread and woke",
    (status) => {
      assert.isTrue(
        shouldRecedeSidebarThread({
          status,
          isUnread: true,
          isWoke: true,
          isActive: false,
          isSelected: false,
        })
      );
    }
  );

  it.each(["ready", "approval", "input"] as const)(
    "keeps an unread %s thread prominent",
    (status) => {
      assert.isFalse(
        shouldRecedeSidebarThread({
          status,
          isUnread: true,
          isWoke: false,
          isActive: false,
          isSelected: false,
        })
      );
    }
  );

  it("keeps active and selected working threads prominent", () => {
    const input = {
      status: "working" as const,
      isUnread: true,
      isWoke: true,
      isActive: false,
      isSelected: false,
    };

    assert.isFalse(shouldRecedeSidebarThread({ ...input, isActive: true }));
    assert.isFalse(shouldRecedeSidebarThread({ ...input, isSelected: true }));
  });
});

describe(resolveSidebarRowAccessibility, () => {
  it("leads with the title without folding row actions into its name", () => {
    assert.deepStrictEqual(
      resolveSidebarRowAccessibility({
        title: "Can you audit the UI?",
        statusLabel: Option.some("Working"),
        projectDisplayName: Option.some("cairn"),
        isActive: true,
      }),
      { label: "Can you audit the UI?, Working, cairn", isCurrentPage: true }
    );
    assert.deepStrictEqual(
      resolveSidebarRowAccessibility({
        title: "Untitled task",
        statusLabel: Option.none(),
        projectDisplayName: Option.none(),
        isActive: false,
      }),
      { label: "Untitled task", isCurrentPage: false }
    );
  });
});

describe(searchSidebarThreads, () => {
  const threads = [
    { id: "thread-1", title: "Fix workspace search" },
    { id: "thread-2", title: "Review providers" },
    { id: "thread-3", title: "WORKTREE cleanup" },
  ];

  it("matches titles case-insensitively and preserves their order", () => {
    assert.deepStrictEqual(searchSidebarThreads(threads, "work"), [
      threads[0],
      threads[2],
    ]);
  });

  it("returns no results for an empty query", () => {
    assert.deepStrictEqual(searchSidebarThreads(threads, "   "), []);
  });

  it("appends content-only matches after every title match, once each", () => {
    assert.deepStrictEqual(
      searchSidebarThreads(threads, "work", new Set(["thread-2"])),
      [threads[0], threads[2], threads[1]]
    );
    assert.deepStrictEqual(
      searchSidebarThreads(threads, "work", new Set(["thread-1"])),
      [threads[0], threads[2]]
    );
  });

  it("finds content in the latest visible message", () => {
    const withMessage = thread(2, {
      latestVisibleMessage: Option.some({
        entryId: EntryId.make(4),
        role: "assistant",
        text: "The Worktree is ready",
        at: time("2026-04-10T09:00:00Z"),
      }),
    });

    assert.deepStrictEqual(
      [...previewMatchIds([thread(1), withMessage], "worktree")],
      [withMessage.id]
    );
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

  it("advances to the following row after leaving, else the one before", () => {
    assert.deepStrictEqual(
      nextThreadAfterLeaving(traversalIds, "thread-2"),
      Option.some("thread-3")
    );
    assert.deepStrictEqual(
      nextThreadAfterLeaving(traversalIds, "thread-3"),
      Option.some("thread-2")
    );
    assert.isTrue(Option.isNone(nextThreadAfterLeaving(["only"], "only")));
  });
});

describe(orderItemsByPreferredIds, () => {
  it("keeps preferred ids first, skips stale ids, and keeps the rest in order", () => {
    const ordered = orderItemsByPreferredIds({
      items: [{ id: "project-1" }, { id: "project-2" }, { id: "project-3" }],
      preferredIds: ["project-3", "project-missing", "project-1"],
      getId: (project) => project.id,
    });

    assert.deepStrictEqual(
      ordered.map((project) => project.id),
      ["project-3", "project-1", "project-2"]
    );
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [{ id: "project-1" }, { id: "project-2" }],
      preferredIds: ["project-2", "project-1", "project-2"],
      getId: (project) => project.id,
    });

    assert.deepStrictEqual(
      ordered.map((project) => project.id),
      ["project-2", "project-1"]
    );
  });
});

describe(deriveProjectIdentity, () => {
  it("matches t3code's marks for the user's projects", () => {
    assert.deepStrictEqual(deriveProjectIdentity("cairn"), {
      monogram: "CN",
      colorClassName: "text-amber-600 dark:text-amber-400",
    });
    assert.deepStrictEqual(deriveProjectIdentity("supervillain"), {
      monogram: "SN",
      colorClassName: "text-orange-600 dark:text-orange-400",
    });
  });

  it("takes a digit or the last word's first letter as the second glyph", () => {
    assert.strictEqual(deriveProjectIdentity("web3 app").monogram, "W3");
    assert.strictEqual(deriveProjectIdentity("agent artifacts").monogram, "AA");
    assert.strictEqual(deriveProjectIdentity("  ").monogram, "PR");
  });
});

describe(splitHighlights, () => {
  it("marks every occurrence, case-insensitively, keeping the original text", () => {
    assert.deepStrictEqual(
      splitHighlights("Bridged to Solid with createSolidBridge", "bridge"),
      [
        { text: "Bridge", highlighted: true },
        { text: "d to Solid with createSolid", highlighted: false },
        { text: "Bridge", highlighted: true },
      ]
    );
    assert.deepStrictEqual(splitHighlights("plain", " "), [
      { text: "plain", highlighted: false },
    ]);
  });

  it("keeps the highlight on the match after a letter whose lower case is longer", () => {
    // "İ" lowers to two code units; the match after it must not drift.
    assert.deepStrictEqual(splitHighlights("İzmir then Istanbul", "istanbul"), [
      { text: "İzmir then ", highlighted: false },
      { text: "Istanbul", highlighted: true },
    ]);
  });
});

describe("a search excerpt cut near an emoji", () => {
  it("never starts inside a surrogate pair", () => {
    const text = `${"a".repeat(159)}😀${"b".repeat(39)}needle`;
    const excerpt = Option.getOrThrow(searchExcerpt(text, "needle"));

    assert.isFalse(/^…[\uDC00-\uDFFF]/u.test(excerpt));
  });
});

describe(searchExcerpt, () => {
  it("shows a message from its start when the match is near it", () => {
    assert.deepStrictEqual(
      searchExcerpt("pihole rule deleted, MCP bridges for Executor", "bridge"),
      Option.some("pihole rule deleted, MCP bridges for Executor")
    );
  });

  it("starts a long message near its first match", () => {
    const text = `${"x".repeat(200)} the bridge`;

    assert.deepStrictEqual(
      searchExcerpt(text, "bridge"),
      Option.some(`…${text.slice(text.indexOf("bridge") - 40)}`)
    );
    assert.isTrue(Option.isNone(searchExcerpt(text, "absent")));
  });
});
