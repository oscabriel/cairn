// Cairn's own OAuth sign-ins (ADR 0009, ADR 0037): kept in `cairn.sqlite`, held by one process.
//
// - Storage. One `oauth_credentials` row per provider (migration 0007): pi-ai's `OAuthCredential`
//   as JSON, with the sign-in and refresh times. Tokens never reach a log, an event or an error
//   message; what is reported is the provider id, the operation and a classified reason.
// - One holder. A provider that rotates its refresh token on every refresh (Codex does) treats a
//   reused one as theft, so only one process may refresh. The holder keeps an exclusive `flock` on
//   `~/.local/state/cairn/oauth.lock` for its whole life, through a `flock` child whose stdin is a
//   pipe from the brain, as the Executor grant does with its own lock file (`ExecutorGrant.ts`):
//   when the brain exits, even by `kill -9`, the pipe closes, the child exits and the lock is free.
//   A brain that finds the lock taken never reads or writes a credential: its providers read as
//   unavailable, and every write is refused.
// - One write at a time. `modify` runs its update and the row's write under one permit, and a
//   `read` waits for that permit, so a rotated refresh token is on disk before anyone reads the
//   provider again. Once an update has started it runs to its write uninterrupted: the provider
//   may already have rotated the token, and dropping the answer would strand the grant.
//
// `source` is the same store as pi-ai's `CredentialStore` methods, for `CairnCredentialStore`.

import path from "node:path";

import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import {
  Clock,
  Context,
  Effect,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql";

import { ServerConfig } from "../Config.ts";
import type { OAuthCredentialSource } from "./CredentialStore.ts";
import { OAUTH_PROVIDERS } from "./CredentialStore.ts";

/** The exit status `flock -n` uses here when another process holds the lock. */
const LOCK_BUSY = 75;

/** Reading or writing a sign-in failed. Nothing stored changed unless the message says so. */
export class OAuthStoreError extends Schema.TaggedError<OAuthStoreError>()(
  "OAuthStoreError",
  {
    message: Schema.String,
    operation: Schema.Literals(["lock", "read", "write", "remove"]),
    reason: Schema.Literals([
      /** Another process holds the OAuth lock; this one never touches a credential. */
      "not_holder",
      /** `cairn.sqlite` could not be read or written. */
      "storage",
      /** A stored row or a credential to store is not an OAuth credential. */
      "malformed",
    ]),
    provider: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

// pi-ai's `OAuthCredential`: the three fields every provider has, plus whatever else the provider
// keeps (Codex: `accountId`), kept as JSON.
const StoredCredential = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Finite,
  }),
  [Schema.Record(Schema.String, Schema.Json)]
);

const StoredCredentialJson = Schema.fromJsonString(StoredCredential);

const decodeStoredCredential = Schema.decodeEffect(StoredCredentialJson);

// A credential pi-ai handed over (a login's or a refresh's result) is vendor data: validated and
// encoded in one step.
const encodeCredential = Schema.encodeUnknownEffect(StoredCredentialJson);

const CredentialRow = Schema.Struct({
  credential_json: Schema.String,
  signed_in_at: Schema.Finite,
  refreshed_at: Schema.NullOr(Schema.Finite),
});

const decodeCredentialRows = Schema.decodeUnknownEffect(
  Schema.Array(CredentialRow)
);

/** When a provider was signed in and last refreshed. Never a token. */
export interface OAuthSignIn {
  /** Epoch milliseconds of the last sign-in. */
  readonly signedInAt: number;
  /** Epoch milliseconds of the last refresh, none before the first. */
  readonly refreshedAt: Option.Option<number>;
}

/** The default lock: `oauth.lock` in Cairn's state directory, beside the Executor grant's. */
export const defaultOAuthLock = (stateDir: string): string =>
  path.join(stateDir, "cairn", "oauth.lock");

