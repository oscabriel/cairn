// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ProjectCommands.ts and the
// thread inbox branches of apps/server/src/orchestration-v2/Orchestrator.ts (dispatchThreadMutation,
// dispatchThreadVisit, thread.auto-settle) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a pure
// planner over the current rows that returns the events to append and the rows to write, or a
// rejection; one live project per workspace root; the settle, unsettle, snooze, pin and visit rules
// and their `updatedAt` stamping; automatic settlement rechecked against the live row. Changed: no
// pull requests, scripts, icons or provider sessions; rows carry the wire `ThreadShell` with Option
// fields; project ids derive from the command id; deleting a project tombstones its threads in the
// same commit; and the server's own commands (create, activity, workspace, auto-settle, snooze
// expiry, message sent, project registration) sit beside the client's in one union. A message the
// user sends clears the manual settle state and ends a snooze (dispatchMessage).
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
  CommandId,
  DisplayText,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@cairn/protocol/Ids";
import { ThinkingLevel } from "@cairn/protocol/Models";
import { RuntimeMode } from "@cairn/protocol/Policy";
import {
  BARE_ROW_FIELDS,
  ProjectShell,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Array as Arr, DateTime, Match, Option, Result, Schema } from "effect";

import type { ProjectRow } from "../projects/Projects.ts";
import type { ThreadRow } from "./ThreadRows.ts";

// Commands only the server issues.

/** Registers a project the server found or made (the scratch project, a repo identity). */
export const ProjectRegister = Schema.TaggedStruct("ProjectRegister", {
  commandId: CommandId,
  projectId: ProjectId,
  kind: ProjectShell.fields.kind,
  title: DisplayText.check(Schema.isMinLength(1)),
  workspaceRoot: TrimmedNonEmptyString,
  repository: ProjectShell.fields.repository,
});

/** Creates a thread's row when it is launched. */
export const ThreadCreate = Schema.TaggedStruct("ThreadCreate", {
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: DisplayText,
  provider: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  thinkingLevel: ThinkingLevel,
  runtimeMode: RuntimeMode,
  branch: ThreadShell.fields.branch,
  worktreePath: ThreadShell.fields.worktreePath,
});

const patchField = <S extends Schema.Top>(schema: S) =>
  Schema.OptionFromOptionalKey(schema);

/**
 * The fields of a thread row the shell projector derives from pi-durable. An absent key leaves the
 * field as it is.
 */
export const ThreadActivityPatch = Schema.Struct({
  activity: patchField(ThreadShell.fields.activity),
  activeRunId: patchField(ThreadShell.fields.activeRunId),
  latestRunRequestedAt: patchField(ThreadShell.fields.latestRunRequestedAt),
  latestRunStartedAt: patchField(ThreadShell.fields.latestRunStartedAt),
  latestRunCompletedAt: patchField(ThreadShell.fields.latestRunCompletedAt),
  queueLength: patchField(ThreadShell.fields.queueLength),
  lastError: patchField(ThreadShell.fields.lastError),
  lastErrorClass: patchField(ThreadShell.fields.lastErrorClass),
  usageLimitResetAt: patchField(ThreadShell.fields.usageLimitResetAt),
  waitingFor: patchField(ThreadShell.fields.waitingFor),
  pendingRuntimeRequest: patchField(ThreadShell.fields.pendingRuntimeRequest),
  pendingCount: patchField(ThreadShell.fields.pendingCount),
  latestVisibleMessage: patchField(ThreadShell.fields.latestVisibleMessage),
  latestUserMessageAt: patchField(ThreadShell.fields.latestUserMessageAt),
  parkedTaskIds: patchField(ThreadShell.fields.parkedTaskIds),
  provider: patchField(ThreadShell.fields.provider),
  modelId: patchField(ThreadShell.fields.modelId),
  thinkingLevel: patchField(ThreadShell.fields.thinkingLevel),
  runtimeMode: patchField(ThreadShell.fields.runtimeMode),
  /** The spend ledger's figure (`usage/SpendLedger.ts`); a cache, so it never moves `updatedAt`. */
  spend: patchField(ThreadShell.fields.spend),
});

/** A thread activity patch. */
export type ThreadActivityPatch = typeof ThreadActivityPatch.Type;

/** An activity patch that changes nothing; spread it and set the keys that changed. */
export const emptyActivityPatch: ThreadActivityPatch = {
  activity: Option.none(),
  activeRunId: Option.none(),
  latestRunRequestedAt: Option.none(),
  latestRunStartedAt: Option.none(),
  latestRunCompletedAt: Option.none(),
  queueLength: Option.none(),
  lastError: Option.none(),
  lastErrorClass: Option.none(),
  usageLimitResetAt: Option.none(),
  waitingFor: Option.none(),
  pendingRuntimeRequest: Option.none(),
  pendingCount: Option.none(),
  latestVisibleMessage: Option.none(),
  latestUserMessageAt: Option.none(),
  parkedTaskIds: Option.none(),
  provider: Option.none(),
  modelId: Option.none(),
  thinkingLevel: Option.none(),
  runtimeMode: Option.none(),
  spend: Option.none(),
};

