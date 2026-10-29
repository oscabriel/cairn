// The Codex login as the usage reader needs it: the current access token and the ChatGPT account it
// belongs to, or nothing while no login is held. Cairn owns the token (ADR 0009, ADR 0037) and keeps
// it in `OAuthStore`; only the brain that holds the OAuth lock reads it. A token within five minutes
// of its expiry is refreshed first, through the store's one permit as pi-ai's own refresh does
// (`refreshStoredOAuthCredential`), so the reader never sends a token known to be stale and a
// rotated refresh token is on disk before anyone reads the login again.
//
// A service, not a reference with a default: `layer` (over an `OAuthStore`), `layerSignedOut` (tests
// that read no Codex windows) or `layerIfHeld` (the app, which follows whether its root gave it an
// `OAuthStore`, as `CodexLogin.layer` does) must be chosen, so a forgotten provision is a type error
// rather than a meter that silently shows no Codex row.

import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";

import { CODEX_PROVIDER } from "./CredentialStore.ts";
import { OAuthStore } from "./OAuthStore.ts";
import type { OAuthStoreError } from "./OAuthStore.ts";

/** A value that may go into an HTTP header: printable ASCII, no spaces or line breaks. */
const HeaderValue = Schema.String.check(Schema.isPattern(/^[!-~]+$/u));

/** The parts of a Codex OAuth login a usage read sends. */
export const CodexCredential = Schema.Struct({
  /** The OAuth access token, sent as `Authorization: Bearer`. */
  access: Schema.Redacted(HeaderValue),
  /** The ChatGPT account the token belongs to, sent as `ChatGPT-Account-Id`. */
  accountId: HeaderValue,
});

export type CodexCredential = typeof CodexCredential.Type;

const decodeCodexCredential = Schema.decodeEffect(CodexCredential);

/**
 * Parse a credential the login holder already keeps as plain strings; fails with `SchemaError` when
 * either part could not go into a header.
 */
export const parseCodexCredential = (input: {
  readonly access: string;
  readonly accountId: string;
}) =>
  decodeCodexCredential({
    access: Redacted.make(input.access),
    accountId: input.accountId,
  });

/** A token with less than this left is refreshed before a read, as pi-ai does before a request. */
export const REFRESH_MARGIN = Duration.minutes(5);

/** How long one refresh may take; pi-ai bounds its own the same way. */
export const REFRESH_TIMEOUT = Duration.seconds(15);

/** The Codex login could not be read or refreshed. Never carries a token. */
export class CodexAccessError extends Schema.TaggedError<CodexAccessError>()(
  "CodexAccessError",
  {
    /** Words safe to log and to show as a reading's reason. */
    message: Schema.String,
    reason: Schema.Literals([
      /** `cairn.sqlite` could not be read or written. */
      "storage",
      /** The token was stale and OpenAI refused or did not answer the refresh. */
      "refresh_failed",
      /** The stored login cannot go into a request's headers. */
      "malformed",
    ]),
  }
) {}

/** Exchanges a stale credential for a fresh one; pi-ai's `OAuthAuth.refresh`. */
export type CodexRefresh = (
  credential: OAuthCredential,
  signal: AbortSignal
) => Promise<OAuthCredential>;

const storage = (cause: OAuthStoreError) =>
  new CodexAccessError({
    message: `the Codex login could not be read (${cause.reason})`,
    reason: "storage",
  });

/** The ChatGPT account a stored Codex login names; pi-ai keeps it beside the tokens. */
const AccountOf = Schema.Struct({ accountId: Schema.NonEmptyString });

const decodeAccountOf = Schema.decodeUnknownOption(AccountOf);

const needsRefresh = (credential: OAuthCredential, now: number) =>
  now + Duration.toMillis(REFRESH_MARGIN) >= credential.expires;

/** How the usage reader reaches the Codex login. */
export class CodexAccess extends Context.Service<
  CodexAccess,
  {
    /**
     * The current credential, refreshed first when it is within `REFRESH_MARGIN` of expiry; none
     * while no login is held, while another brain holds the OAuth lock, or when the stored login
     * names no ChatGPT account.
     */
    readonly credential: Effect.Effect<
      Option.Option<CodexCredential>,
      CodexAccessError
    >;
  }
