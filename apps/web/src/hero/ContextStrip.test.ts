// Cases from github.com/pingdotgg/t3code, apps/web/src/components/BranchToolbar.logic.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 for the parts Cairn kept (labels), and Cairn's own for the
// branch order and the launch strategy. MIT License, Copyright (c) 2026 T3 Tools Inc.; the full
// notice is in ContextStrip.ts.
import { assert, describe, it } from "@effect/vitest";
import { Option, Predicate } from "effect";

import {
  filterBranches,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  workspaceStrategy,
} from "./ContextStrip.ts";

const branch = (name: string, isDefault = false, isRemote = false) => ({
  name,
  isDefault,
  isRemote,
  ahead: Option.none(),
});

describe("context strip labels", () => {
  it("names the two workspace modes", () => {
    assert.strictEqual(resolveEnvModeLabel("local"), "Current checkout");
    assert.strictEqual(resolveEnvModeLabel("worktree"), "New worktree");
  });

  it("locks to the thread's workspace once it started", () => {
    assert.strictEqual(
      resolveLockedWorkspaceLabel(Option.some("/w/x"), "local"),
      "Worktree"
    );
    assert.strictEqual(
      resolveLockedWorkspaceLabel(Option.none(), "worktree"),
      "New worktree"
    );
    assert.strictEqual(
      resolveLockedWorkspaceLabel(Option.none(), "local"),
      "Local checkout"
    );
  });
});

describe(filterBranches, () => {
  const branches = [
    branch("origin/main", false, true),
    branch("feature"),
    branch("main", true),
    branch("current"),
  ];

  it("lists the current branch, then the default, local before remote", () => {
    assert.deepStrictEqual(
      filterBranches(branches, Option.some("current"), "").map(
        ({ name }) => name
      ),
      ["current", "main", "feature", "origin/main"]
    );
  });

  it("filters by name", () => {
    assert.deepStrictEqual(
      filterBranches(branches, Option.none(), "MAI").map(({ name }) => name),
      ["main", "origin/main"]
    );
  });
});

describe(workspaceStrategy, () => {
  it("runs in the checkout for local mode", () => {
    assert.strictEqual(
      workspaceStrategy("local", Option.some("x"), Option.none())._tag,
      "Root"
    );
  });

  it("starts a worktree from the chosen base, else the current branch", () => {
    const chosen = workspaceStrategy(
      "worktree",
      Option.some("dev"),
      Option.some("main")
    );

    const current = workspaceStrategy(
      "worktree",
      Option.none(),
      Option.some("main")
    );

    assert.deepStrictEqual(
      [chosen, current].map((strategy) =>
        Predicate.isTagged(strategy, "Worktree") ? strategy.baseRef : ""
      ),
      ["dev", "main"]
    );
  });
});