/** Updates the fields of a thread row derived from pi-durable (the shell projector's command). */
export const ThreadActivityUpdate = Schema.TaggedStruct(
  "ThreadActivityUpdate",
  {
    commandId: CommandId,
    threadId: ThreadId,
    patch: ThreadActivityPatch,
  }
);

/** Records a thread's branch and worktree after launch or a branch rename. */
export const ThreadWorkspaceUpdate = Schema.TaggedStruct(
  "ThreadWorkspaceUpdate",
  {
    commandId: CommandId,
    threadId: ThreadId,
    branch: ThreadShell.fields.branch,
    worktreePath: ThreadShell.fields.worktreePath,
  }
);

/**
 * Settles a quiet thread. Refused when the row changed after `snapshotAt` (the sweep's view) or
 * carries a manual settle state, so a user action always wins over the sweep.
 */
export const ThreadAutoSettle = Schema.TaggedStruct("ThreadAutoSettle", {
  commandId: CommandId,
  threadId: ThreadId,
  snapshotAt: Schema.DateTimeUtc,
  settledAt: Schema.DateTimeUtc,
});

/** Ends a snooze whose time came. Refused when the snooze changed since it was scheduled. */
export const ThreadSnoozeExpire = Schema.TaggedStruct("ThreadSnoozeExpire", {
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: Schema.DateTimeUtc,
});

/**
 * A message the user sent to a thread: clears its manual settle state, so it is back on the active
 * shelf and auto-settle applies to it again, and ends its snooze. Refused when there is neither.
 */
export const ThreadMessageSent = Schema.TaggedStruct("ThreadMessageSent", {
  commandId: CommandId,
  threadId: ThreadId,
});

/** Every command the shell store accepts: the client's `ShellCommand`s and the server's own. */
export const ServerShellCommand = Schema.Union([
  ...ShellCommand.members,
  ProjectRegister,
  ThreadCreate,
  ThreadActivityUpdate,
  ThreadWorkspaceUpdate,
  ThreadAutoSettle,
  ThreadSnoozeExpire,
  ThreadMessageSent,
]);

/** A command the shell store accepts. */
export type ServerShellCommand = typeof ServerShellCommand.Type;

// Events.

/** The kinds of shell events. Rows of other kinds (written by a newer build) are skipped on replay. */
export const ShellEventType = Schema.Literals([
  "project.created",
  "project.updated",
  "project.deleted",
  "thread.created",
  "thread.renamed",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.visited",
  "thread.marked-unread",
  "thread.auto-settle-set",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.activity-updated",
  "thread.workspace-updated",
]);

/** A shell event kind. */
export type ShellEventType = typeof ShellEventType.Type;

/** Which kind of row an event changed. */
export const AggregateKind = Schema.Literals(["project", "thread"]);

/** A planned event, before the log gives it a sequence. */
export type PlannedShellEvent =
  | {
      readonly aggregateKind: "project";
      readonly aggregateId: ProjectId;
      readonly type: ShellEventType;
    }
  | {
      readonly aggregateKind: "thread";
      readonly aggregateId: ThreadId;
      readonly type: ShellEventType;
    };

/** What a command commits: its events in order and the rows they leave behind. */
export interface ShellPlan {
  readonly events: Arr.NonEmptyReadonlyArray<PlannedShellEvent>;
  readonly projects: ReadonlyArray<ProjectRow>;
  readonly threads: ReadonlyArray<ThreadRow>;
}

// Rejections. Each is stored in the command's receipt, so a resent command gets the same answer.

/** The command names a project or thread that does not exist (or was deleted). */
export class ShellTargetNotFound extends Schema.TaggedError<ShellTargetNotFound>()(
  "ShellTargetNotFound",
  {
    message: Schema.String,
    commandType: Schema.String,
    resource: Schema.Literals(["project", "thread"]),
    id: Schema.String,
  }
) {}

/** Another live project already has this folder as its root. */
export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    message: Schema.String,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  }
) {}

/** A value in the command cannot be used. */
export class ShellCommandInvalid extends Schema.TaggedError<ShellCommandInvalid>()(
  "ShellCommandInvalid",
  {
    message: Schema.String,
    commandType: Schema.String,
    field: Schema.OptionFromNullOr(Schema.String),
  }
) {}

