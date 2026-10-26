// Ported from github.com/pingdotgg/t3code, apps/web/src/components/BranchToolbar.logic.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the workspace mode a new thread starts in (the
// project's checkout or a new worktree), its labels, the locked label once the thread has started,
// and the branch picker's label and ordering (the current branch first, then the default, local
// before remote). Changed: Cairn has one environment, so the environment options are gone, and the
// mode maps to the protocol's launch strategies (`Root` or `Worktree`).
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

import { NewWorktreeWorkspace, RootWorkspace } from "@cairn/protocol/Launch";
import type { WorkspaceStrategy } from "@cairn/protocol/Launch";
import type { Branch } from "@cairn/protocol/Projects";
import { Array, Option, Order, Schema } from "effect";

/** Where a new thread works: the project's own checkout, or a new worktree. */
export const EnvMode = Schema.Literals(["local", "worktree"]);

export type EnvMode = typeof EnvMode.Type;

/** The label of a workspace mode in the strip and its menu. */
export const resolveEnvModeLabel = (mode: EnvMode): string =>
  mode === "worktree" ? "New worktree" : "Current checkout";

/** The label once the thread has started and the workspace can no longer change. */
export const resolveLockedWorkspaceLabel = (
  worktreePath: Option.Option<string>,
  mode: EnvMode
): string => {
  if (Option.isSome(worktreePath)) {
    return "Worktree";
  }

  return mode === "worktree"
    ? resolveEnvModeLabel("worktree")
    : "Local checkout";
};

/** The branch label the strip shows: the chosen base, else the checkout's current branch. */
export const resolveBranchLabel = (
  chosen: Option.Option<string>,
  current: Option.Option<string>
): Option.Option<string> => Option.orElse(chosen, () => current);

const branchOrder = (current: Option.Option<string>): Order.Order<Branch> =>
  Order.combineAll([
    Order.mapInput(Order.flip(Order.Boolean), (branch: Branch) =>
      Option.contains(current, branch.name)
    ),
    Order.mapInput(
      Order.flip(Order.Boolean),
      (branch: Branch) => branch.isDefault
    ),
    Order.mapInput(Order.Boolean, (branch: Branch) => branch.isRemote),
    Order.mapInput(Order.String, (branch: Branch) => branch.name),
  ]);

/** The branches the picker lists for `query`: current first, then the default, local before remote. */
export const filterBranches = (
  branches: ReadonlyArray<Branch>,
  current: Option.Option<string>,
  query: string
): ReadonlyArray<Branch> => {
  const needle = query.trim().toLowerCase();

  return Array.sort(
    Array.filter(
      branches,
      (branch) =>
        needle.length === 0 || branch.name.toLowerCase().includes(needle)
    ),
    branchOrder(current)
  );
};

/** The launch strategy for a draft's mode and chosen base branch. */
export const workspaceStrategy = (
  mode: EnvMode,
  baseBranch: Option.Option<string>,
  current: Option.Option<string>
): WorkspaceStrategy => {
  if (mode === "local") {
    return RootWorkspace.make({ branch: Option.none() });
  }

  return NewWorktreeWorkspace.make({
    baseRef: Option.getOrElse(
      resolveBranchLabel(baseBranch, current),
      () => "HEAD"
    ),
    branch: Option.none(),
    startFromOrigin: false,
  });
};
