// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ThreadLaunchService.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, rebuilt around the same phases. Kept: `launch`
// answers at once with the thread's row in the sidebar (`preparing`), and a background fiber
// prepares the workspace (the project root, an existing worktree, or a new worktree on a temporary
// `cairn/<8 hex>` branch), records it on the row, then releases the first message; a temporary
// branch is renamed from the message by the cheap model in a forked fiber that never blocks the run
// and updates every thread sharing that worktree and branch; a failure removes the worktree the
// launch made; a resent launch (same command id) lands once. Changed: no terminals, setup scripts,
// clone tracking, submodules or scheduled tasks; the launch's request and the phase it reached
// live in `thread_launches`, so boot resumes a launch a restart cut off, each phase idempotent;
// the first message goes through `TurnContent` and the harness seam; scratch threads get their own
// claimed folder.
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
import { createHash } from "node:crypto";
import path from "node:path";

import { CommandId } from "@cairn/protocol/Ids";
import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type {
  ThreadLaunchInput,
  ThreadLaunchResult,
} from "@cairn/protocol/Launch";
import type { ProjectShell } from "@cairn/protocol/Shell";
import { ThreadRename } from "@cairn/protocol/ShellCommands";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  FiberMap,
  Latch,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { ServerConfig } from "../Config.ts";
import { Projects } from "../projects/Projects.ts";
import { ScratchProject } from "../projects/ScratchProject.ts";
import {
  isTemporaryWorktreeBranch,
  worktreePathFor,
  Worktrees,
} from "../projects/Worktrees.ts";
import { CommandReceipts } from "../shell/CommandReceipts.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
  ThreadCreate,
  ThreadWorkspaceUpdate,
} from "../shell/ShellCommands.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { BranchNames } from "./BranchNames.ts";
import { LaunchStore } from "./LaunchStore.ts";
import type { LaunchRow } from "./LaunchStore.ts";
import { placeholderTitle, ThreadTitles } from "./ThreadTitles.ts";
import { logTurnSubmitted, TurnContent } from "./TurnContent.ts";
import type { TurnContentError } from "./TurnContent.ts";

/** `thread.launch` was refused before anything was committed (or answered as a duplicate). */
export class LaunchError extends Schema.TaggedError<LaunchError>()(
  "LaunchError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "project_not_found",
      "invalid_input",
      /** The thread id already belongs to a thread another command made. */
      "thread_exists",
      /** cairn.sqlite could not be read or written; nothing ran. */
      "unavailable",
    ]),
    field: Schema.OptionFromNullOr(Schema.String),
  }
) {}

/** A launch phase failed; the thread is marked failed with this message. */
class LaunchStepFailed extends Schema.TaggedError<LaunchStepFailed>()(
  "LaunchStepFailed",
  {
    message: Schema.String,
    step: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/**
 * A command id derived from `commandId` for one sub-step of its launch: a UUIDv7 with the same
 * time and the rest from a hash, so a resumed launch sends the same ids and receipts dedupe them.
 */
export const derivedCommandId = (commandId: CommandId, step: string) => {
  const hash = createHash("sha256")
    .update(`${commandId}:${step}`)
    .digest("hex");

  const time = commandId.replaceAll("-", "").slice(0, 12);
  const variant = (8 + (Number.parseInt(hash.charAt(3), 16) % 4)).toString(16);

  return CommandId.make(
    [
      time.slice(0, 8),
      time.slice(8, 12),
      `7${hash.slice(0, 3)}`,
      `${variant}${hash.slice(4, 7)}`,
      hash.slice(7, 19),
    ].join("-")
  );
};

const stepFailed = (step: string) => (cause: { readonly message: string }) =>
  new LaunchStepFailed({ message: cause.message, step, cause });

const unavailable = (cause: { readonly message: string }) =>
  new LaunchError({
    message: `The launch could not reach cairn.sqlite: ${cause.message}`,
    reason: "unavailable",
    field: Option.none(),
  });

const awaitKey = <K>(map: FiberMap.FiberMap<K>, key: K) =>
  FiberMap.get(map, key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (fiber) => Effect.ignore(Fiber.await(fiber)),
      })
    )
  );