/** The row's current state makes the command meaningless or unsafe. */
export class ShellCommandConflict extends Schema.TaggedError<ShellCommandConflict>()(
  "ShellCommandConflict",
  {
    message: Schema.String,
    commandType: Schema.String,
    reason: Schema.Literals(["thread_busy", "stale_state"]),
  }
) {}

/** Why the shell store refused a command. */
export const ShellCommandRejection = Schema.Union([
  ShellTargetNotFound,
  ProjectWorkspaceConflictError,
  ShellCommandInvalid,
  ShellCommandConflict,
]);

/** A refused command's reason. */
export type ShellCommandRejection = typeof ShellCommandRejection.Type;

// Planning.

/** The rows a command reads, loaded by the caller inside the command's transaction. */
export interface ShellCommandState {
  readonly now: DateTime.Utc;
  /** The project the command names (or will create). */
  readonly project: Option.Option<ProjectRow>;
  /** The live project at the command's workspace root, for project creation. */
  readonly workspaceOwner: Option.Option<ProjectRow>;
  /** The thread the command names. */
  readonly thread: Option.Option<ThreadRow>;
  /** The project's threads that are not deleted, for project deletion. */
  readonly projectThreads: ReadonlyArray<ThreadRow>;
}

/** What the caller must load before planning a command. */
export interface ShellCommandTargets {
  readonly projectId: Option.Option<ProjectId>;
  readonly workspaceRoot: Option.Option<string>;
  readonly threadId: Option.Option<ThreadId>;
  readonly projectThreads: boolean;
}

const commandType = (command: ServerShellCommand) => command._tag;

/** The id a project created by `commandId` gets, so a resent create lands on the same row. */
export const projectIdFor = (commandId: CommandId) =>
  ProjectId.make(`prj_${commandId.replaceAll("-", "")}`);

/**
 * Normalizes an absolute folder path: no trailing slash, no `.` or `..` segments, no empty
 * segments. Returns none for a relative or unsafe path. Checked segment by segment: the regular
 * expression it replaces backtracked exponentially on a long path with an empty segment (T40).
 */
export const normalizeWorkspaceRoot = (
  input: string
): Option.Option<string> => {
  if (!input.startsWith("/")) {
    return Option.none();
  }

  const segments = input.slice(1).split("/");

  // One trailing slash is allowed; `/` itself is the root.
  if (segments.at(-1) === "") {
    segments.pop();
  }

  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    return Option.none();
  }

  return Option.some(`/${segments.join("/")}`);
};

const folderName = (workspaceRoot: string) =>
  workspaceRoot.split("/").findLast((segment) => segment.length > 0) ??
  workspaceRoot;

const threadTarget = (command: {
  readonly threadId: ThreadId;
}): ShellCommandTargets => ({
  projectId: Option.none(),
  workspaceRoot: Option.none(),
  threadId: Option.some(command.threadId),
  projectThreads: false,
});

/** The rows `command` reads. */
export const commandTargets = (
  command: ServerShellCommand
): ShellCommandTargets => {
  const none: ShellCommandTargets = {
    projectId: Option.none(),
    workspaceRoot: Option.none(),
    threadId: Option.none(),
    projectThreads: false,
  };

  return Match.valueTags(command, {
    ProjectCreate: (create) => ({
      ...none,
      projectId: Option.some(projectIdFor(create.commandId)),
      workspaceRoot: normalizeWorkspaceRoot(create.workspaceRoot),
    }),
    ProjectRegister: (register) => ({
      ...none,
      projectId: Option.some(register.projectId),
      workspaceRoot: normalizeWorkspaceRoot(register.workspaceRoot),
    }),
    ProjectUpdate: (update) => ({
      ...none,
      projectId: Option.some(update.projectId),
    }),
    ProjectDelete: (remove) => ({
      ...none,
      projectId: Option.some(remove.projectId),
      projectThreads: true,
    }),
    ThreadCreate: (create) => ({
      ...none,
      projectId: Option.some(create.projectId),
      threadId: Option.some(create.threadId),
    }),
    ThreadRename: threadTarget,
    ThreadSettle: threadTarget,
    ThreadUnsettle: threadTarget,
    ThreadSnooze: threadTarget,
    ThreadUnsnooze: threadTarget,
    ThreadPin: threadTarget,
    ThreadUnpin: threadTarget,
    ThreadVisit: threadTarget,
    ThreadMarkUnread: threadTarget,
    ThreadSetAutoSettle: threadTarget,
    ThreadArchive: threadTarget,
    ThreadUnarchive: threadTarget,
    ThreadDelete: threadTarget,
    ThreadActivityUpdate: threadTarget,
    ThreadWorkspaceUpdate: threadTarget,
    ThreadAutoSettle: threadTarget,
    ThreadSnoozeExpire: threadTarget,
    ThreadMessageSent: threadTarget,
  });
};

