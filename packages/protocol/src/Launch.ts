// Ported from github.com/pingdotgg/t3code, packages/contracts/src/orchestrationV2.ts
// (ThreadLaunchWorkspaceStrategy, lines 514 to 531; ThreadLaunchInput and its result, line 3154)
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the three workspace strategies and the launch
// command that creates a thread and sends its first message at once. Changed: the client mints the
// thread id, the model is a pi-ai provider and model id, the first message is a Cairn turn, and a
// launch in a folder project makes or refreshes the project's one project thread.
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

import { Schema } from "effect";

import {
  CommandId,
  DisplayText,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import { ModelRef, ThinkingLevel } from "./Models.ts";
import { RuntimeMode } from "./Policy.ts";
import { TurnInput } from "./Thread.ts";

/** Run in the project's own checkout, optionally on a named branch. */
export const RootWorkspace = Schema.TaggedStruct("Root", {
  branch: Schema.OptionFromNullOr(TrimmedNonEmptyString),
});

/** Run in a worktree that already exists. */
export const ExistingWorktreeWorkspace = Schema.TaggedStruct(
  "ExistingWorktree",
  {
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  }
);

/**
 * Run in a new worktree from `baseRef`. Without a branch the thread gets a temporary
 * `cairn/<8 hex>` branch, renamed later from the thread's title.
 */
export const NewWorktreeWorkspace = Schema.TaggedStruct("Worktree", {
  baseRef: TrimmedNonEmptyString,
  branch: Schema.OptionFromNullOr(TrimmedNonEmptyString),
  /** Fetch and branch from the remote's `baseRef` rather than the local one. */
  startFromOrigin: Schema.Boolean,
});

/** Where a new thread's arms run. */
export const WorkspaceStrategy = Schema.Union([
  RootWorkspace,
  ExistingWorktreeWorkspace,
  NewWorktreeWorkspace,
]);

export type WorkspaceStrategy = typeof WorkspaceStrategy.Type;

/** `thread.launch` input. Idempotent by `commandId`: a resent launch returns the first result. */
export const ThreadLaunchInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  /** A title the user gave; none lets the title model name the thread from its first message. */
  title: Schema.OptionFromNullOr(DisplayText),
  model: ModelRef,
  thinkingLevel: ThinkingLevel,
  runtimeMode: RuntimeMode,
  workspace: WorkspaceStrategy,
  initialMessage: TurnInput,
  /**
   * In a folder project, a launch makes the project thread (the user, 2026-10-29): the first one
   * marks it, and a later one refreshes it, archiving the one it replaces. Naming the project
   * thread the client saw makes the refresh refuse (`InvalidInput` on `replaces`) when another
   * device moved the mark first; absent, it replaces whichever is current. Not allowed in the
   * scratch project, where every launch is a scratch thread of its own.
   */
  replaces: Schema.optionalKey(ThreadId),
});

export type ThreadLaunchInput = typeof ThreadLaunchInput.Type;

/** `thread.launch` result. */
export const ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  /** True when this `commandId` had already launched the thread. */
  resumed: Schema.Boolean,
});

export type ThreadLaunchResult = typeof ThreadLaunchResult.Type;