const storageFailure =
  (operation: OAuthStoreError["operation"], provider: string, what: string) =>
  (cause: unknown): OAuthStoreError =>
    new OAuthStoreError({
      message: `OAuth store ${operation} failed for ${provider}: ${what}. Nothing stored changed; check cairn.sqlite, then retry.`,
      operation,
      reason: "storage",
      provider,
      cause,
    });

const notHolder = (
  operation: OAuthStoreError["operation"],
  provider: string
): OAuthStoreError =>
  new OAuthStoreError({
    message: `OAuth store ${operation} refused for ${provider}: another Cairn brain holds the OAuth lock, so this one never reads or writes sign-ins. Use the brain that holds it, or stop that brain and restart this one.`,
    operation,
    reason: "not_holder",
    provider,
  });

/** Holds the OAuth lock until the scope closes. True when this process holds it. */
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
      return yield* new OAuthStoreError({
        message: `OAuth store lock failed: flock exited ${String(code)} on ${lockFile}. Check that util-linux's flock is installed and the state directory is writable.`,
        operation: "lock",
        reason: "storage",
      });
    }

    return false;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new OAuthStoreError({
          message: `OAuth store lock failed: flock could not run on ${lockFile}. Check that util-linux's flock is installed and the state directory is writable.`,
          operation: "lock",
          reason: "storage",
          cause,
        })
      )
    )
  );

/**
 * pi-ai's update, run inside `modify`. Its rejection (a failed refresh) becomes a defect here, so
 * the source's promise rejects with the very same error: pi-ai tells its errors apart by class. An
 * API key is refused, never stored.
 */
const piUpdate = (
  provider: string,
  update: (current: Credential | undefined) => Promise<Credential | undefined>,
  current: Option.Option<OAuthCredential>
) =>
  Effect.gen(function* () {
    const next = yield* Effect.promise(
      async () => await update(Option.getOrUndefined(current))
    );

    if (next === undefined) {
      return Option.none<OAuthCredential>();
    }

    if (next.type !== "oauth") {
      return yield* new OAuthStoreError({
        message: `OAuth store write refused for ${provider}: an API key is not kept here. Nothing was stored.`,
        operation: "write",
        reason: "malformed",
        provider,
      });
    }

    return Option.some(next);
  });

/** Cairn's own OAuth credentials: kept in `cairn.sqlite`, written by one process at a time. */
export class OAuthStore extends Context.Service<
  OAuthStore,
  {
    /** False when another process holds the OAuth lock: then nothing here reads or writes. */
    readonly held: boolean;
    /** The stored credential of `provider`, if any; none when this process is not the holder. */
    read(
      provider: string
    ): Effect.Effect<Option.Option<OAuthCredential>, OAuthStoreError>;
    /**
     * Runs `update` on the stored credential under the store's one permit and writes what it
     * returns before the permit is released (none leaves the row as it is). A write over an
     * existing row is a refresh; a first write is a sign-in. Fails with `not_holder` when another
     * process holds the lock. Interrupting it after `update` started does not stop the write.
     */
    modify<E>(
      provider: string,
      update: (
        current: Option.Option<OAuthCredential>
      ) => Effect.Effect<Option.Option<OAuthCredential>, E>
    ): Effect.Effect<Option.Option<OAuthCredential>, OAuthStoreError | E>;
    /** Stores a credential a new sign-in produced, replacing any earlier one. */
    signIn(
      provider: string,
      credential: OAuthCredential
    ): Effect.Effect<void, OAuthStoreError>;
    /** Removes a provider's credential (sign out). True when there was one. */
    remove(provider: string): Effect.Effect<boolean, OAuthStoreError>;
    /** When `provider` was signed in and refreshed, if it is; never a token. */
    signedIn(
      provider: string
    ): Effect.Effect<Option.Option<OAuthSignIn>, OAuthStoreError>;
    /** The same store for pi-ai's credential store (`CairnCredentialStore`). */
    readonly source: OAuthCredentialSource;
  }