/** The aggregate a command's receipt is filed under. */
export const commandAggregate = (
  command: ServerShellCommand
): {
  readonly aggregateKind: typeof AggregateKind.Type;
  readonly aggregateId: string;
} => {
  const targets = commandTargets(command);

  return Option.match(targets.threadId, {
    onSome: (threadId) => ({ aggregateKind: "thread", aggregateId: threadId }),
    onNone: () => ({
      aggregateKind: "project",
      aggregateId: Option.getOrElse(targets.projectId, () => ""),
    }),
  });
};

type Planned = Result.Result<ShellPlan, ShellCommandRejection>;

const projectEvent = (
  projectId: ProjectId,
  type: ShellEventType
): PlannedShellEvent => ({
  aggregateKind: "project",
  aggregateId: projectId,
  type,
});

const threadEvent = (
  threadId: ThreadId,
  type: ShellEventType
): PlannedShellEvent => ({
  aggregateKind: "thread",
  aggregateId: threadId,
  type,
});

const threadPlan = (row: ThreadRow, type: ShellEventType): Planned =>
  Result.succeed({
    events: [threadEvent(row.shell.id, type)],
    projects: [],
    threads: [row],
  });

const notFound = (
  command: ServerShellCommand,
  resource: "project" | "thread",
  id: string
) =>
  Result.fail(
    new ShellTargetNotFound({
      message: `${resource === "project" ? "Project" : "Thread"} ${id} does not exist or was deleted, so ${commandType(command)} did nothing. Refresh the sidebar and try again.`,
      commandType: commandType(command),
      resource,
      id,
    })
  );

const conflict = (
  command: ServerShellCommand,
  reason: "thread_busy" | "stale_state",
  detail: string
) =>
  Result.fail(
    new ShellCommandConflict({
      message: `${commandType(command)} was refused: ${detail}`,
      commandType: commandType(command),
      reason,
    })
  );

const invalid = (command: ServerShellCommand, field: string, detail: string) =>
  Result.fail(
    new ShellCommandInvalid({
      message: `${commandType(command)} was refused: ${detail}`,
      commandType: commandType(command),
      field: Option.some(field),
    })
  );

const sameTime = Option.makeEquivalence(DateTime.Equivalence);

const isAfter = (left: DateTime.Utc, right: DateTime.Utc) =>
  DateTime.isGreaterThan(left, right);

/** Whether a thread's agent loop is busy (a run is preparing, running or waiting on the user). */
export const isThreadBusy = (shell: ThreadShell) =>
  shell.activity === "preparing" ||
  shell.activity === "running" ||
  shell.activity === "waiting";

const withShell = (row: ThreadRow, shell: Partial<ThreadShell>): ThreadRow => ({
  ...row,
  shell: { ...row.shell, ...shell },
});

const settle = (
  row: ThreadRow,
  now: DateTime.Utc,
  settledAt: DateTime.Utc
): ThreadRow => {
  const { shell } = row;
  const wasPinned = Option.isSome(shell.pinnedAt);

  const alreadySettled =
    Option.contains(shell.settledOverride, "settled") &&
    Option.isSome(shell.settledAt) &&
    !wasPinned;

  const wasSnoozed =
    Option.isSome(shell.snoozedUntil) || Option.isSome(shell.snoozedAt);

  return withShell(row, {
    settledOverride: Option.some("settled"),
    settledAt: alreadySettled ? shell.settledAt : Option.some(settledAt),
    unsettledAt: Option.none(),
    pinnedAt: Option.none(),
    pinOrderKey: Option.none(),
    activeOrderKey: Option.none(),
    snoozedUntil: Option.none(),
    snoozedAt: Option.none(),
    updatedAt: alreadySettled && !wasSnoozed ? shell.updatedAt : now,
  });
};

const unsnooze = (row: ThreadRow, now: DateTime.Utc): ThreadRow => {
  if (Option.isNone(row.shell.snoozedUntil)) {
    return row;
  }

  return {
    ...withShell(row, {
      snoozedUntil: Option.none(),
      snoozedAt: Option.none(),
      updatedAt: now,
    }),
    lastSnoozeWakeAt: Option.some(now),
  };
};

/**
 * What a sent message does to a row: the manual settle state goes back to none (keeping the time of
 * a manual unsettle), then the snooze ends. The events name what changed; none when nothing did.
 */
