// The favicon badge counts only threads the shell lets the user reach: each project thread, the
// threads it manages and the scratch thread, the open one excepted. An old top-level thread no
// list shows never counts, so it cannot hold the badge at 1 (the user, 2026-10-30).

import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  CAIRN,
  MANAGED,
  SCRATCH,
  SCRATCH_THREAD,
  SHELL,
} from "../next/shell/ShellFixtures.ts";
import { badgeCount } from "./Notifications.ts";

const failed: Partial<ThreadShell> = {
  activity: "failed",
  lastError: Option.some("The judge failed."),
  lastErrorClass: Option.some("provider_error"),
};

// The managed rows that ask: the approval, the failure, the parked task and the unseen result.
const ASKING = 4;

describe("the favicon badge", () => {
  it("counts each managed request once, not again on the project thread", () => {
    assert.strictEqual(MANAGED.length, 6);
    assert.strictEqual(badgeCount(SHELL, Option.none(), Option.none()), ASKING);
  });

  it("does not count an old failed top-level thread outside any project thread's list", () => {
    const shell = {
      ...SHELL,
      threads: [
        ...SHELL.threads,
        shellRow(50, {
          projectId: CAIRN,
          title: "Deployed unit judge",
          ...failed,
        }),
      ],
    };

    assert.strictEqual(badgeCount(shell, Option.none(), Option.none()), ASKING);
  });

  it("counts the scratch thread, unless it is open", () => {
    const shell = {
      ...SHELL,
      threads: SHELL.threads.map((thread) =>
        thread.id === SCRATCH_THREAD ? { ...thread, ...failed } : thread
      ),
    };

    assert.strictEqual(
      badgeCount(shell, Option.none(), Option.some(SCRATCH_THREAD)),
      ASKING + 1
    );
    assert.strictEqual(
      badgeCount(
        shell,
        Option.some(SCRATCH_THREAD),
        Option.some(SCRATCH_THREAD)
      ),
      ASKING
    );
  });

  it("does not count a scratch-project thread the overlay does not hold", () => {
    const shell = {
      ...SHELL,
      threads: [
        ...SHELL.threads,
        shellRow(91, { projectId: SCRATCH, ...failed }),
      ],
    };

    assert.strictEqual(badgeCount(shell, Option.none(), Option.none()), ASKING);
  });

  it("does not count the open managed thread", () => {
    for (const asking of MANAGED.slice(0, 1)) {
      assert.strictEqual(
        badgeCount(SHELL, Option.some(asking.id), Option.none()),
        ASKING - 1
      );
    }
  });
});
