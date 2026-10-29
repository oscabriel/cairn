import { RunId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { badgeOf } from "./Badge.ts";
import {
  asking,
  EARLIER,
  NOW,
  rowId as id,
  shellRow as row,
} from "./ShellRowTestKit.ts";

const childOf = (parent: number, root: number = parent) => ({
  lineage: Option.some({
    parentThreadId: id(parent),
    relationshipToParent: "subagent" as const,
    rootThreadId: id(root),
  }),
});

const unseen: Partial<ThreadShell> = {
  latestRunCompletedAt: Option.some(NOW),
  lastVisitedAt: Option.some(EARLIER),
};

describe("badge", () => {
  it("counts a thread with a request waiting and no unseen result", () => {
    assert.strictEqual(badgeOf([row(1, asking("q-1")), row(2)]), 1);
  });

  it("counts an unseen top-level result, not a running one or a subagent's", () => {
    assert.strictEqual(
      badgeOf([
        row(1, unseen),
        row(2, { ...unseen, activeRunId: Option.some(RunId.make(2)) }),
        row(3, { ...unseen, ...childOf(1) }),
        row(4, { ...unseen, lastVisitedAt: Option.some(NOW) }),
      ]),
      1
    );
  });

  it("counts a thread once for its result and its request", () => {
    assert.strictEqual(
      badgeOf([
        row(1, { ...unseen, ...asking("q-1"), activeRunId: Option.none() }),
      ]),
      1
    );
  });

  it("folds an escalated question, a parent-routed one and a grandchild's into the root", () => {
    assert.strictEqual(
      badgeOf([
        row(1, asking("q-1-mirror")),
        row(2, { ...asking("q-1"), ...childOf(1) }),
        row(3, { ...asking("q-2"), ...childOf(1) }),
        row(4, { ...asking("tool-1"), ...childOf(3, 1) }),
      ]),
      1
    );
  });

  it("counts two project threads twice and skips an archived one", () => {
    assert.strictEqual(
      badgeOf([
        row(1, asking("q-1")),
        row(2, { ...asking("q-2"), ...childOf(5) }),
        row(3, { ...asking("q-3"), archivedAt: Option.some(NOW) }),
      ]),
      2
    );
  });
});