const messageSent = (
  row: ThreadRow,
  now: DateTime.Utc
): Option.Option<ShellPlan> => {
  const { shell } = row;

  const unsettled = Option.match(shell.settledOverride, {
    onNone: () => row,
    onSome: (override) =>
      withShell(row, {
        settledOverride: Option.none(),
        settledAt: Option.none(),
        unsettledAt:
          override === "active" ? shell.unsettledAt : Option.some(now),
        updatedAt: now,
      }),
  });

  const events = Arr.getSomes([
    Option.as(shell.settledOverride, threadEvent(shell.id, "thread.unsettled")),
    Option.as(shell.snoozedUntil, threadEvent(shell.id, "thread.unsnoozed")),
  ]);

  return Arr.isReadonlyArrayNonEmpty(events)
    ? Option.some({
        events,
        projects: [],
        threads: [unsnooze(unsettled, now)],
      })
    : Option.none();
};

const settleBlocker = (shell: ThreadShell): Option.Option<string> => {
  if (Option.isSome(shell.pendingRuntimeRequest)) {
    return Option.some(
      "the thread is waiting on an approval or a question. Answer it, then settle."
    );
  }

  if (isThreadBusy(shell)) {
    return Option.some(
      "the thread is still running. Stop it or let it finish, then settle."
    );
  }

  if (shell.queueLength > 0) {
    return Option.some(
      "the thread has a queued message. Send it or withdraw it, then settle."
    );
  }

  return Option.none();
};

const sameThreadShell = Schema.toEquivalence(ThreadShell);

const applyPatch = (
  row: ThreadRow,
  patch: ThreadActivityPatch,
  now: DateTime.Utc
): ThreadRow => {
  const { shell } = row;

  const next: ThreadShell = {
    ...shell,
    activity: Option.getOrElse(patch.activity, () => shell.activity),
    activeRunId: Option.getOrElse(patch.activeRunId, () => shell.activeRunId),
    latestRunRequestedAt: Option.getOrElse(
      patch.latestRunRequestedAt,
      () => shell.latestRunRequestedAt
    ),
    latestRunStartedAt: Option.getOrElse(
      patch.latestRunStartedAt,
      () => shell.latestRunStartedAt
    ),
    latestRunCompletedAt: Option.getOrElse(
      patch.latestRunCompletedAt,
      () => shell.latestRunCompletedAt
    ),
    queueLength: Option.getOrElse(patch.queueLength, () => shell.queueLength),
    lastError: Option.getOrElse(patch.lastError, () => shell.lastError),
    lastErrorClass: Option.getOrElse(
      patch.lastErrorClass,
      () => shell.lastErrorClass
    ),
    usageLimitResetAt: Option.getOrElse(
      patch.usageLimitResetAt,
      () => shell.usageLimitResetAt
    ),
    waitingFor: Option.getOrElse(patch.waitingFor, () => shell.waitingFor),
    pendingRuntimeRequest: Option.getOrElse(
      patch.pendingRuntimeRequest,
      () => shell.pendingRuntimeRequest
    ),
    pendingCount: Option.getOrElse(
      patch.pendingCount,
      () => shell.pendingCount
    ),
    latestVisibleMessage: Option.getOrElse(
      patch.latestVisibleMessage,
      () => shell.latestVisibleMessage
    ),
    latestUserMessageAt: Option.getOrElse(
      patch.latestUserMessageAt,
      () => shell.latestUserMessageAt
    ),
    parkedTaskIds: Option.getOrElse(
      patch.parkedTaskIds,
      () => shell.parkedTaskIds
    ),
    provider: Option.getOrElse(patch.provider, () => shell.provider),
    modelId: Option.getOrElse(patch.modelId, () => shell.modelId),
    thinkingLevel: Option.getOrElse(
      patch.thinkingLevel,
      () => shell.thinkingLevel
    ),
    runtimeMode: Option.getOrElse(patch.runtimeMode, () => shell.runtimeMode),
  };

  const changed = !sameThreadShell(next, shell);
  const spend = Option.getOrElse(patch.spend, () => shell.spend);

  // A spend figure is derived from the ledger: it changes the row but is not activity.
  return {
    ...row,
    shell: changed ? { ...next, spend, updatedAt: now } : { ...shell, spend },
  };
};

