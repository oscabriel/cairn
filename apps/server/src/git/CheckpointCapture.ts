// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/CheckpointCaptureService.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: capture is at least once and idempotent (a run
// that already has its checkpoint returns it), a baseline before the first run, a checkpoint at
// each run's end, and a transcript item that places the changed-files card. Changed: captures key
// on the harness seam's `RunStarted` and `RunTerminal` (every terminal status, as a stopped turn
// can still have written files), the turn number is the next free one among the thread's refs and
// the run id is recorded in the checkpoint commit (no projection table), the transcript item is a
// `cairn.checkpoint` display entry written idempotently by request id, one capture runs per thread
// at a time, and a boot repair sweeps scratch indexes a kill left behind and captures a run whose
// end the brain missed. Removed: scopes and ordinals, provider durations, rollback.
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

import type { ThreadId } from "@cairn/protocol/Ids";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { Projects } from "../projects/Projects.ts";
import { isLiveThread, ThreadRows } from "../shell/ThreadRows.ts";
import { checkpointRef, checkpointRefsOf, Checkpoints } from "./Checkpoints.ts";
import type { CheckpointCommit, CheckpointPoint } from "./Checkpoints.ts";
import { Diffs, workspaceOf } from "./Diffs.ts";

/** The most files a checkpoint entry lists; the rest are counted in `moreFiles`. */
export const MAX_ENTRY_FILES = 500;

/** The entry kind the changed-files card reads. */
export const CHECKPOINT_ENTRY_KIND = "cairn.checkpoint";

/**
 * The data of a `cairn.checkpoint` entry, as JSON in the transcript. `turn` and `ref` are what the
 * timeline already reads; the rest feeds the changed-files card without a round trip.
 */
export const CheckpointEntryData = Schema.Struct({
  turn: Schema.Int,
  ref: Schema.String,
  /** HEAD when the checkpoint was captured; null on a branch with no commit yet. */
  headOid: Schema.NullOr(Schema.String),
  /** Epoch milliseconds. */
  capturedAt: Schema.Int,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      additions: Schema.Int,
      deletions: Schema.Int,
    })
  ),
  /** Files changed beyond the `MAX_ENTRY_FILES` listed. */
  moreFiles: Schema.Int,
  /**
   * The newest user entry the run answered, so the card lands in that turn even when the next
   * turn started before the capture finished. Absent when the brain did not see it (boot repair,
   * entries written before it was recorded): the card then goes to the newest turn.
   */
  userEntryId: Schema.optionalKey(Schema.Int),
});

export type CheckpointEntryData = typeof CheckpointEntryData.Type;

