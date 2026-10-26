// Ported from github.com/pingdotgg/t3code, apps/web/src/components/threadActionMenu.logic.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the lifecycle label flips, project filter,
// branch-only items, auto-settle radio, snooze disabled with presets kept, archive before delete
// and the draft menu cases. Removed: permission (`canOperate`), capability (`supports`), title
// regeneration and project settings cases, whose items Cairn trims. Added: the trimmed id list.
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

import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  allMenuIds,
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  THREAD_ACTION_MENU_IDS,
} from "./ThreadMenu.ts";
import type { ThreadActionMenuState } from "./ThreadMenu.ts";

const baseState: ThreadActionMenuState = {
  hasBranch: false,
  projectFilter: Option.none(),
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRunning: false,
  snoozePresets: [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: "3:00 PM",
      snoozedUntil: DateTime.makeUnsafe("2026-08-07T15:00:00Z"),
    },
  ],
};

const ids = (state: ThreadActionMenuState) =>
  buildThreadActionMenuItems(state).map((entry) => entry.id);

const find = (state: ThreadActionMenuState, id: string) =>
  buildThreadActionMenuItems(state).find((entry) => entry.id === id);

describe(buildThreadActionMenuItems, () => {
  it("lists t3code's items minus the trimmed ones, in t3code's order", () => {
    assert.deepStrictEqual(ids(baseState), [
      "pin",
      "settle",
      "snooze",
      "rename",
      "mark-unread",
      "auto-settle",
      "copy",
      "archive",
      "delete",
    ]);

    const everything = allMenuIds(
      buildThreadActionMenuItems({
        ...baseState,
        hasBranch: true,
        projectFilter: Option.some({ label: "cairn", isActive: false }),
      })
    );

    for (const id of everything) {
      assert.include(THREAD_ACTION_MENU_IDS, id);
    }

    for (const trimmed of [
      "new-thread-on-branch",
      "project-settings",
      "regenerate-title",
      "snooze:custom",
    ]) {
      assert.notInclude(everything, trimmed);
    }
  });

  it("flips lifecycle labels with thread state", () => {
    assert.includeMembers(
      ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true }),
      ["unpin", "unsettle", "unsnooze"]
    );
    assert.includeMembers(ids(baseState), ["pin", "settle", "snooze"]);
  });

  it("offers project filtering only when the list can be scoped, and the way back", () => {
    assert.notInclude(ids(baseState), "filter-by-project");

    const scoping = find(
      {
        ...baseState,
        projectFilter: Option.some({ label: "Beta", isActive: false }),
      },
      "filter-by-project"
    );

    assert.strictEqual(scoping?.label, "Filter by Beta");
    assert.deepStrictEqual(scoping?.icon, Option.some("folder-tree"));

    const items = buildThreadActionMenuItems({
      ...baseState,
      projectFilter: Option.some({ label: "Beta", isActive: true }),
    });

    const index = items.findIndex((entry) => entry.id === "filter-by-project");

    assert.strictEqual(items[index]?.label, "Show all projects");
    assert.strictEqual(items[index - 1]?.id, "mark-unread");
    assert.strictEqual(items[index + 1]?.id, "auto-settle");
  });

  it("includes branch items only for threads with a branch", () => {
    assert.include(
      allMenuIds(buildThreadActionMenuItems({ ...baseState, hasBranch: true })),
      "copy-branch"
    );
    assert.notInclude(
      allMenuIds(buildThreadActionMenuItems(baseState)),
      "copy-branch"
    );
  });

  it("offers auto-settle as a submenu with the current option checked", () => {
    const on = find(baseState, "auto-settle");

    assert.strictEqual(on?.label, "Auto-settle behavior");
    assert.deepStrictEqual(
      on?.children.map((child) => [child.id, child.checked]),
      [
        ["auto-settle:enabled", Option.some(true)],
        ["auto-settle:disabled", Option.some(false)],
      ]
    );
    assert.deepStrictEqual(
      find(
        { ...baseState, autoSettleEnabled: false },
        "auto-settle"
      )?.children.map((child) => child.checked),
      [Option.some(false), Option.some(true)]
    );
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = find({ ...baseState, canSnoozeNow: false }, "snooze");

    assert.isTrue(snooze?.disabled);
    assert.deepStrictEqual(
      snooze?.children.map((child) => [child.id, child.label]),
      [["snooze:hour", "In 1 hour (3:00 PM)"]]
    );
  });

  it("offers archive right before a destructive delete, disabled while running", () => {
    const items = buildThreadActionMenuItems(baseState);

    assert.strictEqual(items.at(-2)?.id, "archive");
    assert.isTrue(items.at(-2)?.separatorBefore);
    assert.isFalse(items.at(-2)?.destructive);
    assert.strictEqual(items.at(-1)?.id, "delete");
    assert.isTrue(items.at(-1)?.destructive);
    assert.isTrue(find({ ...baseState, isRunning: true }, "archive")?.disabled);
  });
});

describe(buildDraftActionMenuItems, () => {
  it("offers the path only when the draft has one, and keeps discard last", () => {
    const items = buildDraftActionMenuItems({ hasPath: true });

    assert.deepStrictEqual(
      items.map((entry) => entry.id),
      ["copy", "discard"]
    );
    assert.deepStrictEqual(
      items[0]?.children.map((entry) => entry.id),
      ["copy-path"]
    );
    assert.isTrue(items.at(-1)?.destructive);

    const noPath = buildDraftActionMenuItems({ hasPath: false });

    assert.isTrue(noPath[0]?.disabled);
    assert.deepStrictEqual(noPath[0]?.children, []);
  });
});