const planProjectCreate = (
  command: ServerShellCommand,
  state: ShellCommandState,
  input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly title: Option.Option<string>;
    readonly kind: ProjectShell["kind"];
    readonly repository: ProjectShell["repository"];
  }
): Planned => {
  const root = normalizeWorkspaceRoot(input.workspaceRoot);

  if (Option.isNone(root)) {
    return invalid(
      command,
      "workspaceRoot",
      `${input.workspaceRoot} is not an absolute folder path. Choose a folder on the Beelink.`
    );
  }

  if (Option.isSome(state.project)) {
    return conflict(
      command,
      "stale_state",
      `project ${input.projectId} already exists.`
    );
  }

  if (Option.isSome(state.workspaceOwner)) {
    const owner = state.workspaceOwner.value.shell;

    return Result.fail(
      new ProjectWorkspaceConflictError({
        message: `${root.value} is already the root of project ${owner.title}. Open that project instead of adding the folder again.`,
        workspaceRoot: root.value,
        conflictingProjectId: owner.id,
      })
    );
  }

  const title = Option.getOrElse(input.title, () => folderName(root.value));

  if (title.trim().length === 0) {
    return invalid(command, "title", "a project title cannot be empty.");
  }

  const shell: ProjectShell = {
    id: input.projectId,
    title,
    kind: input.kind,
    workspaceRoot: root.value,
    repository: input.repository,
    defaultModel: Option.none(),
    createdAt: state.now,
    updatedAt: state.now,
  };

  return Result.succeed({
    events: [projectEvent(input.projectId, "project.created")],
    projects: [{ shell, deletedAt: Option.none() }],
    threads: [],
  });
};

const liveProject = (
  command: ServerShellCommand,
  state: ShellCommandState,
  projectId: ProjectId
): Result.Result<ProjectRow, ShellCommandRejection> =>
  Option.match(
    Option.filter(state.project, (row) => Option.isNone(row.deletedAt)),
    {
      onNone: () => notFound(command, "project", projectId),
      onSome: Result.succeed,
    }
  );

const liveThread = (
  command: ServerShellCommand,
  state: ShellCommandState,
  threadId: ThreadId
): Result.Result<ThreadRow, ShellCommandRejection> =>
  Option.match(
    Option.filter(state.thread, (row) => Option.isNone(row.deletedAt)),
    {
      onNone: () => notFound(command, "thread", threadId),
      onSome: Result.succeed,
    }
  );

/** Refuses inbox changes to an archived thread: it is not in the sidebar to change. */
const unarchivedThread = (
  command: ServerShellCommand,
  state: ShellCommandState,
  threadId: ThreadId
): Result.Result<ThreadRow, ShellCommandRejection> =>
  Result.flatMap(liveThread(command, state, threadId), (row) =>
    Option.isSome(row.shell.archivedAt)
      ? conflict(
          command,
          "stale_state",
          `thread ${threadId} is archived. Unarchive it first.`
        )
      : Result.succeed(row)
  );

/**
 * Plans `command` against the rows it reads. Returns the events and the rows to write, or the
 * rejection to store in its receipt. Pure: the caller loads `state` and commits the plan in one
 * transaction.
 */
