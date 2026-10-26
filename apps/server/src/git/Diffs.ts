// Ported from github.com/pingdotgg/t3code, apps/server/src/checkpointing/Diffs.ts
// (`parseTurnDiffFilesFromNumstat`, `isGitImport`) and
// apps/server/src/checkpointing/CheckpointDiffQuery.ts (`getTurnDiff`, `getFullThreadDiff`,
// `batchFilePaths`, the `[truncated]` marker) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept:
// numstat first, files the turn did not author filtered out before the patch is made, path specs
// batched at 24,000 characters, the output cap with its marker cut on a UTF-8 boundary, and a full
// diff as turn 0 to N. Changed: checkpoints are read from the refs (no projection table), the cap
// is a `Context.Reference` (2 MB by default, for a phone over the tailnet, where t3code allows
// 10 MB), a thread in the scratch project has no diffs (D41), and errors are Cairn's.
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
import type {
  FullDiffInput,
  ThreadDiff,
  TurnDiffInput,
} from "@cairn/protocol/Checkpoints";
import type { ThreadId } from "@cairn/protocol/Ids";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { Projects } from "../projects/Projects.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { checkpointRef, checkpointRefsOf, Checkpoints } from "./Checkpoints.ts";

/** One changed file of a diff, from numstat. Binary files count 0 lines. */
export interface DiffFileSummary {
  readonly path: string;
  readonly previousPath: Option.Option<string>;
  readonly additions: number;
  readonly deletions: number;
}

/** Path specs per `git diff` call, leaving room for the rest of its arguments. */
export const MAX_PATHSPEC_CHARS = 24_000;

/** Appended where a diff was cut at the output cap. */
export const DIFF_TRUNCATED_MARKER = "\n\n[truncated]";

/** The most bytes one `diff.turn` or `diff.full` answer carries. */
export class DiffOutputLimit extends Context.Reference<number>(
  "cairn/server/git/Diffs/DiffOutputLimit",
  { defaultValue: () => 2_000_000 }
) {}

/** Reads `git diff --numstat -z`, sorted by path. Renames carry their old path. */
export const parseNumstat = (
  numstat: string
): ReadonlyArray<DiffFileSummary> => {
  const records = numstat.split("\0");
  const files: Array<DiffFileSummary> = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const counts = /^(?<added>\d+|-)\t(?<deleted>\d+|-)\t/u.exec(record);

    if (counts === null) {
      continue;
    }

    let file = record.slice(counts[0].length);
    let previousPath = Option.none<string>();

    if (file === "") {
      // Renames and copies use two more records: the source and the destination.
      previousPath = Option.fromNullishOr(records[index + 1]);
      file = records[index + 2] ?? "";
      index += 2;
    }

    if (file !== "") {
      files.push({
        path: file,
        previousPath,
        additions:
          counts.groups?.added === "-" ? 0 : Number(counts.groups?.added),
        deletions:
          counts.groups?.deleted === "-" ? 0 : Number(counts.groups?.deleted),
      });
    }
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
};

/** True when HEAD's movement, not the turn, explains the file. */
export const isGitImport = (
  file: DiffFileSummary,
  authored: Option.Option<ReadonlySet<string>>
) =>
  Option.isSome(authored) &&
  !authored.value.has(file.path) &&
  !Option.exists(file.previousPath, (previous) => authored.value.has(previous));

/** Splits the files' paths into batches whose path specs stay under `MAX_PATHSPEC_CHARS`. */
export const batchFilePaths = (
  files: ReadonlyArray<DiffFileSummary>
): ReadonlyArray<ReadonlyArray<string>> => {
  const batches: Array<Array<string>> = [];
  let batch: Array<string> = [];
  let length = 0;

  for (const file of files) {
    const paths = [...Option.toArray(file.previousPath), file.path];
    const size = paths.reduce((total, item) => total + item.length + 16, 0);

    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }

    batch.push(...paths);
    length += size;
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
};

