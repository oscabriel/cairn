// Ported from github.com/pingdotgg/t3code, packages/contracts/src/{orchestrationV2.ts
// (OrchestrationV2Command's thread inbox commands, DispatchCommandResult), orchestrationProject.ts
// (project create, update and delete)} at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the inbox
// command set and `{sequence}` as the result. Changed: one tagged union, every command carries its
// client-minted `commandId`, and run, fork and pull request commands are not shell commands.
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
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";
import { ModelRef } from "./Models.ts";

/** Add a folder on the Beelink as a project. */
export const ProjectCreate = Schema.TaggedStruct("ProjectCreate", {
  commandId: CommandId,
  workspaceRoot: TrimmedNonEmptyString,
  title: Schema.OptionFromNullOr(DisplayText),
});

/** Rename a project or change its default model; an absent key leaves that field as it is. */
export const ProjectUpdate = Schema.TaggedStruct("ProjectUpdate", {
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.OptionFromOptionalKey(DisplayText),
  defaultModel: Schema.OptionFromOptionalKey(Schema.OptionFromNullOr(ModelRef)),
});

/** Remove a project from the sidebar. Its folder and its threads' transcripts stay. */
export const ProjectDelete = Schema.TaggedStruct("ProjectDelete", {
  commandId: CommandId,
  projectId: ProjectId,
});

/** Rename a thread. */
export const ThreadRename = Schema.TaggedStruct("ThreadRename", {
  commandId: CommandId,
  threadId: ThreadId,
  title: DisplayText.check(Schema.isMinLength(1)),
});

/** Settle a thread by hand: it leaves the active shelf until something new happens. */
export const ThreadSettle = Schema.TaggedStruct("ThreadSettle", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Bring a thread back to the active shelf by hand (also the undo of a settle). */
export const ThreadUnsettle = Schema.TaggedStruct("ThreadUnsettle", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Hide a thread until `until`. */
export const ThreadSnooze = Schema.TaggedStruct("ThreadSnooze", {
  commandId: CommandId,
  threadId: ThreadId,
  until: Schema.DateTimeUtc,
});

/** Wake a snoozed thread now. */
export const ThreadUnsnooze = Schema.TaggedStruct("ThreadUnsnooze", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Pin a thread to the top of the sidebar. */
export const ThreadPin = Schema.TaggedStruct("ThreadPin", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Unpin a thread. */
export const ThreadUnpin = Schema.TaggedStruct("ThreadUnpin", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Record that the user looked at a thread at `at`; clears unseen completion. */
export const ThreadVisit = Schema.TaggedStruct("ThreadVisit", {
  commandId: CommandId,
  threadId: ThreadId,
  at: Schema.DateTimeUtc,
});

/** Mark a thread unseen again. */
export const ThreadMarkUnread = Schema.TaggedStruct("ThreadMarkUnread", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Turn automatic settling off or back on for one thread. */
export const ThreadSetAutoSettle = Schema.TaggedStruct("ThreadSetAutoSettle", {
  commandId: CommandId,
  threadId: ThreadId,
  enabled: Schema.Boolean,
});

/** Archive a thread: it leaves the shell; its transcript stays in the brain. */
export const ThreadArchive = Schema.TaggedStruct("ThreadArchive", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Bring an archived thread back to the shell. */
export const ThreadUnarchive = Schema.TaggedStruct("ThreadUnarchive", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Delete a thread from the shell for good (its pi-durable conversation is tombstoned, not erased). */
export const ThreadDelete = Schema.TaggedStruct("ThreadDelete", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** One command for `shell.dispatch`. Idempotent by `commandId`. */
export const ShellCommand = Schema.Union([
  ProjectCreate,
  ProjectUpdate,
  ProjectDelete,
  ThreadRename,
  ThreadSettle,
  ThreadUnsettle,
  ThreadSnooze,
  ThreadUnsnooze,
  ThreadPin,
  ThreadUnpin,
  ThreadVisit,
  ThreadMarkUnread,
  ThreadSetAutoSettle,
  ThreadArchive,
  ThreadUnarchive,
  ThreadDelete,
]);

export type ShellCommand = typeof ShellCommand.Type;

/** `shell.dispatch` result: the shell sequence the command's event was committed at. */
export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});

export type DispatchResult = typeof DispatchResult.Type;
