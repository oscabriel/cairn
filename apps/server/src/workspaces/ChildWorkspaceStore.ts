// The `child_workspaces` rows of `cairn.sqlite` (migration 0012): one per writing subagent, from
// the intent written before `git worktree add` until the worktree is released. `ChildWorkspaces`
// writes them; the boot repair reads them to find worktrees whose spawn never landed.

import { ThreadId } from "@cairn/protocol/Ids";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** How far a child's worktree got. */
export const ChildWorkspaceState = Schema.Literals([
  /** Branch and path are chosen and recorded; git may not have made them yet. */
  "planned",
  /** git made (or found) the worktree; the child works in it. */
  "ready",
  /** The worktree folder is gone; the branch stays. */
  "released",
]);

/** A child workspace's state. */
export type ChildWorkspaceState = typeof ChildWorkspaceState.Type;

/** One child's worktree as the store keeps it. */
export interface ChildWorkspaceRow {
  readonly child: ThreadId;
  readonly parent: ThreadId;
  /** The checkout `git worktree add` ran in: the top level of the parent's cwd. */
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** The commit the worktree started from. */
  readonly baseSha: string;
  /** What "merged" is judged against at release: a branch name, or `baseSha` itself. */
  readonly baseRef: string;
  readonly state: ChildWorkspaceState;
  /** git made the worktree folder (set only after it said so). */
  readonly worktreeCreated: boolean;
  /** git made the branch (set only after it said so). */
  readonly branchCreated: boolean;
}

/** Reading or writing `child_workspaces` failed. Each call is one statement, so nothing is half-written. */
export class ChildWorkspaceStoreError extends Schema.TaggedError<ChildWorkspaceStoreError>()(
  "ChildWorkspaceStoreError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}

const StoredRow = Schema.Struct({
  child_thread_id: ThreadId,
  parent_thread_id: ThreadId,
  repo_root: Schema.String,
  worktree_path: Schema.String,
  branch: Schema.String,
  base_sha: Schema.String,
  base_ref: Schema.String,
  state: ChildWorkspaceState,
  worktree_created: Schema.Int,
  branch_created: Schema.Int,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

const toRow = (stored: typeof StoredRow.Type): ChildWorkspaceRow => ({
  child: stored.child_thread_id,
  parent: stored.parent_thread_id,
  repoRoot: stored.repo_root,
  worktreePath: stored.worktree_path,
  branch: stored.branch,
  baseSha: stored.base_sha,
  baseRef: stored.base_ref,
  state: stored.state,
  worktreeCreated: stored.worktree_created !== 0,
  branchCreated: stored.branch_created !== 0,
});

const storeFailure =
  (operation: string) =>
  <A, E extends Error, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ChildWorkspaceStoreError({
            message: `${operation} could not use child_workspaces in cairn.sqlite: ${cause.message}. Retry; nothing was half-written.`,
            operation,
            cause,
          })
      )
    );

/** The child workspaces Cairn planned or made. */
export class ChildWorkspaceStore extends Context.Service<
  ChildWorkspaceStore,
  {
    /**
     * Records `row` as the child's plan unless the child already has one, and returns the row the
     * store holds: the new plan, or the earlier one a rerun must follow.
     */
    plan(
      row: ChildWorkspaceRow
    ): Effect.Effect<ChildWorkspaceRow, ChildWorkspaceStoreError>;
    /** The child's row, if it has one. */
    get(
      child: ThreadId
    ): Effect.Effect<
      Option.Option<ChildWorkspaceRow>,
      ChildWorkspaceStoreError
    >;
    /** Every row not yet released, oldest first. */
    readonly listOpen: Effect.Effect<
      ReadonlyArray<ChildWorkspaceRow>,
      ChildWorkspaceStoreError
    >;
    /** The rows of `parent`'s direct children, oldest first, released ones included. */
    children(
      parent: ThreadId
    ): Effect.Effect<
      ReadonlyArray<ChildWorkspaceRow>,
      ChildWorkspaceStoreError
    >;
    /** Writes the row's state and made flags. */
    update(
      row: ChildWorkspaceRow
    ): Effect.Effect<void, ChildWorkspaceStoreError>;
    /** Forgets the child's row (its spawn never landed and nothing of it is left). */
    remove(child: ThreadId): Effect.Effect<void, ChildWorkspaceStoreError>;
  }
>()("cairn/server/workspaces/ChildWorkspaceStore") {
  /** Reads and writes through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    ChildWorkspaceStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const columns = sql`
        child_thread_id, parent_thread_id, repo_root, worktree_path, branch, base_sha, base_ref,
        state, worktree_created, branch_created
      `;

      const get = Effect.fn("ChildWorkspaceStore.get")(function* (
        child: ThreadId
      ) {
        const rows = yield* sql`
          SELECT ${columns} FROM child_workspaces WHERE child_thread_id = ${child}
        `.pipe(Effect.flatMap(decodeRows));

        return Option.map(Option.fromNullishOr(rows[0]), toRow);
      }, storeFailure("ChildWorkspaceStore.get"));

      const plan = Effect.fn("ChildWorkspaceStore.plan")(function* (
        row: ChildWorkspaceRow
      ) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        yield* sql`
            INSERT INTO child_workspaces (
              child_thread_id, parent_thread_id, repo_root, worktree_path, branch, base_sha,
              base_ref, state, worktree_created, branch_created, created_at, updated_at
            ) VALUES (
              ${row.child}, ${row.parent}, ${row.repoRoot}, ${row.worktreePath}, ${row.branch},
              ${row.baseSha}, ${row.baseRef}, ${row.state}, ${row.worktreeCreated ? 1 : 0},
              ${row.branchCreated ? 1 : 0}, ${now}, ${now}
            )
            ON CONFLICT (child_thread_id) DO NOTHING
          `;

        const stored = yield* get(row.child);

        return Option.getOrElse(stored, () => row);
      }, storeFailure("ChildWorkspaceStore.plan"));

      const listOpen = sql`
        SELECT ${columns} FROM child_workspaces
        WHERE state <> 'released'
        ORDER BY created_at, child_thread_id
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows.map(toRow)),
        storeFailure("ChildWorkspaceStore.listOpen"),
        Effect.withSpan("ChildWorkspaceStore.listOpen")
      );

      const children = Effect.fn("ChildWorkspaceStore.children")(function* (
        parent: ThreadId
      ) {
        const rows = yield* sql`
          SELECT ${columns} FROM child_workspaces
          WHERE parent_thread_id = ${parent}
          ORDER BY created_at, child_thread_id
        `.pipe(Effect.flatMap(decodeRows));

        return rows.map(toRow);
      }, storeFailure("ChildWorkspaceStore.children"));

      const update = Effect.fn("ChildWorkspaceStore.update")(function* (
        row: ChildWorkspaceRow
      ) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        yield* sql`
          UPDATE child_workspaces SET
            state = ${row.state},
            worktree_created = ${row.worktreeCreated ? 1 : 0},
            branch_created = ${row.branchCreated ? 1 : 0},
            updated_at = ${now}
          WHERE child_thread_id = ${row.child}
        `;
      }, storeFailure("ChildWorkspaceStore.update"));

      const remove = Effect.fn("ChildWorkspaceStore.remove")(function* (
        child: ThreadId
      ) {
        yield* sql`DELETE FROM child_workspaces WHERE child_thread_id = ${child}`;
      }, storeFailure("ChildWorkspaceStore.remove"));

      return ChildWorkspaceStore.of({
        plan,
        get,
        listOpen,
        children,
        update,
        remove,
      });
    })
  );
}
