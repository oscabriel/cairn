// `shell.subscribe` and `shell.dispatch`: thin calls into the shell store that translate its
// failures into the protocol's public errors, carrying the RPC request id. A `ProjectCreate` first
// passes `FolderRules` (the deny list, dot folders, links escaping the home) and is committed with
// the folder's real path. Deleting or archiving a thread, or deleting a project, first stops the
// runs it removes (queue cleared, stop hooks run), so a hung thread that is deleted frees its
// Claude Code child instead of holding it for hours.
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
    const folders = yield* FolderRules;
    const threads = yield* Threads;
    const rows = yield* ThreadRows;

    /** The threads whose runs `command` removes from the shell. */
    const runsEndedBy = (
      command: ShellCommand
    ): Effect.Effect<ReadonlyArray<ThreadId>, ShellStoreError> => {
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

    /** Stops each run; a thread the brain never ensured has none, and any other failure is logged. */
    const stopRuns = (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          threads
            .stop({ threadId, clearQueue: true })
            .pipe(
              Effect.catchTag("HarnessError", (failure) =>
                failure.reason === "thread_not_found"
                  ? Effect.void
                  : Effect.logWarning("run not stopped before removal").pipe(
                      Effect.annotateLogs({ threadId, reason: failure.message })
                    )
              )
            ),
        { concurrency: "unbounded", discard: true }
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
        Effect.flatMap((checked) => sink.commitCommand(checked)),
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

/** Both shell handlers. Needs `ShellStream`, `EventSink`, `FolderRules`, `ThreadRows` and `Threads`. */
export const ShellHandlers = Layer.mergeAll(
  ShellSubscribeHandler,
  ShellDispatchHandler
);