/** Cuts `text` to `limit` bytes with the marker, on a UTF-8 boundary; as is when it fits. */
export const capDiff = (text: string, limit: number) => {
  const bytes = Buffer.from(text, "utf-8");

  if (bytes.byteLength <= limit) {
    return text;
  }

  const keep = Math.max(0, limit - Buffer.byteLength(DIFF_TRUNCATED_MARKER));

  // A streaming decode drops an incomplete final character at the cut.
  return (
    new TextDecoder().decode(bytes.subarray(0, keep), { stream: true }) +
    DIFF_TRUNCATED_MARKER
  );
};

/** Where a thread's checkpoints live, if it has any. */
export type ThreadWorkspace =
  | { readonly kind: "missing" }
  | { readonly kind: "scratch" }
  | { readonly kind: "folder"; readonly cwd: string };

/**
 * The thread's working folder: its worktree, else its project's root; none for scratch threads.
 * Takes the two services its callers already hold, so their layers keep the requirement.
 */
export const workspaceOf = Effect.fn("Diffs.workspaceOf")(function* (
  rows: ThreadRows["Service"],
  projects: Projects["Service"],
  threadId: ThreadId
) {
  const thread = yield* rows.get(threadId);

  if (Option.isNone(thread) || Option.isSome(thread.value.deletedAt)) {
    return { kind: "missing" } satisfies ThreadWorkspace;
  }

  const project = yield* projects.get(thread.value.shell.projectId);

  if (Option.isNone(project)) {
    return { kind: "missing" } satisfies ThreadWorkspace;
  }

  if (project.value.shell.kind === "scratch") {
    return { kind: "scratch" } satisfies ThreadWorkspace;
  }

  return {
    kind: "folder",
    cwd: Option.getOrElse(
      thread.value.shell.worktreePath,
      () => project.value.shell.workspaceRoot
    ),
  } satisfies ThreadWorkspace;
});

