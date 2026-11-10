// `shell.subscribe`, `shell.dispatch`, `shell.previousThreads` and `shell.earlierThread`: thin calls
// into the shell store that translate its failures into the protocol's public errors, carrying the
// RPC request id. A `ProjectCreate` first
// passes `FolderRules` (the deny list, dot folders, links escaping the home) and is committed with
// the folder's real path. Deleting, archiving or clearing a thread, or deleting a project, first
// stops the runs it removes and their working subagents (queue cleared, stop hooks run; ADR 0028
// as amended on 2026-11-09), so a hung thread that is deleted frees its Claude Code child instead
// of holding it for hours, and no child goes on working under a parent whose row is gone with its
// Stop all. A resent command whose id already has a receipt stops nothing: its first send did,
// and the thread may have a newer run since. Clearing a scratch thread then removes its folder
// once the clear is committed; a crash between the two leaves the folder to the scratch boot
// repair.

import {
  Conflict,
  InvalidInput,
  LiveStreamOverflow,
  NotFound,
  Unavailable,
} from "@cairn/protocol/Errors";
import type { ThreadId } from "@cairn/protocol/Ids";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Effect, Layer, Option, Predicate, Stream } from "effect";

import { FolderRules } from "../projects/FolderRules.ts";
import { Projects } from "../projects/Projects.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import { CommandReceipts } from "../shell/CommandReceipts.ts";
import { EventSink } from "../shell/EventSink.ts";
import type { ShellStoreError } from "../shell/ShellStoreError.ts";
import { ShellStream } from "../shell/ShellStream.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { Threads } from "../threads/Threads.ts";

const unavailable = (requestId: string) => (failure: ShellStoreError) =>
  new Unavailable({
    message: `${failure.message} (${failure.operation})`,
    requestId: Option.some(requestId),
  });

/** The shell stream handler: snapshot or replay, then live rows. */
export const ShellSubscribeHandler = CairnRpcs.toLayerHandler(
  "shell.subscribe",
  Effect.gen(function* () {
    const shell = yield* ShellStream;

    return (input, { requestId }) =>
      shell.subscribe(input).pipe(
        Stream.catchTags({
          LiveStreamBufferError: (failure) =>
            Stream.fail(
              new LiveStreamOverflow({
                message: failure.message,
                requestId: Option.some(String(requestId)),
              })
            ),
          ShellStoreError: (failure) =>
            Stream.fail(unavailable(String(requestId))(failure)),
        })
      );
  })
);