>()("cairn/server/usage/CodexAccess") {
  /** No Codex login: judge and dev brains, and tests that read no Codex windows. */
  static readonly layerSignedOut = Layer.succeed(
    CodexAccess,
    CodexAccess.of({ credential: Effect.succeedNone })
  );

  /** Over the brain's `OAuthStore`, refreshing a stale token with `refresh`. For tests. */
  static readonly layerWith = (refresh: CodexRefresh) =>
    Layer.effect(
      CodexAccess,
      Effect.gen(function* () {
        const store = yield* OAuthStore;

        // Under the store's permit: re-checked there, so concurrent reads refresh once.
        const refreshed = store
          .modify(CODEX_PROVIDER, (latest) =>
            Effect.gen(function* () {
              if (Option.isNone(latest)) {
                return Option.none<OAuthCredential>();
              }

              const now = yield* Clock.currentTimeMillis;

              if (!needsRefresh(latest.value, now)) {
                return Option.none<OAuthCredential>();
              }

              const next = yield* Effect.tryPromise({
                try: async () =>
                  await refresh(
                    latest.value,
                    AbortSignal.timeout(Duration.toMillis(REFRESH_TIMEOUT))
                  ),
                // OpenAI's answer can quote the request; only the fact is kept.
                catch: () =>
                  new CodexAccessError({
                    message:
                      "the Codex access token is stale and its refresh failed; sign in to Codex again if this persists",
                    reason: "refresh_failed",
                  }),
              });

              return Option.some(next);
            })
          )
          .pipe(
            Effect.catchTag("OAuthStoreError", (cause) =>
              Effect.fail(storage(cause))
            )
          );

        const credential = Effect.gen(function* () {
          if (!store.held) {
            return Option.none<CodexCredential>();
          }

          const stored = yield* store
            .read(CODEX_PROVIDER)
            .pipe(Effect.mapError(storage));

          if (Option.isNone(stored)) {
            return Option.none<CodexCredential>();
          }

          const now = yield* Clock.currentTimeMillis;

          const current = needsRefresh(stored.value, now)
            ? yield* refreshed
            : stored;

          if (Option.isNone(current)) {
            return Option.none<CodexCredential>();
          }

          const account = decodeAccountOf(current.value);

          if (Option.isNone(account)) {
            return Option.none<CodexCredential>();
          }

          const { accountId } = account.value;
          const { access } = current.value;

          return Option.some(
            yield* parseCodexCredential({ access, accountId }).pipe(
              Effect.mapError(
                () =>
                  new CodexAccessError({
                    message:
                      "the stored Codex login cannot go into a request header; sign in to Codex again",
                    reason: "malformed",
                  })
              )
            )
          );
        }).pipe(Effect.withSpan("CodexAccess.credential"));

        return CodexAccess.of({ credential });
      })
    );

  /** The deployed brain's: over its `OAuthStore`, refreshing through pi-ai's Codex OAuth. */
  static readonly layer = Layer.unwrap(
    Effect.sync(() => {
      // pi-ai's Codex provider always has OAuth auth; without it a stale token cannot be renewed.
      const oauth: Option.Option<OAuthAuth> = Option.fromUndefinedOr(
        openaiCodexProvider().auth.oauth
      );

      return CodexAccess.layerWith(
        Option.match(oauth, {
          onNone: () => async () =>
            await Promise.reject(new Error("pi-ai has no Codex OAuth")),
          onSome: (flow) => async (credential, signal) =>
            await flow.refresh(credential, signal),
        })
      );
    })
  );

  /**
   * Over `OAuthStore` when the brain provides one, signed out otherwise: the same choice
   * `CodexLogin.layer` and `PiModelSource` make. `main.ts` gives the app its `OAuthStore`; judge and
   * dev brains give none, so they never read the user's Codex login.
   */
  static readonly layerIfHeld = Layer.unwrap(
    Effect.map(Effect.serviceOption(OAuthStore), (store) =>
      Option.match(store, {
        onNone: () => CodexAccess.layerSignedOut,
        onSome: (found) =>
          CodexAccess.layer.pipe(
            Layer.provide(Layer.succeed(OAuthStore, found))
          ),
      })
    )
  );
}
