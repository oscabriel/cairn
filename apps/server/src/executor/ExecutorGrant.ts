// Cairn's one Executor grant: where it is kept and who may hold it (plan D39).
//
// - Import. Phase 0's `ops/executor/grant.ts` left the grant in `~/.config/cairn/executor-grant.json`.
//   The first brain that holds the lock and finds no row imports it into `executor_grant` in one
//   transaction, then renames the file `executor-grant.json.imported`; the renamed file is deleted
//   after the first tokens the brain saves itself (a refresh or a sign-in), so a grant that never
//   worked here can still be found by hand.
// - One holder. Executor rotates the refresh token on every refresh and treats a reused one as
//   theft, so only one process may refresh. The holder keeps an exclusive `flock` on
//   `~/.local/state/cairn/executor.lock` for its whole life, through a `flock` child whose stdin is
//   a pipe from the brain: when the brain exits, even by `kill -9`, the pipe closes, the child exits
//   and the lock is free. A brain that finds the lock taken never reads or writes the grant.
// - Storage. What outlives one sign-in (server URL, client, tokens, their expiry) and the two
//   sign-in fields are written to the row; pi-mcp's discovery cache is kept in memory only, as
//   `grant.ts` did.
//
// The sign-in Cairn starts from `executor.signIn` keeps its OAuth `state` here, single use, for
// `SIGN_IN_TTL` (ported from cairn-v1, apps/server/src/Executor.ts at 1a5cd4a, `connect` and
// `callback`; the row shape is v1's `executor_grant`, re-cut to one grant and its import).
import path from "node:path";

import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import {
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";

import { ServerConfig } from "../Config.ts";

/** How long a sign-in's `state` stays good for the callback. */
export const SIGN_IN_TTL = Duration.minutes(10);

/** The exit status `flock -n` uses here when another process holds the lock. */
const LOCK_BUSY = 75;

/** Reading or writing the grant failed. Nothing about the grant changed unless it says so. */
export class ExecutorGrantError extends Schema.TaggedError<ExecutorGrantError>()(
  "ExecutorGrantError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

// What `ops/executor/grant.ts` wrote, plus the sign-in fields. Encoding keeps only these keys, so
// pi-mcp's discovery cache never reaches the disk.
const StoredState = Schema.Struct({
  serverUrl: Schema.String,
  clientInformation: Schema.optionalKey(
    Schema.Struct({
      client_id: Schema.String,
      client_secret: Schema.optionalKey(Schema.String),
      client_id_issued_at: Schema.optionalKey(Schema.Finite),
      client_secret_expires_at: Schema.optionalKey(Schema.Finite),
    })
  ),
  tokens: Schema.optionalKey(
    Schema.Struct({
      access_token: Schema.String,
      token_type: Schema.String,
      expires_in: Schema.optionalKey(Schema.Finite),
      scope: Schema.optionalKey(Schema.String),
      refresh_token: Schema.optionalKey(Schema.String),
      id_token: Schema.optionalKey(Schema.String),
    })
  ),
  tokensExpireAt: Schema.optionalKey(Schema.Finite),
  codeVerifier: Schema.optionalKey(Schema.String),
  oauthState: Schema.optionalKey(Schema.String),
});

const StoredStateJson = Schema.fromJsonString(StoredState);

const decodeStoredState = Schema.decodeEffect(StoredStateJson);

const encodeStoredState = Schema.encodeEffect(StoredStateJson);

const GrantRow = Schema.Struct({
  oauth_state: Schema.String,
  client_redirect_url: Schema.NullOr(Schema.String),
});

const decodeGrantRows = Schema.decodeUnknownEffect(Schema.Array(GrantRow));

const PendingRow = Schema.Struct({ pending_at: Schema.Finite });

const decodePendingRows = Schema.decodeUnknownEffect(Schema.Array(PendingRow));

/** Where the grant file and the holder lock are. */
export interface ExecutorGrantPaths {
  /** Phase 0's grant file, imported once. */
  readonly grantFile: string;
  /** The holder lock. */
  readonly lockFile: string;
}

/** The default paths: the config directory's grant file and the user's state directory's lock. */
export const defaultGrantPaths = (configDir: string): ExecutorGrantPaths => {
  const stateHome =
    process.env.XDG_STATE_HOME !== undefined &&
    process.env.XDG_STATE_HOME !== ""
      ? process.env.XDG_STATE_HOME
      : path.join(process.env.HOME ?? "/", ".local", "state");

  return {
    grantFile: path.join(configDir, "executor-grant.json"),
    lockFile: path.join(stateHome, "cairn", "executor.lock"),
  };
};

const failure =
  (operation: string, what: string) =>
  (cause: unknown): ExecutorGrantError =>
    new ExecutorGrantError({
      message: `Executor grant ${operation} failed: ${what}. The grant was not changed; check cairn.sqlite and the config directory.`,
      operation,
      cause,
    });

/** Holds the grant lock until the scope closes. True when this process holds it. */
const holdLock = (lockFile: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(path.dirname(lockFile), { recursive: true });

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "flock",
        [
          "--nonblock",
          "--conflict-exit-code",
          String(LOCK_BUSY),
          lockFile,
          "--command",
          "echo locked; exec cat",
        ],
        { stdin: "pipe", extendEnv: true }
      )
    );

    const first = yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runHead
    );

    if (Option.isSome(first) && first.value === "locked") {
      return true;
    }

    const code = yield* handle.exitCode;

    if (Number(code) !== LOCK_BUSY) {
      return yield* new ExecutorGrantError({
        message: `Executor grant lock failed: flock exited ${String(code)} on ${lockFile}. Check that util-linux's flock is installed and the state directory is writable.`,
        operation: "lock",
      });
    }

    return false;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(failure("lock", `flock could not run on ${lockFile}`)(cause))
    )
  );