/** A checkpoint entry could not be written to the transcript. */
export class CheckpointEntryError extends Schema.TaggedError<CheckpointEntryError>()(
  "CheckpointEntryError",
  {
    message: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/**
 * Writes `cairn.checkpoint` display entries into a thread's transcript through the harness (a
 * passive `submit({type: "write"})`, idempotent by `requestId`), so they never start a run.
 */
export class CheckpointEntries extends Context.Service<
  CheckpointEntries,
  {
    write(
      threadId: ThreadId,
      requestId: string,
      data: CheckpointEntryData
    ): Effect.Effect<void, CheckpointEntryError>;
  }
>()("cairn/server/git/CheckpointEntries") {
  /** Writes nothing: the card stays hidden, the refs and diffs still work. */
  static readonly layerNone = Layer.succeed(
    CheckpointEntries,
    CheckpointEntries.of({ write: () => Effect.void })
  );
}

/** The request id of turn `turn`'s entry, so a repeated capture writes it once. */
export const checkpointRequestId = (threadId: ThreadId, turn: number) =>
  `cairn-checkpoint:${threadId}:${String(turn)}`;

/** Where a run's end checkpoint goes: its existing one, or the next free turn. */
export interface EndTurnPlan {
  readonly turn: number;
  readonly existing: Option.Option<CheckpointCommit>;
}

/** The turn a run's end checkpoint takes: its own if it has one, else the next free turn. */
export const planEndTurn = (
  captured: ReadonlyArray<CheckpointCommit>,
  runId: string
): EndTurnPlan => {
  const existing = Option.fromNullishOr(
    captured.find(
      (found) =>
        Option.contains(found.runId, runId) &&
        Option.contains(found.point, "end")
    )
  );

  return {
    turn: Option.match(existing, {
      onNone: () => Math.max(0, ...captured.map((found) => found.turn)) + 1,
      onSome: (found) => found.turn,
    }),
    existing,
  };
};

/**
 * Whether boot should capture a run end the brain missed: the thread already has checkpoints and
 * its last run completed after its newest end checkpoint (commit times are whole seconds). A
 * thread with none predates checkpoints, so boot leaves it alone: its first run takes turn 0.
 */
export const missedRunEnd = (
  captured: ReadonlyArray<CheckpointCommit>,
  completedAtMillis: number
) => {
  if (captured.length === 0) {
    return false;
  }

  const newest = Math.max(
    Number.NEGATIVE_INFINITY,
    ...captured.flatMap((found) =>
      Option.contains(found.point, "end") ? [found.capturedAtSeconds] : []
    )
  );

  return newest < Math.floor(completedAtMillis / 1000);
};

/** Logs a failed capture and answers none: a checkpoint must never fail the run it follows. */
const logged = (operation: string, threadId: ThreadId) =>
  Effect.catchCause((cause) =>
    Effect.logWarning("checkpoint capture failed").pipe(
      Effect.annotateLogs({
        event: "checkpoint_capture_failed",
        operation,
        threadId,
        cause: String(cause),
      }),
      Effect.as(Option.none<CheckpointCommit>())
    )
  );

/** Captures checkpoints at the start and end of every run of a thread in a git folder. */
export class CheckpointCapture extends Context.Service<
  CheckpointCapture,
  {
    /** Captures turn 0 before the thread's first run; nothing when the thread already has one. */
    runStarted(
      threadId: ThreadId,
      runId: string
    ): Effect.Effect<Option.Option<CheckpointCommit>>;
    /**
     * Captures the run's end as the next turn (or returns its existing one) and writes its entry,
     * placed after `userEntryId` (the newest user entry the run answered) when known.
     */
    runEnded(
      threadId: ThreadId,
      runId: string,
      userEntryId: Option.Option<number>
    ): Effect.Effect<Option.Option<CheckpointCommit>>;
    /**
     * The boot repair: sweeps scratch indexes a kill left in each live thread's repository, then
     * captures the end of a thread's last run when no checkpoint covers it.
     */
    readonly repair: Effect.Effect<void>;
  }
>()("cairn/server/git/CheckpointCapture") {
  /** The service alone. Needs `Checkpoints`, `Diffs`, `CheckpointEntries`, `ThreadRows`, `Projects`. */
  static readonly layerNoDeps = Layer.effect(
    CheckpointCapture,
    Effect.gen(function* () {
      const checkpoints = yield* Checkpoints;
      const diffs = yield* Diffs;
      const entries = yield* CheckpointEntries;
      const rows = yield* ThreadRows;
      const projects = yield* Projects;

      const locks = new Map<string, Semaphore.Semaphore>();

      const lockOf = (threadId: ThreadId) => {
        const found = locks.get(threadId);

        if (found !== undefined) {
          return found;
        }

        const made = Semaphore.makeUnsafe(1);
        locks.set(threadId, made);

        return made;
      };

      const folderOf = Effect.fnUntraced(function* (threadId: ThreadId) {
        const workspace = yield* workspaceOf(rows, projects, threadId);

        if (workspace.kind !== "folder") {
          return Option.none<string>();
        }

        return (yield* checkpoints.isRepository(workspace.cwd))
          ? Option.some(workspace.cwd)
          : Option.none<string>();
      });

      const captureAt = Effect.fnUntraced(function* (
        cwd: string,
        threadId: ThreadId,
        turn: number,
        runId: string,
        point: CheckpointPoint
      ) {
        const captured = yield* checkpoints.capture({
          cwd,
          ref: checkpointRef(threadId, turn),
          runId,
          point,
        });

        yield* Effect.logInfo("checkpoint captured").pipe(
          Effect.annotateLogs({
            event: "checkpoint_captured",
            threadId,
            turn,
            point,
          })
        );

        return captured;
      });

      const writeEntry = Effect.fnUntraced(function* (
        cwd: string,
        threadId: ThreadId,
        captured: ReadonlyArray<CheckpointCommit>,
        checkpoint: CheckpointCommit,
        userEntryId: Option.Option<number>
      ) {
        const previous = captured.findLast(
          (found) => found.turn < checkpoint.turn
        );

        const files =
          previous === undefined
            ? []
            : (yield* diffs.summary(cwd, previous.ref, checkpoint.ref)).files;

        yield* entries.write(
          threadId,
          checkpointRequestId(threadId, checkpoint.turn),
          {
            turn: checkpoint.turn,
            ref: checkpoint.ref,
            headOid: Option.getOrNull(checkpoint.headOid),
            capturedAt: checkpoint.capturedAtSeconds * 1000,
            files: files.slice(0, MAX_ENTRY_FILES).map((file) => ({
              path: file.path,
              additions: file.additions,
              deletions: file.deletions,
            })),
            moreFiles: Math.max(0, files.length - MAX_ENTRY_FILES),
            ...Option.match(userEntryId, {
              onNone: () => ({}),
              onSome: (id) => ({ userEntryId: id }),
            }),
          }
        );
      });

      const runStarted = Effect.fn("CheckpointCapture.runStarted")(
        function* (threadId: ThreadId, runId: string) {
          const cwd = yield* folderOf(threadId);

          if (Option.isNone(cwd)) {
            return Option.none<CheckpointCommit>();
          }

          const captured = yield* checkpoints.list(
            cwd.value,
            checkpointRefsOf(threadId)
          );

          if (captured.length > 0) {
            return Option.none<CheckpointCommit>();
          }

          return Option.some(
            yield* captureAt(cwd.value, threadId, 0, runId, "start")
          );
        },
        (effect, threadId) =>
          lockOf(threadId)
            .withPermits(1)(effect)
            .pipe(logged("runStarted", threadId))
      );

      const endUnlocked = Effect.fnUntraced(function* (
        threadId: ThreadId,
        runId: string,
        userEntryId: Option.Option<number>
      ) {
        const cwd = yield* folderOf(threadId);

        if (Option.isNone(cwd)) {
          return Option.none<CheckpointCommit>();
        }

        const refs = checkpointRefsOf(threadId);
        const before = yield* checkpoints.list(cwd.value, refs);
        const plan = planEndTurn(before, runId);

        const checkpoint = Option.isSome(plan.existing)
          ? plan.existing.value
          : yield* captureAt(cwd.value, threadId, plan.turn, runId, "end");

        const captured = Option.isSome(plan.existing)
          ? before
          : [...before, checkpoint];

        // Written on every pass: the request id makes a repeat a no-op, and a write lost to a kill
        // between the ref and the entry lands on the next pass.
        yield* writeEntry(
          cwd.value,
          threadId,
          captured,
          checkpoint,
          userEntryId
        );

        return Option.some(checkpoint);
      });

      const runEnded = Effect.fn("CheckpointCapture.runEnded")(
        function* (
          threadId: ThreadId,
          runId: string,
          userEntryId: Option.Option<number>
        ) {
          return yield* endUnlocked(threadId, runId, userEntryId);
        },
        (effect, threadId) =>
          lockOf(threadId)
            .withPermits(1)(effect)
            .pipe(logged("runEnded", threadId))
      );

      const repairThread = Effect.fnUntraced(function* (
        threadId: ThreadId,
        completedAt: Option.Option<DateTime.Utc>
      ) {
        const cwd = yield* folderOf(threadId);

        if (Option.isNone(cwd)) {
          return;
        }

        const swept = yield* checkpoints.sweepScratch(cwd.value);

        if (swept > 0) {
          yield* Effect.logInfo("checkpoint scratch index swept").pipe(
            Effect.annotateLogs({
              event: "checkpoint_scratch_swept",
              threadId,
              files: swept,
            })
          );
        }

        if (Option.isNone(completedAt)) {
          return;
        }

        const completedMillis = DateTime.toEpochMillis(completedAt.value);

        const captured = yield* checkpoints.list(
          cwd.value,
          checkpointRefsOf(threadId)
        );

        if (missedRunEnd(captured, completedMillis)) {
          yield* runEnded(
            threadId,
            `repair-${String(completedMillis)}`,
            Option.none()
          );
        }
      });

      const repair = Effect.gen(function* () {
        const live = yield* rows.listLive;

        yield* Effect.forEach(
          live.filter(isLiveThread),
          (row) =>
            Option.isSome(row.shell.activeRunId)
              ? Effect.void
              : repairThread(row.shell.id, row.shell.latestRunCompletedAt).pipe(
                  logged("repair", row.shell.id)
                ),
          { discard: true }
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("checkpoint repair failed").pipe(
            Effect.annotateLogs({
              event: "checkpoint_repair_failed",
              cause: String(cause),
            })
          )
        ),
        Effect.withSpan("CheckpointCapture.repair")
      );

      return CheckpointCapture.of({ runStarted, runEnded, repair });
    })
  );

  /**
   * The service, subscribed to the harness events while the layer builds (before boot resumes the
   * harness), capturing in the background so a slow repository never holds up the event feed.
   * Needs `HarnessSeam`, `CheckpointEntries`, `ThreadRows` and `Projects`.
   */
  static readonly layer = Layer.effect(
    CheckpointCapture,
    Effect.gen(function* () {
      const harness = yield* HarnessSeam;
      const capture = yield* CheckpointCapture;
      const scope = yield* Effect.scope;

      // The newest user entry of each thread, read when its run ends: events arrive in commit
      // order, so the next turn's user entry has not been seen yet even if it lands before the
      // capture finishes.
      const lastUser = new Map<string, number>();

      // `startImmediately` takes the thread's lock before the next event is read, so a run's
      // `runStarted` always holds it before that run's `runEnded`.
      const fork = (effect: Effect.Effect<unknown>) =>
        Effect.forkIn(effect, scope, { startImmediately: true }).pipe(
          Effect.asVoid
        );

      const onEvent = (event: HarnessEvent) =>
        Match.value(event).pipe(
          Match.tag("MessageCommitted", (committed) =>
            Effect.sync(() => {
              if (committed.role === "user") {
                lastUser.set(committed.threadId, committed.entryId);
              }
            })
          ),
          Match.tag("RunStarted", (started) =>
            fork(capture.runStarted(started.threadId, String(started.runId)))
          ),
          Match.tag("RunTerminal", (ended) =>
            fork(
              capture.runEnded(
                ended.threadId,
                String(ended.runId),
                Option.fromNullishOr(lastUser.get(ended.threadId))
              )
            )
          ),
          Match.orElse(() => Effect.void)
        );

      yield* Stream.runForEach(harness.events, onEvent).pipe(
        Effect.forkScoped({ startImmediately: true })
      );
      yield* Effect.yieldNow;

      return capture;
    })
  ).pipe(
    Layer.provide(this.layerNoDeps),
    Layer.provide(Diffs.layer),
    Layer.provide(Checkpoints.layer)
  );
}
