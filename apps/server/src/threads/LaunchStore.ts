// The `thread_launches` rows of `cairn.sqlite`: a launch's request and the phase it reached, from
// its first commit until the thread's first message reaches the brain. ThreadLaunch writes them;
// boot reads them to resume launches a restart interrupted.

import type { CommandId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadLaunchInput } from "@cairn/protocol/Launch";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** How far a launch got. Each phase's work is done and recorded before the next begins. */
export const LaunchPhase = Schema.Literals([
  /** The thread's row exists; the workspace may be planned (branch and path) but is not made. */
  "created",
  /** The workspace exists: `cwd` is final. */
  "workspace",
  /** The brain holds the thread's conversation; only the first message is left. */
  "ensured",
]);

/** A launch phase. */
export type LaunchPhase = typeof LaunchPhase.Type;

/** One launch in flight. */
export interface LaunchRow {
  readonly input: ThreadLaunchInput;
  /** Who launched the thread: the viewer's login, recorded on its first message. */
  readonly from: string;
  readonly phase: LaunchPhase;
  /** Where the thread runs, once the workspace phase chose it. */
  readonly cwd: Option.Option<string>;
  /** The branch the workspace checks out, planned before a worktree is made. */
  readonly branch: Option.Option<string>;
  /** The worktree folder, planned before it is made. */
  readonly worktreePath: Option.Option<string>;
  /** Whether this launch made the worktree (so a failure removes it). */
  readonly worktreeCreated: boolean;
  /** Whether this launch made the branch (so a failure deletes it). */
  readonly branchCreated: boolean;
}

/** Reading or writing `thread_launches` failed. Nothing was half-written: each call is one statement. */
export class LaunchStoreError extends Schema.TaggedError<LaunchStoreError>()(
  "LaunchStoreError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}

const InputJson = Schema.fromJsonString(Schema.toCodecJson(ThreadLaunchInput));

const StoredLaunch = Schema.Struct({
  phase: LaunchPhase,
  input_json: InputJson,
  from_login: Schema.String,
  cwd: Schema.OptionFromNullOr(Schema.String),
  branch: Schema.OptionFromNullOr(Schema.String),
  worktree_path: Schema.OptionFromNullOr(Schema.String),
  worktree_created: Schema.Int,
  branch_created: Schema.Int,
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredLaunch));

const encodeInput = Schema.encodeEffect(InputJson);

const toRow = (stored: typeof StoredLaunch.Type): LaunchRow => ({
  input: stored.input_json,
  from: stored.from_login,
  phase: stored.phase,
  cwd: stored.cwd,
  branch: stored.branch,
  worktreePath: stored.worktree_path,
  worktreeCreated: stored.worktree_created !== 0,
  branchCreated: stored.branch_created !== 0,
});

const orNull = <A>(value: Option.Option<A>) => Option.getOrNull(value);

const storeFailure =
  (operation: string) =>
  <A, E extends Error, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new LaunchStoreError({
            message: `${operation} could not use thread_launches in cairn.sqlite: ${cause.message}. Retry; nothing was half-written.`,
            operation,
            cause,
          })
      )
    );

/** The launches in flight. */
export class LaunchStore extends Context.Service<
  LaunchStore,
  {
    /** Records a new launch in phase `created`; false when its command id was already recorded. */
    insert(
      input: ThreadLaunchInput,
      from: string
    ): Effect.Effect<boolean, LaunchStoreError>;
    /** The launch recorded for `commandId`, if it is still in flight. */
    get(
      commandId: CommandId
    ): Effect.Effect<Option.Option<LaunchRow>, LaunchStoreError>;
    /** The launch in flight for `threadId`, if any. */
    byThread(
      threadId: ThreadId
    ): Effect.Effect<Option.Option<LaunchRow>, LaunchStoreError>;
    /** Every launch in flight, oldest first. */
    readonly listPending: Effect.Effect<
      ReadonlyArray<LaunchRow>,
      LaunchStoreError
    >;
    /** Writes the row's phase and workspace fields. */
    update(row: LaunchRow): Effect.Effect<void, LaunchStoreError>;
    /** Forgets the launch: it finished, or failed for good. */
    remove(commandId: CommandId): Effect.Effect<void, LaunchStoreError>;
  }
>()("cairn/server/threads/LaunchStore") {
  /** Reads and writes through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    LaunchStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const columns = sql`
        phase, input_json, from_login, cwd, branch, worktree_path, worktree_created, branch_created
      `;

      const insert = Effect.fn("LaunchStore.insert")(function* (
        input: ThreadLaunchInput,
        from: string
      ) {
        const inputJson = yield* encodeInput(input);
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        const inserted = yield* sql`
          INSERT INTO thread_launches
            (command_id, thread_id, project_id, phase, input_json, from_login, created_at, updated_at)
          VALUES (
            ${input.commandId}, ${input.threadId}, ${input.projectId}, 'created',
            ${inputJson}, ${from}, ${now}, ${now}
          )
          ON CONFLICT DO NOTHING
          RETURNING command_id
        `;

        return inserted.length > 0;
      }, storeFailure("LaunchStore.insert"));

      const get = Effect.fn("LaunchStore.get")(function* (
        commandId: CommandId
      ) {
        const rows = yield* sql`
          SELECT ${columns} FROM thread_launches WHERE command_id = ${commandId}
        `.pipe(Effect.flatMap(decodeRows));

        return Option.map(Option.fromNullishOr(rows[0]), toRow);
      }, storeFailure("LaunchStore.get"));

      const byThread = Effect.fn("LaunchStore.byThread")(function* (
        threadId: ThreadId
      ) {
        const rows = yield* sql`
          SELECT ${columns} FROM thread_launches WHERE thread_id = ${threadId}
        `.pipe(Effect.flatMap(decodeRows));

        return Option.map(Option.fromNullishOr(rows[0]), toRow);
      }, storeFailure("LaunchStore.byThread"));

      const listPending = sql`
        SELECT ${columns} FROM thread_launches ORDER BY created_at, command_id
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows.map(toRow)),
        storeFailure("LaunchStore.listPending"),
        Effect.withSpan("LaunchStore.listPending")
      );

      const update = Effect.fn("LaunchStore.update")(function* (
        row: LaunchRow
      ) {
        const now = DateTime.toEpochMillis(yield* DateTime.now);

        yield* sql`
          UPDATE thread_launches SET
            phase = ${row.phase},
            cwd = ${orNull(row.cwd)},
            branch = ${orNull(row.branch)},
            worktree_path = ${orNull(row.worktreePath)},
            worktree_created = ${row.worktreeCreated ? 1 : 0},
            branch_created = ${row.branchCreated ? 1 : 0},
            updated_at = ${now}
          WHERE command_id = ${row.input.commandId}
        `;
      }, storeFailure("LaunchStore.update"));

      const remove = Effect.fn("LaunchStore.remove")(function* (
        commandId: CommandId
      ) {
        yield* sql`DELETE FROM thread_launches WHERE command_id = ${commandId}`;
      }, storeFailure("LaunchStore.remove"));

      return LaunchStore.of({
        insert,
        get,
        byThread,
        listPending,
        update,
        remove,
      });
    })
  );
}