/** The grant: kept in `cairn.sqlite`, held by one process. */
export class ExecutorGrant extends Context.Service<
  ExecutorGrant,
  {
    /** False when another process holds the grant: then nothing here reads or writes it. */
    readonly held: boolean;
    /** The stored grant, if any. */
    readonly load: Effect.Effect<
      Option.Option<McpOAuthState>,
      ExecutorGrantError
    >;
    /** Stores the grant (pi-mcp saves after every refresh and sign-in step). */
    save(state: McpOAuthState): Effect.Effect<void, ExecutorGrantError>;
    /** The redirect URL the stored client was registered with, when known. */
    readonly clientRedirect: Effect.Effect<
      Option.Option<string>,
      ExecutorGrantError
    >;
    /** Records the redirect a new client was registered with. */
    setClientRedirect(url: string): Effect.Effect<void, ExecutorGrantError>;
    /** Records the `state` of a sign-in Cairn started. */
    beginSignIn(oauthState: string): Effect.Effect<void, ExecutorGrantError>;
    /** Takes a sign-in's `state` back, once: true when it was Cairn's and is still fresh. */
    takeSignIn(oauthState: string): Effect.Effect<boolean, ExecutorGrantError>;
    /** Records a finished sign-in. */
    readonly signedIn: Effect.Effect<void, ExecutorGrantError>;
    /** Records that the grant fell into needs-sign-in, for a notifier to tell the user once. */
    needsSignIn(detail: string): Effect.Effect<void, ExecutorGrantError>;
  }