/** Creates threads: the row at once, then the workspace and the first message in the background. */
export class ThreadLaunch extends Context.Service<
  ThreadLaunch,
  {
    /**
     * Creates the thread's row (`preparing`) and starts preparing it, answering at once. Idempotent
     * by `commandId`: a resent launch answers `resumed: true` and starts nothing new. `from` is the
     * viewer's login, recorded on the first message. Fails with `LaunchError` before any commit,
     * or with the first message's `TurnContentError`.
     */
    launch(
      input: ThreadLaunchInput,
      from: string
    ): Effect.Effect<ThreadLaunchResult, LaunchError | TurnContentError>;
    /** Resumes every launch a restart interrupted (a boot repair). */
    readonly resumePending: Effect.Effect<void>;
    /** Waits until the thread's launch fiber (if any) and its forked naming work are done. */
    settled(threadId: ThreadId): Effect.Effect<void>;
    /**
     * Waits while a launch of `threadId` runs in this process: a `launch` call between its launch
     * row and its fiber's start, then the fiber until the first message reached the brain or the
     * launch failed. True when there was one to wait for; false at once when none runs here, as
     * after a restart before `resumePending` started it.
     */
    follow(threadId: ThreadId): Effect.Effect<boolean>;
  }
>()("cairn/server/threads/ThreadLaunch") {
  /** Needs the shell store, `LaunchStore`, the projects services, `HarnessSeam` and `TurnContent`. */
  static readonly layerNoDeps = Layer.effect(
    ThreadLaunch,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const sink = yield* EventSink;
      const receipts = yield* CommandReceipts;
      const projects = yield* Projects;
      const threadRows = yield* ThreadRows;
      const launches = yield* LaunchStore;
      const scratch = yield* ScratchProject;
      const worktrees = yield* Worktrees;
      const seam = yield* HarnessSeam;
      const turns = yield* TurnContent;
      const titles = yield* ThreadTitles;
      const branchNames = yield* BranchNames;

      const worktreesDir = path.join(config.dataDir, "worktrees");
      const running = yield* FiberMap.make<ThreadId>();
      const naming = yield* FiberMap.make<string>();

      // The `launch` calls between their launch-row insert and their fiber's start, by thread. A
      // launch row with neither one of these nor a fiber is an orphan a restart left.
      const admissions = new Map<ThreadId, Latch.Latch>();

      const admitting = <A, E, R>(
        threadId: ThreadId,
        effect: Effect.Effect<A, E, R>
      ) =>
        Effect.gen(function* () {
          if (admissions.has(threadId)) {
            return yield* effect;
          }

          const done = yield* Latch.make(false);

          admissions.set(threadId, done);

          return yield* effect.pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                admissions.delete(threadId);

                return done.open;
              })
            )
          );
        });

      const awaitAdmission = (threadId: ThreadId) =>
        Effect.suspend(() => {
          const admission = admissions.get(threadId);

          return admission === undefined
            ? Effect.succeed(false)
            : Effect.as(admission.await, true);
        });

      const commit = (
        step: string,
        command: Parameters<typeof sink.commitCommand>[0]
      ) => sink.commitCommand(command).pipe(Effect.mapError(stepFailed(step)));

      const markFailed = Effect.fnUntraced(function* (
        row: LaunchRow,
        message: string
      ) {
        yield* sink
          .commitCommand(
            ThreadActivityUpdate.make({
              commandId: derivedCommandId(row.input.commandId, "failed"),
              threadId: row.input.threadId,
              patch: {
                ...emptyActivityPatch,
                activity: Option.some("failed"),
                lastError: Option.some(Option.some(message.slice(0, 4000))),
                lastErrorClass: Option.some(Option.some("unknown")),
              },
            })
          )
          .pipe(Effect.ignore);
      });

      // Removes what the launch made. The branch is read from the worktree, because a rename may
      // have run.
      const cleanUp = Effect.fnUntraced(function* (
        row: LaunchRow,
        project: ProjectShell
      ) {
        if (!row.worktreeCreated || Option.isNone(row.worktreePath)) {
          return;
        }

        const worktreePath = row.worktreePath.value;

        const branch = row.branchCreated
          ? Option.orElse(
              yield* worktrees.currentBranch(worktreePath),
              () => row.branch
            )
          : Option.none<string>();

        yield* worktrees
          .remove(project.workspaceRoot, worktreePath, branch)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("launch cleanup failed").pipe(
                Effect.annotateLogs({
                  event: "launch_cleanup_failed",
                  threadId: row.input.threadId,
                  worktreePath,
                  cause: String(cause),
                })
              )
            )
          );
      });

      // Renames the temporary branch from the first message, then moves every thread that shares
      // the worktree and the old branch onto the new name. Failures only log.
      const renameBranch = Effect.fnUntraced(function* (
        projectId: ProjectId,
        threadId: ThreadId,
        worktreePath: string,
        oldBranch: string,
        message: string
      ) {
        const desired = yield* branchNames.generate(message);

        const renamed = yield* worktrees.renameBranch(
          worktreePath,
          oldBranch,
          desired
        );

        const sharing = (yield* threadRows.listByProject(projectId)).filter(
          (row) =>
            Option.isNone(row.deletedAt) &&
            Option.contains(row.shell.worktreePath, worktreePath) &&
            Option.contains(row.shell.branch, oldBranch)
        );

        yield* Effect.forEach(
          sharing,
          (row) =>
            Effect.gen(function* () {
              yield* sink.commitCommand(
                ThreadWorkspaceUpdate.make({
                  commandId: yield* sink.mintCommandId,
                  threadId: row.shell.id,
                  branch: Option.some(renamed),
                  worktreePath: row.shell.worktreePath,
                })
              );
            }),
          { discard: true }
        );

        yield* Effect.logInfo("thread branch renamed").pipe(
          Effect.annotateLogs({
            event: "thread_branch_renamed",
            threadId,
            from: oldBranch,
            to: renamed,
          })
        );
      });

      const nameThread = Effect.fnUntraced(function* (
        row: LaunchRow,
        placeholder: string
      ) {
        const title = yield* titles.generate(row.input.initialMessage.text);

        if (Option.isNone(title)) {
          return;
        }

        const current = yield* threadRows.get(row.input.threadId);

        // A user rename wins: only the placeholder this launch set is replaced.
        if (
          Option.isNone(current) ||
          current.value.shell.title !== placeholder
        ) {
          return;
        }

        yield* sink.commitCommand(
          ThreadRename.make({
            commandId: derivedCommandId(row.input.commandId, "title"),
            threadId: row.input.threadId,
            title: title.value,
          })
        );
      });

      const forkNaming = <E>(key: string, work: Effect.Effect<void, E>) =>
        FiberMap.run(
          naming,
          key,
          work.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("thread naming failed").pipe(
                    Effect.annotateLogs({
                      event: "thread_naming_failed",
                      key,
                      cause: String(cause),
                    })
                  )
            )
          ),
          { onlyIfMissing: true }
        );

      // The workspace phase: decides the thread's cwd and makes a worktree when asked to. The plan
      // (branch, path, and whether this launch makes them) is written before the worktree is
      // made, so a resumed launch finishes the same worktree instead of making a second one.
      const prepareWorkspace = Effect.fnUntraced(function* (
        row: LaunchRow,
        project: ProjectShell
      ) {
        const { input } = row;
        const strategy = input.workspace;

        if (project.kind === "scratch") {
          const cwd = Option.isSome(row.cwd)
            ? row.cwd.value
            : yield* scratch
                .folderForThread(input.threadId, input.initialMessage.text)
                .pipe(Effect.mapError(stepFailed("workspace")));

          return { ...row, phase: "workspace" as const, cwd: Option.some(cwd) };
        }

        const root = project.workspaceRoot;

        return yield* Match.valueTags(strategy, {
          Root: (rootStrategy) =>
            Effect.gen(function* () {
              const branch = Option.isSome(rootStrategy.branch)
                ? rootStrategy.branch
                : yield* worktrees.currentBranch(root);

              return {
                ...row,
                phase: "workspace" as const,
                cwd: Option.some(root),
                branch,
              };
            }),
          ExistingWorktree: (existing) =>
            Effect.gen(function* () {
              const worktreePath = path.resolve(existing.worktreePath);

              if (!(yield* worktrees.isWorktreeOf(root, worktreePath))) {
                return yield* new LaunchStepFailed({
                  message: `${worktreePath} is not a worktree of ${project.title} (${root}). Pick one of its worktrees.`,
                  step: "workspace",
                });
              }

              const branch = Option.isSome(existing.branch)
                ? existing.branch
                : yield* worktrees.currentBranch(worktreePath);

              return {
                ...row,
                phase: "workspace" as const,
                cwd: Option.some(worktreePath),
                branch,
                worktreePath: Option.some(worktreePath),
              };
            }),
          Worktree: (fresh) =>
            Effect.gen(function* () {
              let planned = row;

              if (Option.isNone(row.branch)) {
                const branch = Option.isSome(fresh.branch)
                  ? fresh.branch.value
                  : yield* worktrees.temporaryBranchName(root);

                const worktreePath = worktreePathFor(
                  worktreesDir,
                  path.basename(path.resolve(root)),
                  branch
                );

                const existing = (yield* worktrees.list(root)).some(
                  (entry) => path.resolve(entry.path) === worktreePath
                );

                planned = {
                  ...row,
                  branch: Option.some(branch),
                  worktreePath: Option.some(worktreePath),
                  worktreeCreated: !existing,
                  branchCreated: !(yield* worktrees.branchExists(root, branch)),
                };

                yield* launches.update(planned);
              }

              const made = yield* worktrees.create({
                repoRoot: root,
                worktreesDir,
                baseRef: fresh.baseRef,
                startFromOrigin: fresh.startFromOrigin,
                branch: Option.getOrElse(planned.branch, () => ""),
              });

              return {
                ...planned,
                phase: "workspace" as const,
                cwd: Option.some(made.worktreePath),
              };
            }),
        }).pipe(
          Effect.catchTags({
            WorktreeError: (failure) =>
              Effect.fail(stepFailed("workspace")(failure)),
          })
        );
      });

      // A launch row whose thread row was never committed: the brain stopped between the two
      // inserts. Nothing reached the harness, so the launch is dropped with whatever it made.
      const discardOrphan = Effect.fnUntraced(function* (row: LaunchRow) {
        const { input } = row;
        const project = yield* projects.get(input.projectId);

        if (Option.isSome(project)) {
          yield* cleanUp(row, project.value.shell);

          if (
            project.value.shell.kind === "scratch" &&
            Option.isSome(row.cwd)
          ) {
            yield* scratch.releaseFolder(row.cwd.value).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("launch cleanup failed").pipe(
                  Effect.annotateLogs({
                    event: "launch_cleanup_failed",
                    threadId: input.threadId,
                    cause: String(cause),
                  })
                )
              )
            );
          }
        }

        yield* launches.remove(input.commandId);
        yield* Effect.logWarning("orphan launch discarded").pipe(
          Effect.annotateLogs({
            event: "launch_orphan_discarded",
            threadId: input.threadId,
          })
        );
      });

      const prepare = Effect.fnUntraced(function* (commandId: CommandId) {
        const found = yield* launches.get(commandId);

        if (Option.isNone(found)) {
          return;
        }

        let row = found.value;
        const { input } = row;

        if (Option.isNone(yield* threadRows.get(input.threadId))) {
          yield* discardOrphan(row);

          return;
        }

        const project = yield* projects.get(input.projectId);

        if (Option.isNone(project) || Option.isSome(project.value.deletedAt)) {
          yield* markFailed(
            row,
            `The project ${input.projectId} was removed before the thread started.`
          );
          yield* launches.remove(commandId);

          return;
        }

        const projectShell = project.value.shell;
        const { text } = input.initialMessage;

        const attempt = Effect.gen(function* () {
          if (row.phase === "created") {
            row = yield* prepareWorkspace(row, projectShell);
            yield* launches.update(row);

            if (Option.isSome(row.branch) || Option.isSome(row.worktreePath)) {
              yield* commit(
                "workspace",
                ThreadWorkspaceUpdate.make({
                  commandId: derivedCommandId(commandId, "workspace"),
                  threadId: input.threadId,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                })
              );
            }

            const renameable =
              Predicate.isTagged(input.workspace, "Worktree") &&
              Option.isNone(input.workspace.branch) &&
              text.trim() !== "";

            if (
              renameable &&
              Option.isSome(row.branch) &&
              Option.isSome(row.worktreePath) &&
              isTemporaryWorktreeBranch(row.branch.value)
            ) {
              yield* forkNaming(
                `branch:${input.threadId}`,
                renameBranch(
                  input.projectId,
                  input.threadId,
                  row.worktreePath.value,
                  row.branch.value,
                  text
                )
              );
            }
          }

          if (row.phase === "workspace") {
            const cwd = Option.getOrElse(
              row.cwd,
              () => projectShell.workspaceRoot
            );

            yield* seam
              .ensureThread({
                threadId: input.threadId,
                projectId: input.projectId,
                model: input.model,
                thinkingLevel: input.thinkingLevel,
                cwd,
                instructions: Option.none(),
              })
              .pipe(Effect.mapError(stepFailed("ensure")));

            row = { ...row, phase: "ensured" };
            yield* launches.update(row);
          }

          // Released before the submit, so the run's own activity (from the shell projector)
          // always lands after this one.
          yield* commit(
            "release",
            ThreadActivityUpdate.make({
              commandId: derivedCommandId(commandId, "release"),
              threadId: input.threadId,
              patch: { ...emptyActivityPatch, activity: Option.some("idle") },
            })
          );

          const built = yield* turns
            .build(input.threadId, row.from, input.initialMessage)
            .pipe(Effect.mapError(stepFailed("message")));

          const submission = yield* seam
            .submit(input.threadId, {
              requestId: input.initialMessage.requestId,
              content: built.content,
              entry: built.entry,
              whenBusy: "followUp",
            })
            .pipe(Effect.mapError(stepFailed("message")));

          yield* logTurnSubmitted(
            input.threadId,
            input.initialMessage,
            built,
            submission
          );
          yield* launches.remove(commandId);
          yield* Effect.logInfo("thread launched").pipe(
            Effect.annotateLogs({
              event: "thread_launched",
              threadId: input.threadId,
            })
          );
        });

        yield* attempt.pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }

            const message = Option.match(Cause.findErrorOption(cause), {
              onNone: () => "The launch failed inside the brain.",
              onSome: (error) => error.message,
            });

            return Effect.gen(function* () {
              yield* Effect.logWarning("thread launch failed").pipe(
                Effect.annotateLogs({
                  event: "thread_launch_failed",
                  threadId: input.threadId,
                  cause: String(cause),
                })
              );
              // A rename still running would race the removal of its branch.
              yield* FiberMap.remove(naming, `branch:${input.threadId}`);
              yield* cleanUp(row, projectShell);
              yield* markFailed(row, message);
              yield* launches.remove(commandId);
            });
          })
        );
      });

      const start = (commandId: CommandId, threadId: ThreadId) =>
        FiberMap.run(
          running,
          threadId,
          prepare(commandId).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("thread launch fiber failed").pipe(
                    Effect.annotateLogs({
                      event: "thread_launch_fiber_failed",
                      threadId,
                      cause: String(cause),
                    })
                  )
            ),
            Effect.withSpan("ThreadLaunch.prepare", {
              attributes: { threadId },
            })
          ),
          { onlyIfMissing: true }
        );

      const launch = Effect.fn("ThreadLaunch.launch")(function* (
        input: ThreadLaunchInput,
        from: string
      ) {
        const pending = yield* launches
          .get(input.commandId)
          .pipe(Effect.mapError(unavailable));

        if (Option.isSome(pending)) {
          // A first launch still between its two inserts finishes them (or removes the row when
          // its thread is refused) and starts the fiber itself.
          yield* awaitAdmission(input.threadId);

          const thread = yield* threadRows
            .get(input.threadId)
            .pipe(Effect.mapError(unavailable));

          // With no thread row, a restart cut the launch off between its inserts; starting here
          // would find no thread and drop the launch, and boot discards the row.
          if (Option.isSome(thread)) {
            yield* start(input.commandId, input.threadId);
          }

          return { threadId: input.threadId, resumed: true };
        }

        const receipt = yield* receipts
          .find(input.commandId)
          .pipe(Effect.mapError(unavailable));

        if (Option.isSome(receipt)) {
          if (receipt.value.aggregateId !== input.threadId) {
            return yield* new LaunchError({
              message: `Command ${input.commandId} already launched another thread. Mint a new command id.`,
              reason: "invalid_input",
              field: Option.some("commandId"),
            });
          }

          return { threadId: input.threadId, resumed: true };
        }

        const existing = yield* threadRows
          .get(input.threadId)
          .pipe(Effect.mapError(unavailable));

        if (Option.isSome(existing)) {
          return yield* new LaunchError({
            message: `Thread ${input.threadId} already exists. Open it, or launch with a new thread id.`,
            reason: "thread_exists",
            field: Option.some("threadId"),
          });
        }

        const project = yield* projects
          .get(input.projectId)
          .pipe(Effect.mapError(unavailable));

        if (Option.isNone(project) || Option.isSome(project.value.deletedAt)) {
          return yield* new LaunchError({
            message: `Project ${input.projectId} does not exist. Pick another project.`,
            reason: "project_not_found",
            field: Option.some("projectId"),
          });
        }

        if (
          project.value.shell.kind === "scratch" &&
          !Predicate.isTagged(input.workspace, "Root")
        ) {
          return yield* new LaunchError({
            message:
              "A thread without a project runs in its own folder, not a worktree. Launch it in the project root.",
            reason: "invalid_input",
            field: Option.some("workspace"),
          });
        }

        if (
          Predicate.isTagged(input.workspace, "Worktree") &&
          !(yield* worktrees.isRepository(project.value.shell.workspaceRoot))
        ) {
          return yield* new LaunchError({
            message: `${project.value.shell.workspaceRoot} is not a git repository, so it cannot have worktrees. Launch in the project root.`,
            reason: "invalid_input",
            field: Option.some("workspace"),
          });
        }

        // The first message is checked now, so a turn it cannot send never makes a thread; it is
        // built once, in the launch fiber, after the thread exists.
        yield* turns.check(input.threadId, from, input.initialMessage);

        // From the launch row to the fiber's start, one step as far as interruption goes: a
        // launch cut off in between would leave a row whose thread never exists, and a resend of
        // it would answer `resumed` without making the thread.
        const inserted = yield* admitting(
          input.threadId,
          Effect.gen(function* () {
            const recorded = yield* launches
              .insert(input, from)
              .pipe(Effect.mapError(unavailable));

            const title = Option.getOrElse(input.title, () =>
              placeholderTitle(input.initialMessage.text)
            );

            yield* sink
              .commitCommand(
                ThreadCreate.make({
                  commandId: input.commandId,
                  threadId: input.threadId,
                  projectId: input.projectId,
                  title,
                  provider: input.model.provider,
                  modelId: input.model.modelId,
                  thinkingLevel: input.thinkingLevel,
                  runtimeMode: input.runtimeMode,
                  branch: Option.none(),
                  worktreePath: Option.none(),
                })
              )
              .pipe(
                Effect.catchTags({
                  ShellStoreError: (failure) =>
                    Effect.fail(unavailable(failure)),
                  ShellTargetNotFound: (failure) =>
                    Effect.fail(
                      new LaunchError({
                        message: failure.message,
                        reason: "project_not_found",
                        field: Option.some("projectId"),
                      })
                    ),
                  ShellCommandConflict: (failure) =>
                    Effect.fail(
                      new LaunchError({
                        message: failure.message,
                        reason: "thread_exists",
                        field: Option.some("threadId"),
                      })
                    ),
                  ShellCommandInvalid: (failure) =>
                    Effect.fail(
                      new LaunchError({
                        message: failure.message,
                        reason: "invalid_input",
                        field: failure.field,
                      })
                    ),
                  ProjectWorkspaceConflictError: (failure) =>
                    Effect.fail(unavailable(failure)),
                }),
                Effect.tapError(() =>
                  recorded
                    ? launches.remove(input.commandId).pipe(Effect.ignore)
                    : Effect.void
                )
              );

            yield* sink
              .commitCommand(
                ThreadActivityUpdate.make({
                  commandId: derivedCommandId(input.commandId, "preparing"),
                  threadId: input.threadId,
                  patch: {
                    ...emptyActivityPatch,
                    activity: Option.some("preparing"),
                  },
                })
              )
              .pipe(Effect.mapError(unavailable));

            if (
              Option.isNone(input.title) &&
              input.initialMessage.text.trim() !== ""
            ) {
              const row = yield* launches
                .get(input.commandId)
                .pipe(Effect.mapError(unavailable));

              if (Option.isSome(row)) {
                yield* forkNaming(
                  `title:${input.threadId}`,
                  nameThread(row.value, title)
                );
              }
            }

            yield* start(input.commandId, input.threadId);

            return recorded;
          })
        ).pipe(Effect.uninterruptible);

        return { threadId: input.threadId, resumed: !inserted };
      });

      const resumePending = Effect.gen(function* () {
        const pending = yield* launches.listPending;

        yield* Effect.forEach(
          pending,
          (row) => start(row.input.commandId, row.input.threadId),
          { discard: true }
        );
        yield* Effect.logInfo("pending launches resumed").pipe(
          Effect.annotateLogs({
            event: "launches_resumed",
            count: pending.length,
          })
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("pending launches not resumed").pipe(
            Effect.annotateLogs({
              event: "launches_resume_failed",
              cause: String(cause),
            })
          )
        ),
        Effect.withSpan("ThreadLaunch.resumePending")
      );

      const settled = Effect.fn("ThreadLaunch.settled")(function* (
        threadId: ThreadId
      ) {
        yield* awaitKey(running, threadId);
        yield* awaitKey(naming, `title:${threadId}`);
        yield* awaitKey(naming, `branch:${threadId}`);
      });

      const follow = Effect.fn("ThreadLaunch.follow")(function* (
        threadId: ThreadId
      ) {
        const admitted = yield* awaitAdmission(threadId);
        const fiber = yield* FiberMap.get(running, threadId);

        if (Option.isSome(fiber)) {
          yield* Fiber.await(fiber.value);
        }

        return admitted || Option.isSome(fiber);
      });

      return ThreadLaunch.of({ launch, resumePending, settled, follow });
    })
  );
}