export const planShellCommand = (
  command: ServerShellCommand,
  state: ShellCommandState
): Planned => {
  const { now } = state;

  return Match.valueTags(command, {
    ProjectCreate: (create) =>
      planProjectCreate(command, state, {
        projectId: projectIdFor(create.commandId),
        workspaceRoot: create.workspaceRoot,
        title: create.title,
        kind: "folder",
        repository: Option.none(),
      }),

    ProjectRegister: (register) =>
      planProjectCreate(command, state, {
        projectId: register.projectId,
        workspaceRoot: register.workspaceRoot,
        title: Option.some(register.title),
        kind: register.kind,
        repository: register.repository,
      }),

    ProjectUpdate: (update) =>
      Result.flatMap(
        liveProject(command, state, update.projectId),
        (row): Planned => {
          if (
            Option.exists(update.title, (title) => title.trim().length === 0)
          ) {
            return invalid(
              command,
              "title",
              "a project title cannot be empty."
            );
          }

          const shell: ProjectShell = {
            ...row.shell,
            title: Option.getOrElse(update.title, () => row.shell.title),
            defaultModel: Option.getOrElse(
              update.defaultModel,
              () => row.shell.defaultModel
            ),
            updatedAt: now,
          };

          return Result.succeed({
            events: [projectEvent(update.projectId, "project.updated")],
            projects: [{ ...row, shell }],
            threads: [],
          });
        }
      ),

    ProjectDelete: (remove) =>
      Result.map(
        liveProject(command, state, remove.projectId),
        (row): ShellPlan => {
          const threads = state.projectThreads.map((thread): ThreadRow => ({
            ...withShell(thread, { updatedAt: now }),
            deletedAt: Option.some(now),
          }));

          return {
            events: Arr.append(
              threads.map((thread) =>
                threadEvent(thread.shell.id, "thread.deleted")
              ),
              projectEvent(remove.projectId, "project.deleted")
            ),
            projects: [
              {
                shell: { ...row.shell, updatedAt: now },
                deletedAt: Option.some(now),
              },
            ],
            threads,
          };
        }
      ),

    ThreadCreate: (create) =>
      Result.flatMap(liveProject(command, state, create.projectId), () => {
        if (Option.isSome(state.thread)) {
          return conflict(
            command,
            "stale_state",
            `thread ${create.threadId} already exists.`
          );
        }

        const shell: ThreadShell = {
          id: create.threadId,
          projectId: create.projectId,
          title: create.title,
          provider: create.provider,
          modelId: create.modelId,
          thinkingLevel: create.thinkingLevel,
          runtimeMode: create.runtimeMode,
          branch: create.branch,
          worktreePath: create.worktreePath,
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
          createdAt: now,
          updatedAt: now,
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
        };

        return threadPlan(
          { shell, deletedAt: Option.none(), lastSnoozeWakeAt: Option.none() },
          "thread.created"
        );
      }),

    ThreadRename: (rename) =>
      Result.flatMap(liveThread(command, state, rename.threadId), (row) =>
        threadPlan(
          withShell(row, { title: rename.title, updatedAt: now }),
          "thread.renamed"
        )
      ),

    ThreadSettle: (settleCommand) =>
      Result.flatMap(
        unarchivedThread(command, state, settleCommand.threadId),
        (row) =>
          Option.match(settleBlocker(row.shell), {
            onSome: (detail) => conflict(command, "thread_busy", detail),
            onNone: () => threadPlan(settle(row, now, now), "thread.settled"),
          })
      ),

    ThreadUnsettle: (unsettle) =>
      Result.flatMap(
        unarchivedThread(command, state, unsettle.threadId),
        (row) => {
          const alreadyActive = Option.contains(
            row.shell.settledOverride,
            "active"
          );

          return threadPlan(
            withShell(row, {
              settledOverride: Option.some("active"),
              settledAt: Option.none(),
              unsettledAt: alreadyActive
                ? row.shell.unsettledAt
                : Option.some(now),
              updatedAt: alreadyActive ? row.shell.updatedAt : now,
            }),
            "thread.unsettled"
          );
        }
      ),

    ThreadSnooze: (snooze) =>
      Result.flatMap(
        unarchivedThread(command, state, snooze.threadId),
        (row) => {
          if (!isAfter(snooze.until, now)) {
            return invalid(
              command,
              "until",
              "the wake time is not in the future. Pick a later time."
            );
          }

          if (Option.isSome(row.shell.pendingRuntimeRequest)) {
            return conflict(
              command,
              "thread_busy",
              "the thread is waiting on an approval or a question. Answer it before snoozing."
            );
          }

          if (row.shell.queueLength > 0) {
            return conflict(
              command,
              "thread_busy",
              "the thread has a queued message. Send it or withdraw it before snoozing."
            );
          }

          // Always restamp, even for the same wake time: a snooze after a failure woke the thread
          // means "I saw it, not now".
          return threadPlan(
            withShell(row, {
              snoozedUntil: Option.some(snooze.until),
              snoozedAt: Option.some(now),
              updatedAt: now,
            }),
            "thread.snoozed"
          );
        }
      ),

    ThreadUnsnooze: (wake) =>
      Result.flatMap(unarchivedThread(command, state, wake.threadId), (row) =>
        threadPlan(unsnooze(row, now), "thread.unsnoozed")
      ),

    ThreadPin: (pin) =>
      Result.flatMap(unarchivedThread(command, state, pin.threadId), (row) => {
        const { shell } = row;
        const alreadyPinned = Option.isSome(shell.pinnedAt);
        const wasSettled = Option.contains(shell.settledOverride, "settled");
        const wasSnoozed = Option.isSome(shell.snoozedUntil);

        return threadPlan(
          {
            ...withShell(row, {
              pinnedAt: alreadyPinned ? shell.pinnedAt : Option.some(now),
              settledOverride: wasSettled
                ? Option.some("active")
                : shell.settledOverride,
              settledAt: wasSettled ? Option.none() : shell.settledAt,
              snoozedUntil: Option.none(),
              snoozedAt: Option.none(),
              updatedAt:
                alreadyPinned && !wasSettled && !wasSnoozed
                  ? shell.updatedAt
                  : now,
            }),
            lastSnoozeWakeAt: wasSnoozed
              ? Option.some(now)
              : row.lastSnoozeWakeAt,
          },
          "thread.pinned"
        );
      }),

    ThreadUnpin: (unpin) =>
      Result.flatMap(unarchivedThread(command, state, unpin.threadId), (row) =>
        threadPlan(
          withShell(row, {
            pinnedAt: Option.none(),
            pinOrderKey: Option.none(),
            updatedAt: Option.isSome(row.shell.pinnedAt)
              ? now
              : row.shell.updatedAt,
          }),
          "thread.unpinned"
        )
      ),

    ThreadVisit: (visit) =>
      Result.flatMap(liveThread(command, state, visit.threadId), (row) => {
        // A visit changes read state only; it never bumps `updatedAt`.
        const movesForward = Option.match(row.shell.lastVisitedAt, {
          onNone: () => true,
          onSome: (previous) => isAfter(visit.at, previous),
        });

        return threadPlan(
          movesForward
            ? withShell(row, { lastVisitedAt: Option.some(visit.at) })
            : row,
          "thread.visited"
        );
      }),

    ThreadMarkUnread: (markUnread) =>
      Result.flatMap(liveThread(command, state, markUnread.threadId), (row) =>
        Option.match(row.shell.latestRunCompletedAt, {
          onNone: () =>
            conflict(
              command,
              "stale_state",
              `thread ${markUnread.threadId} has no finished run to mark unread.`
            ),
          onSome: (completedAt) =>
            threadPlan(
              withShell(row, {
                lastVisitedAt: Option.some(
                  DateTime.subtract(completedAt, { milliseconds: 1 })
                ),
              }),
              "thread.marked-unread"
            ),
        })
      ),

    ThreadSetAutoSettle: (set) =>
      Result.flatMap(unarchivedThread(command, state, set.threadId), (row) => {
        const unchanged =
          set.enabled === Option.isNone(row.shell.autoSettleDisabledAt);

        return threadPlan(
          withShell(row, {
            autoSettleDisabledAt: set.enabled
              ? Option.none()
              : Option.orElse(row.shell.autoSettleDisabledAt, () =>
                  Option.some(now)
                ),
            updatedAt: unchanged ? row.shell.updatedAt : now,
          }),
          "thread.auto-settle-set"
        );
      }),

    ThreadArchive: (archive) =>
      Result.flatMap(liveThread(command, state, archive.threadId), (row) =>
        Option.isSome(row.shell.archivedAt)
          ? conflict(
              command,
              "stale_state",
              `thread ${archive.threadId} is already archived.`
            )
          : threadPlan(
              withShell(row, { archivedAt: Option.some(now), updatedAt: now }),
              "thread.archived"
            )
      ),

    ThreadUnarchive: (unarchive) =>
      Result.flatMap(liveThread(command, state, unarchive.threadId), (row) =>
        Option.isNone(row.shell.archivedAt)
          ? conflict(
              command,
              "stale_state",
              `thread ${unarchive.threadId} is not archived.`
            )
          : threadPlan(
              withShell(row, { archivedAt: Option.none(), updatedAt: now }),
              "thread.unarchived"
            )
      ),

    ThreadDelete: (remove) =>
      Result.flatMap(liveThread(command, state, remove.threadId), (row) =>
        threadPlan(
          {
            ...withShell(row, { updatedAt: now }),
            deletedAt: Option.some(now),
          },
          "thread.deleted"
        )
      ),

    ThreadActivityUpdate: (update) =>
      Result.flatMap(liveThread(command, state, update.threadId), (row) =>
        threadPlan(
          applyPatch(row, update.patch, now),
          "thread.activity-updated"
        )
      ),

    ThreadWorkspaceUpdate: (update) =>
      Result.flatMap(liveThread(command, state, update.threadId), (row) =>
        threadPlan(
          withShell(row, {
            branch: update.branch,
            worktreePath: update.worktreePath,
            updatedAt: now,
          }),
          "thread.workspace-updated"
        )
      ),

    ThreadAutoSettle: (auto) =>
      Result.flatMap(unarchivedThread(command, state, auto.threadId), (row) =>
        Option.isSome(row.shell.settledOverride) ||
        isAfter(row.shell.updatedAt, auto.snapshotAt)
          ? conflict(
              command,
              "stale_state",
              `thread ${auto.threadId} changed after the settlement sweep read it.`
            )
          : threadPlan(settle(row, now, auto.settledAt), "thread.settled")
      ),

    ThreadMessageSent: (sent) =>
      Result.flatMap(liveThread(command, state, sent.threadId), (row) =>
        Option.match(messageSent(row, now), {
          onNone: () =>
            conflict(
              command,
              "stale_state",
              `thread ${sent.threadId} is neither settled by hand nor snoozed.`
            ),
          onSome: Result.succeed,
        })
      ),

    ThreadSnoozeExpire: (expire) =>
      Result.flatMap(
        unarchivedThread(command, state, expire.threadId),
        (row) =>
          sameTime(row.shell.snoozedUntil, Option.some(expire.snoozedUntil))
            ? threadPlan(unsnooze(row, now), "thread.unsnoozed")
            : conflict(
                command,
                "stale_state",
                `thread ${expire.threadId} was snoozed again or woken since its timer was set.`
              )
      ),
  });
};