>()("cairn/server/executor/ExecutorGrant") {
  /**
   * The grant in `cairn.sqlite` (`executor_grant`, migration 0004), imported once from `paths`,
   * behind the holder lock. Needs `SqlClient`, `FileSystem` and `ChildProcessSpawner`.
   */
  static readonly layerWith = (paths: ExecutorGrantPaths) =>
    Layer.effect(
      ExecutorGrant,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const clock = yield* Clock.Clock;
        const held = yield* holdLock(paths.lockFile);
        const memory = yield* Ref.make(Option.none<McpOAuthState>());
        const importedFile = `${paths.grantFile}.imported`;

        const now = () => clock.currentTimeMillisUnsafe();

        const readRow = sql`
          SELECT oauth_state, client_redirect_url FROM executor_grant WHERE id = 1
        `.pipe(
          Effect.flatMap(decodeGrantRows),
          Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
          Effect.mapError(failure("read", "the grant row could not be read"))
        );

        if (!held) {
          yield* Effect.logWarning(
            "another process holds the Executor grant; this brain will not use it"
          ).pipe(Effect.annotateLogs({ event: "executor_grant_busy" }));
        }

        // The one-time import, only for the holder.
        if (held) {
          const row = yield* readRow;

          const fileThere = yield* fs
            .exists(paths.grantFile)
            .pipe(Effect.orElseSucceed(() => false));

          if (Option.isNone(row) && fileThere) {
            const text = yield* fs
              .readFileString(paths.grantFile)
              .pipe(
                Effect.mapError(
                  failure("import", `${paths.grantFile} could not be read`)
                )
              );

            const state = yield* decodeStoredState(text).pipe(
              Effect.mapError(
                failure("import", `${paths.grantFile} is not a grant`)
              )
            );

            const encoded = yield* encodeStoredState(state).pipe(
              Effect.mapError(
                failure("import", "the grant could not be encoded")
              )
            );

            yield* sql`
              INSERT INTO executor_grant (id, server_url, oauth_state, imported_at, updated_at)
              VALUES (1, ${state.serverUrl}, ${encoded}, ${now()}, ${now()})
            `.pipe(
              sql.withTransaction,
              Effect.mapError(
                failure("import", "the grant row could not be written")
              )
            );

            yield* Effect.logInfo("Executor grant imported").pipe(
              Effect.annotateLogs({ event: "executor_grant_imported" })
            );
          }

          if (fileThere) {
            yield* fs
              .rename(paths.grantFile, importedFile)
              .pipe(
                Effect.mapError(
                  failure("import", `${paths.grantFile} could not be renamed`)
                )
              );
          }
        }

        const load = Effect.gen(function* () {
          if (!held) {
            return Option.none<McpOAuthState>();
          }

          const kept = yield* Ref.get(memory);

          if (Option.isSome(kept)) {
            return kept;
          }

          const row = yield* readRow;

          if (Option.isNone(row)) {
            return Option.none<McpOAuthState>();
          }

          const state: McpOAuthState = yield* decodeStoredState(
            row.value.oauth_state
          ).pipe(
            Effect.mapError(failure("read", "the stored grant is not a grant"))
          );

          yield* Ref.set(memory, Option.some(state));

          return Option.some(state);
        });

        const save = Effect.fn("ExecutorGrant.save")(function* (
          state: McpOAuthState
        ) {
          if (!held) {
            return yield* new ExecutorGrantError({
              message:
                "Executor grant save refused: another process holds the grant. Stop it, then restart this brain.",
              operation: "save",
            });
          }

          const before = yield* load;

          const encoded = yield* encodeStoredState(state).pipe(
            Effect.mapError(failure("save", "the grant could not be encoded"))
          );

          yield* sql`
            INSERT INTO executor_grant (id, server_url, oauth_state, updated_at)
            VALUES (1, ${state.serverUrl}, ${encoded}, ${now()})
            ON CONFLICT (id) DO UPDATE SET
              server_url = excluded.server_url,
              oauth_state = excluded.oauth_state,
              updated_at = excluded.updated_at
          `.pipe(
            Effect.mapError(
              failure("save", "the grant row could not be written")
            )
          );

          yield* Ref.set(memory, Option.some(state));

          const newTokens =
            state.tokens !== undefined &&
            Option.match(before, {
              onNone: () => true,
              onSome: (previous) =>
                previous.tokens?.access_token !== state.tokens?.access_token,
            });

          // Tokens the brain got itself: the imported file has served its purpose.
          if (newTokens) {
            yield* fs.remove(importedFile).pipe(Effect.ignore);
          }

          return yield* Effect.void;
        });

        const clientRedirect = Effect.gen(function* () {
          const row = yield* readRow;

          return Option.flatMap(row, (found) =>
            Option.fromNullOr(found.client_redirect_url)
          );
        });

        const setClientRedirect = Effect.fn("ExecutorGrant.setClientRedirect")(
          function* (url: string) {
            yield* sql`
              UPDATE executor_grant SET client_redirect_url = ${url}, updated_at = ${now()}
              WHERE id = 1
            `.pipe(
              Effect.mapError(
                failure("save", "the client redirect could not be written")
              )
            );
          }
        );

        const beginSignIn = Effect.fn("ExecutorGrant.beginSignIn")(function* (
          oauthState: string
        ) {
          yield* sql`
            UPDATE executor_grant SET pending_state = ${oauthState}, pending_at = ${now()}
            WHERE id = 1
          `.pipe(
            Effect.mapError(
              failure("sign-in", "the sign-in could not be recorded")
            )
          );
        });

        const takeSignIn = Effect.fn("ExecutorGrant.takeSignIn")(function* (
          oauthState: string
        ) {
          const rows = yield* sql`
            SELECT pending_at FROM executor_grant WHERE id = 1 AND pending_state = ${oauthState}
          `.pipe(
            Effect.flatMap(decodePendingRows),
            Effect.mapError(failure("sign-in", "the sign-in could not be read"))
          );

          // Single use, whatever happens next.
          yield* sql`
            UPDATE executor_grant SET pending_state = NULL, pending_at = NULL WHERE id = 1
          `.pipe(
            Effect.mapError(
              failure("sign-in", "the sign-in could not be cleared")
            )
          );

          const at = rows[0]?.pending_at;

          return (
            at !== undefined && now() - at <= Duration.toMillis(SIGN_IN_TTL)
          );
        });

        const signedIn = sql`
          UPDATE executor_grant SET signed_in_at = ${now()} WHERE id = 1
        `.pipe(
          Effect.asVoid,
          Effect.mapError(
            failure("sign-in", "the sign-in time could not be written")
          )
        );

        const needsSignIn = Effect.fn("ExecutorGrant.needsSignIn")(function* (
          detail: string
        ) {
          yield* sql`
            INSERT INTO executor_sign_in_needed (at, detail) VALUES (${now()}, ${detail})
          `.pipe(
            Effect.mapError(
              failure("signal", "the sign-in signal could not be written")
            )
          );
        });

        return ExecutorGrant.of({
          held,
          load,
          save,
          clientRedirect,
          setClientRedirect,
          beginSignIn,
          takeSignIn,
          signedIn,
          needsSignIn,
        });
      })
    );

  /** The deployed grant: `cairn.json`'s config directory and the user's state directory. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;

      return ExecutorGrant.layerWith(defaultGrantPaths(config.configDir));
    })
  );

  /**
   * A grant in memory, held: for the fake Executor (dev and judges) and tests. Never touches the
   * deployed grant or its lock.
   */
  static readonly layerMemory = (initial: Option.Option<McpOAuthState>) =>
    Layer.effect(
      ExecutorGrant,
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const state = yield* Ref.make(initial);
        const redirect = yield* Ref.make(Option.none<string>());

        const pending = yield* Ref.make(
          Option.none<{ state: string; at: number }>()
        );

        const now = () => clock.currentTimeMillisUnsafe();

        return ExecutorGrant.of({
          held: true,
          load: Ref.get(state),
          save: (next) => Ref.set(state, Option.some(next)),
          clientRedirect: Ref.get(redirect),
          setClientRedirect: (url) => Ref.set(redirect, Option.some(url)),
          beginSignIn: (oauthState) =>
            Ref.set(pending, Option.some({ state: oauthState, at: now() })),
          takeSignIn: (oauthState) =>
            Ref.getAndSet(pending, Option.none()).pipe(
              Effect.map((found) =>
                Option.match(found, {
                  onNone: () => false,
                  onSome: (entry) =>
                    entry.state === oauthState &&
                    now() - entry.at <= Duration.toMillis(SIGN_IN_TTL),
                })
              )
            ),
          signedIn: Effect.void,
          needsSignIn: (detail) =>
            Effect.logWarning("Executor needs sign-in").pipe(
              Effect.annotateLogs({ event: "executor_needs_sign_in", detail })
            ),
        });
      })
    );
}