/** A diff could not be made. */
export class DiffError extends Schema.TaggedError<DiffError>()("DiffError", {
  message: Schema.String,
  operation: Schema.String,
  threadId: Schema.String,
  reason: Schema.Literals([
    /** No thread with this id, or it was deleted. */
    "thread_not_found",
    /** The thread's folder has no checkpoints: the scratch project, or not a git repository. */
    "no_checkpoints",
    /** A turn asked for was never captured. */
    "checkpoint_missing",
    /** The store or git failed. */
    "failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The files a turn changed, from numstat, filtered to the ones it authored. */
export interface TurnSummary {
  readonly files: ReadonlyArray<DiffFileSummary>;
}

const failed =
  (operation: string, threadId: string) =>
  (cause: { readonly message: string }) =>
    new DiffError({
      message: `${operation} failed for thread ${threadId}: ${cause.message}`,
      operation,
      threadId,
      reason: "failed",
      cause,
    });

/** Diffs between a thread's checkpoints. */
export class Diffs extends Context.Service<
  Diffs,
  {
    /** The changes between two captured turns of a thread (`diff.turn`). */
    turn(input: TurnDiffInput): Effect.Effect<ThreadDiff, DiffError>;
    /** Everything the thread changed from its baseline up to a turn (`diff.full`). */
    full(input: FullDiffInput): Effect.Effect<ThreadDiff, DiffError>;
    /** The authored files between two refs in `cwd`, for the changed-files card. */
    summary(
      cwd: string,
      fromRef: string,
      toRef: string
    ): Effect.Effect<TurnSummary, DiffError>;
  }
>()("cairn/server/git/Diffs") {
  /** Needs `Checkpoints`, `ThreadRows` and `Projects`. */
  static readonly layerNoDeps = Layer.effect(
    Diffs,
    Effect.gen(function* () {
      const checkpoints = yield* Checkpoints;
      const rows = yield* ThreadRows;
      const projects = yield* Projects;

      const authoredFiles = Effect.fnUntraced(function* (
        cwd: string,
        fromRef: string,
        toRef: string,
        ignoreWhitespace: boolean
      ) {
        const authored = yield* checkpoints.listAuthoredPaths(
          cwd,
          fromRef,
          toRef
        );

        const files = parseNumstat(
          yield* checkpoints.diff({
            cwd,
            fromRef,
            toRef,
            ignoreWhitespace,
            format: "numstat",
            filePaths: Option.none(),
          })
        );

        const kept = files.filter((file) => !isGitImport(file, authored));

        return { files, kept };
      });

      const summary = Effect.fn("Diffs.summary")(function* (
        cwd: string,
        fromRef: string,
        toRef: string
      ) {
        const { kept } = yield* authoredFiles(cwd, fromRef, toRef, false).pipe(
          Effect.mapError(failed("Diffs.summary", cwd))
        );

        return { files: kept };
      });

      const between = Effect.fnUntraced(function* (
        operation: string,
        threadId: ThreadId,
        fromTurn: number,
        toTurn: number,
        ignoreWhitespace: boolean
      ) {
        const empty = {
          threadId,
          fromTurnCount: fromTurn,
          toTurnCount: toTurn,
          diff: "",
        };

        const workspace = yield* workspaceOf(rows, projects, threadId).pipe(
          Effect.mapError(failed(operation, threadId))
        );

        if (workspace.kind === "missing") {
          return yield* new DiffError({
            message: `${operation}: thread ${threadId} does not exist. Open another thread.`,
            operation,
            threadId,
            reason: "thread_not_found",
          });
        }

        if (workspace.kind === "scratch") {
          return yield* new DiffError({
            message: `${operation}: thread ${threadId} is in No project, whose folders are not git repositories, so it has no diffs.`,
            operation,
            threadId,
            reason: "no_checkpoints",
          });
        }

        if (fromTurn === toTurn) {
          return empty;
        }

        const { cwd } = workspace;

        if (!(yield* checkpoints.isRepository(cwd))) {
          return yield* new DiffError({
            message: `${operation}: thread ${threadId} works in ${cwd}, which is not a git repository, so it has no diffs.`,
            operation,
            threadId,
            reason: "no_checkpoints",
          });
        }

        const captured = yield* checkpoints
          .list(cwd, checkpointRefsOf(threadId))
          .pipe(Effect.mapError(failed(operation, threadId)));

        const missing = [fromTurn, toTurn].filter(
          (turn) => !captured.some((found) => found.turn === turn)
        );

        if (missing.length > 0) {
          return yield* new DiffError({
            message: `${operation}: thread ${threadId} has no checkpoint for turn ${missing.join(" or ")}${captured.length === 0 ? " (none were captured)" : `; captured turns run to ${String(captured.at(-1)?.turn ?? 0)}`}. Pick a captured turn.`,
            operation,
            threadId,
            reason: "checkpoint_missing",
          });
        }

        const fromRef = checkpointRef(threadId, fromTurn);
        const toRef = checkpointRef(threadId, toTurn);
        const limit = yield* DiffOutputLimit;

        const diff = yield* Effect.gen(function* () {
          const { files, kept } = yield* authoredFiles(
            cwd,
            fromRef,
            toRef,
            ignoreWhitespace
          );

          if (kept.length === 0) {
            return "";
          }

          // Pick the kept paths before making the patch, so imported bulk cannot fill the cap.
          const batches: ReadonlyArray<Option.Option<ReadonlyArray<string>>> =
            kept.length === files.length
              ? [Option.none()]
              : batchFilePaths(kept).map(Option.some);

          let text = "";

          for (const filePaths of batches) {
            text += yield* checkpoints.diff({
              cwd,
              fromRef,
              toRef,
              ignoreWhitespace,
              format: "patch",
              filePaths,
            });

            if (Buffer.byteLength(text) > limit) {
              break;
            }
          }

          return capDiff(text, limit);
        }).pipe(Effect.mapError(failed(operation, threadId)));

        return { ...empty, diff };
      });

      const turn = Effect.fn("Diffs.turn")(function* (input: TurnDiffInput) {
        return yield* between(
          "diff.turn",
          input.threadId,
          input.fromTurnCount,
          input.toTurnCount,
          input.ignoreWhitespace
        );
      });

      const full = Effect.fn("Diffs.full")(function* (input: FullDiffInput) {
        return yield* between(
          "diff.full",
          input.threadId,
          0,
          input.toTurnCount,
          input.ignoreWhitespace
        );
      });

      return Diffs.of({ turn, full, summary });
    })
  );

  /** With the real `Checkpoints`; `ThreadRows` and `Projects` come from the shell store. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(Checkpoints.layer)
  );
}