/** The shell command handler: idempotent by command id, rejections as typed errors. */
export const ShellDispatchHandler = CairnRpcs.toLayerHandler(
  "shell.dispatch",
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const receipts = yield* CommandReceipts;
    const folders = yield* FolderRules;
    const threads = yield* Threads;
    const rows = yield* ThreadRows;
    const projects = yield* Projects;
    const scratch = yield* ScratchProject;

    /** Whether `threadId` is a scratch thread a clear would remove; the planner refuses others. */
    const isScratchThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      const row = yield* rows.get(threadId);

      if (Option.isNone(row) || Option.isSome(row.value.deletedAt)) {
        return false;
      }

      const project = yield* projects.get(row.value.shell.projectId);

      return Option.exists(project, (found) => found.shell.kind === "scratch");
    });

    /** The threads whose runs `command` removes from the shell. */
    const removedRuns = (
      command: ShellCommand
    ): Effect.Effect<ReadonlyArray<ThreadId>, ShellStoreError> => {
      if (Predicate.isTagged(command, "ThreadClear")) {
        return Effect.map(isScratchThread(command.threadId), (scratchThread) =>
          scratchThread ? [command.threadId] : []
        );
      }

      if (
        Predicate.isTagged(command, "ThreadDelete") ||
        Predicate.isTagged(command, "ThreadArchive")
      ) {
        return Effect.succeed([command.threadId]);
      }

      if (Predicate.isTagged(command, "ProjectDelete")) {
        return Effect.map(rows.listByProject(command.projectId), (live) =>
          live.map((row) => row.shell.id)
        );
      }

      return Effect.succeed([]);
    };

    /**
     * The threads whose runs `command` removes from the shell; none for a resent command, whose
     * receipt holds the first answer.
     */
    const runsEndedBy = Effect.fnUntraced(function* (
      command: ShellCommand
    ): Effect.fn.Return<ReadonlyArray<ThreadId>, ShellStoreError> {
      if (Option.isSome(yield* receipts.find(command.commandId))) {
        return [];
      }

      return yield* removedRuns(command);
    });

    /**
     * Stops each run and its working subagents' runs (Stop all): a removed thread leaves no row to
     * stop its children from. A thread the brain never ensured has none, and any other failure is
     * logged.
     */
    const stopRuns = (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          threads
            .stop({
              threadId,
              clearQueue: true,
              subagents: Option.some("stop"),
            })
            .pipe(
              Effect.catchTags({
                HarnessError: (failure) =>
                  failure.reason === "thread_not_found"
                    ? Effect.void
                    : Effect.logWarning("run not stopped before removal").pipe(
                        Effect.annotateLogs({
                          threadId,
                          reason: failure.message,
                        })
                      ),
                LaunchStoreError: (failure) =>
                  Effect.logWarning("launch not stopped before removal").pipe(
                    Effect.annotateLogs({ threadId, reason: failure.message })
                  ),
              })
            ),
        { concurrency: "unbounded", discard: true }
      );

    /**
     * Removes a cleared scratch thread's folder. A failure is logged and left to the scratch boot
     * repair: the thread is already gone from the shell.
     */
    const releaseFolders = (threadId: ThreadId) =>
      scratch.releaseThread(threadId).pipe(
        Effect.tap((removed) =>
          Effect.logInfo("scratch thread cleared").pipe(
            Effect.annotateLogs({
              event: "scratch_thread_cleared",
              threadId,
              folders: removed.length,
            })
          )
        ),
        Effect.catchTag("ScratchError", (failure) =>
          Effect.logWarning("scratch folder not removed").pipe(
            Effect.annotateLogs({
              event: "scratch_folder_release_failed",
              threadId,
              reason: failure.message,
            })
          )
        ),
        Effect.asVoid
      );

    /** The command as it is committed: a new project's folder checked and made real. */
    const admitted = (
      command: ShellCommand,
      id: Option.Option<string>
    ): Effect.Effect<ShellCommand, NotFound> =>
      Predicate.isTagged(command, "ProjectCreate")
        ? folders.check(command.workspaceRoot, "add").pipe(
            Effect.map((workspaceRoot) => ({ ...command, workspaceRoot })),
            Effect.catchTag("FolderRefused", (refused) =>
              Effect.fail(
                new NotFound({
                  message: refused.message,
                  resource: "folder",
                  id: refused.path,
                  requestId: id,
                })
              )
            )
          )
        : Effect.succeed(command);

    return (command, { requestId }) => {
      const id = Option.some(String(requestId));

      return admitted(command, id).pipe(
        Effect.tap((checked) => Effect.flatMap(runsEndedBy(checked), stopRuns)),
        Effect.flatMap((checked) =>
          Effect.tap(sink.commitCommand(checked), () =>
            Predicate.isTagged(checked, "ThreadClear")
              ? releaseFolders(checked.threadId)
              : Effect.void
          )
        ),
        Effect.catchTags({
          ShellStoreError: (failure) =>
            Effect.fail(unavailable(String(requestId))(failure)),
          ShellTargetNotFound: (failure) =>
            Effect.fail(
              new NotFound({
                message: failure.message,
                resource: failure.resource,
                id: failure.id,
                requestId: id,
              })
            ),
          ProjectWorkspaceConflictError: (failure) =>
            Effect.fail(
              new Conflict({
                message: failure.message,
                reason: "workspace_in_use",
                requestId: id,
              })
            ),
          ShellCommandInvalid: (failure) =>
            Effect.fail(
              new InvalidInput({
                message: failure.message,
                field: failure.field,
                requestId: id,
              })
            ),
          ShellCommandConflict: (failure) =>
            Effect.fail(
              new Conflict({
                message: failure.message,
                reason: failure.reason,
                requestId: id,
              })
            ),
        })
      );
    };
  })
);