>()("cairn/server/models/OAuthStore") {
  /**
   * The store in `cairn.sqlite` (`oauth_credentials`, migration 0007), behind the lock at
   * `lockFile`. Needs `SqlClient`, `FileSystem` and `ChildProcessSpawner`.
   */
  static readonly layerWith = (lockFile: string) =>
    Layer.effect(
      OAuthStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const clock = yield* Clock.Clock;
        const held = yield* holdLock(lockFile);
        const permit = yield* Semaphore.make(1);
        const run = yield* FiberSet.makeRuntimePromise();

        const now = () => clock.currentTimeMillisUnsafe();

        if (!held) {
          yield* Effect.logWarning(
            "another process holds the OAuth lock; this brain will not use its sign-ins"
          ).pipe(Effect.annotateLogs({ event: "oauth_lock_busy" }));
        }

        const readRow = Effect.fn("OAuthStore.readRow")(function* (
          provider: string
        ) {
          const rows = yield* sql`
            SELECT credential_json, signed_in_at, refreshed_at FROM oauth_credentials
            WHERE provider_id = ${provider}
          `.pipe(
            Effect.flatMap(decodeCredentialRows),
            Effect.mapError(
              storageFailure("read", provider, "the row could not be read")
            )
          );

          return Option.fromUndefinedOr(rows[0]);
        });

        const credentialOf = Effect.fn("OAuthStore.credentialOf")(function* (
          provider: string,
          json: string
        ) {
          const stored: OAuthCredential = yield* decodeStoredCredential(
            json
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OAuthStoreError({
                  message: `OAuth store read failed for ${provider}: the stored row is not an OAuth credential. Sign in again to replace it.`,
                  operation: "read",
                  reason: "malformed",
                  provider,
                  cause,
                })
            )
          );

          return stored;
        });

        const readUnlocked = Effect.fn("OAuthStore.readUnlocked")(function* (
          provider: string
        ) {
          const row = yield* readRow(provider);

          if (Option.isNone(row)) {
            return Option.none<OAuthCredential>();
          }

          return Option.some(
            yield* credentialOf(provider, row.value.credential_json)
          );
        });

        const encode = Effect.fn("OAuthStore.encode")(function* (
          provider: string,
          credential: OAuthCredential
        ) {
          return yield* encodeCredential(credential).pipe(
            Effect.mapError(
              (cause) =>
                new OAuthStoreError({
                  message: `OAuth store write refused for ${provider}: the credential is not an OAuth credential with access and refresh tokens and an expiry. Nothing was stored; sign in again.`,
                  operation: "write",
                  reason: "malformed",
                  provider,
                  cause,
                })
            )
          );
        });

        const writeSignIn = Effect.fn("OAuthStore.writeSignIn")(function* (
          provider: string,
          credential: OAuthCredential
        ) {
          const json = yield* encode(provider, credential);
          const at = now();

          yield* sql`
            INSERT INTO oauth_credentials
              (provider_id, credential_json, signed_in_at, refreshed_at, updated_at)
            VALUES (${provider}, ${json}, ${at}, NULL, ${at})
            ON CONFLICT (provider_id) DO UPDATE SET
              credential_json = excluded.credential_json,
              signed_in_at = excluded.signed_in_at,
              refreshed_at = NULL,
              updated_at = excluded.updated_at
          `.pipe(
            Effect.mapError(
              storageFailure("write", provider, "the row could not be written")
            )
          );
        });

        const writeRefresh = Effect.fn("OAuthStore.writeRefresh")(function* (
          provider: string,
          credential: OAuthCredential
        ) {
          const json = yield* encode(provider, credential);
          const at = now();

          yield* sql`
            UPDATE oauth_credentials
            SET credential_json = ${json}, refreshed_at = ${at}, updated_at = ${at}
            WHERE provider_id = ${provider}
          `.pipe(
            Effect.mapError(
              storageFailure("write", provider, "the row could not be written")
            )
          );
        });

        const read = Effect.fn("OAuthStore.read")(function* (provider: string) {
          if (!held) {
            return Option.none<OAuthCredential>();
          }

          return yield* permit.withPermits(1)(readUnlocked(provider));
        });

        const modify = <E>(
          provider: string,
          update: (
            current: Option.Option<OAuthCredential>
          ) => Effect.Effect<Option.Option<OAuthCredential>, E>
        ): Effect.Effect<Option.Option<OAuthCredential>, OAuthStoreError | E> =>
          Effect.gen(function* () {
            if (!held) {
              return yield* notHolder("write", provider);
            }

            // Waiting for the permit can be interrupted; the update and its write cannot.
            return yield* permit.withPermits(1)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const current = yield* readUnlocked(provider);
                  const next = yield* update(current);

                  if (Option.isNone(next)) {
                    return current;
                  }

                  yield* Option.isSome(current)
                    ? writeRefresh(provider, next.value)
                    : writeSignIn(provider, next.value);

                  return next;
                })
              )
            );
          }).pipe(Effect.withSpan("OAuthStore.modify"));

        const signIn = Effect.fn("OAuthStore.signIn")(function* (
          provider: string,
          credential: OAuthCredential
        ) {
          if (!held) {
            return yield* notHolder("write", provider);
          }

          yield* permit.withPermits(1)(
            Effect.uninterruptible(writeSignIn(provider, credential))
          );

          return yield* Effect.logInfo("signed in").pipe(
            Effect.annotateLogs({ event: "oauth_signed_in", provider })
          );
        });

        const remove = Effect.fn("OAuthStore.remove")(function* (
          provider: string
        ) {
          if (!held) {
            return yield* notHolder("remove", provider);
          }

          const removed = yield* permit.withPermits(1)(
            Effect.gen(function* () {
              const row = yield* readRow(provider);

              yield* sql`
                DELETE FROM oauth_credentials WHERE provider_id = ${provider}
              `.pipe(
                Effect.mapError(
                  storageFailure(
                    "remove",
                    provider,
                    "the row could not be deleted"
                  )
                )
              );

              return Option.isSome(row);
            })
          );

          yield* Effect.logInfo("signed out").pipe(
            Effect.annotateLogs({ event: "oauth_signed_out", provider })
          );

          return removed;
        });

        const signedIn = Effect.fn("OAuthStore.signedIn")(function* (
          provider: string
        ) {
          if (!held) {
            return Option.none<OAuthSignIn>();
          }

          const row = yield* readRow(provider);

          return Option.map(row, (found): OAuthSignIn => ({
            signedInAt: found.signed_in_at,
            refreshedAt: Option.fromNullOr(found.refreshed_at),
          }));
        });

        const source: OAuthCredentialSource = {
          providers: OAUTH_PROVIDERS,
          held,
          read: async (provider) =>
            Option.getOrUndefined(await run(read(provider))),
          modify: async (provider, update) =>
            Option.getOrUndefined(
              await run(
                modify(provider, (current) =>
                  piUpdate(provider, update, current)
                )
              )
            ),
          delete: async (provider) => {
            await run(remove(provider));
          },
        };

        return OAuthStore.of({
          held,
          read,
          modify,
          signIn,
          remove,
          signedIn,
          source,
        });
      })
    );

  /**
   * The deployed store: `cairn.sqlite`'s table behind `oauth.lock` in the state directory. The
   * data directory is kept owner-only (0700), since the database and its backups hold tokens.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;

      yield* fs.makeDirectory(config.dataDir, { recursive: true });
      yield* fs.chmod(config.dataDir, 0o700);

      return OAuthStore.layerWith(defaultOAuthLock(config.stateDir));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OAuthStoreError({
            message:
              "OAuth store setup failed: the data directory could not be made owner-only. Check its owner and permissions, then restart.",
            operation: "lock",
            reason: "storage",
            cause,
          })
      )
    )
  );
}