/**
 * A project's earlier project threads, a page at a time (ADR 0048): its archived top-level rows,
 * newest archive first. A project that is gone or deleted is `NotFound`.
 */
export const ShellPreviousThreadsHandler = CairnRpcs.toLayerHandler(
  "shell.previousThreads",
  Effect.gen(function* () {
    const rows = yield* ThreadRows;
    const projects = yield* Projects;

    return (input, { requestId }) =>
      Effect.gen(function* () {
        const project = yield* projects.get(input.projectId);

        if (Option.isNone(project) || Option.isSome(project.value.deletedAt)) {
          return yield* new NotFound({
            message: `Project ${input.projectId} does not exist. Pick another project.`,
            resource: "project",
            id: input.projectId,
            requestId: Option.some(String(requestId)),
          });
        }

        // One row past the page says whether another page follows.
        const found = yield* rows.listPrevious(
          input.projectId,
          input.after,
          input.limit + 1
        );

        const threads = found.slice(0, input.limit).map((row) => row.shell);
        const last = threads.at(-1);

        return {
          threads,
          next:
            found.length > input.limit && last !== undefined
              ? Option.flatMap(last.archivedAt, (archivedAt) =>
                  Option.some({ archivedAt, threadId: last.id })
                )
              : Option.none(),
        };
      }).pipe(
        Effect.catchTag("ShellStoreError", (failure) =>
          Effect.fail(unavailable(String(requestId))(failure))
        )
      );
  })
);

/**
 * One earlier project thread by its id (ADR 0048), for a page opened on it directly: an archived
 * top-level row, not deleted, of a folder project that is not deleted. Any other thread, live ones
 * included, is `NotFound`, so a client asking about a thread it has not seen yet learns nothing
 * wrong.
 */
export const ShellEarlierThreadHandler = CairnRpcs.toLayerHandler(
  "shell.earlierThread",
  Effect.gen(function* () {
    const rows = yield* ThreadRows;
    const projects = yield* Projects;

    return (input, { requestId }) =>
      Effect.gen(function* () {
        const row = yield* rows.get(input.threadId);

        const project = yield* Option.match(row, {
          onNone: () => Effect.succeedNone,
          onSome: (found) => projects.get(found.shell.projectId),
        });

        const isEarlier =
          Option.exists(
            row,
            (found) =>
              Option.isNone(found.deletedAt) &&
              Option.isSome(found.shell.archivedAt) &&
              Option.isNone(found.shell.lineage)
          ) &&
          Option.exists(
            project,
            (found) =>
              Option.isNone(found.deletedAt) && found.shell.kind === "folder"
          );

        if (!isEarlier || Option.isNone(row)) {
          return yield* new NotFound({
            message: `Thread ${input.threadId} is not an earlier project thread.`,
            resource: "thread",
            id: input.threadId,
            requestId: Option.some(String(requestId)),
          });
        }

        return row.value.shell;
      }).pipe(
        Effect.catchTag("ShellStoreError", (failure) =>
          Effect.fail(unavailable(String(requestId))(failure))
        )
      );
  })
);

/**
 * The shell handlers. Needs `ShellStream`, `EventSink`, `CommandReceipts`, `FolderRules`,
 * `ThreadRows`, `Projects`, `ScratchProject` and `Threads`.
 */
export const ShellHandlers = Layer.mergeAll(
  ShellSubscribeHandler,
  ShellDispatchHandler,
  ShellPreviousThreadsHandler,
  ShellEarlierThreadHandler
);
