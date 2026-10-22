// Cairn's one link to Executor (plan "Executor tools"): one long-lived pi-mcp `McpClient` over
// `StreamableHttpTransport({url, authProvider, openGetStream: false})` and one shared
// `adaptOAuthProvider`, so concurrent 401s share one refresh: Executor treats a reused rotated
// refresh token as theft. The client declares no `elicitation` capability, so Executor runs in
// model mode and every pause comes back as a result (ExecutorReply.ts).
//
// - Sessions. Executor keeps MCP sessions and pending requests in memory. A session it no longer
//   knows (404, `McpSessionExpiredError`) means it restarted: Executor refused that request before
//   doing anything, so it is the only failure resent, once, on a new session. Any other failure
//   of a sent request leaves its outcome unknown.
// - Pings. While a call is in flight the link pings Executor every 15 s, so a restart that loses a
//   long call's session shows without waiting for the request timeout: the call fails as lost, and
//   it may have run.
// - Status. `connected`, `needs-sign-in` (the grant was refused; the transition is recorded once
//   through `ExecutorGrant.needsSignIn` for the notifier), `unreachable`, or `disabled` (no grant,
//   or another process holds it).
// - Sign-in. `signIn` starts an OAuth authorization from Cairn's own callback
//   (`/oauth/executor/callback`) when the grant no longer works, and `callback` finishes it.
//
// Only `main.ts` composes `ExecutorLink.layer`; dev and judge brains compose `layerFake`, a fake
// Executor on a loopback port with a grant in memory, and tests that need no Executor compose
// `layerDisabled` (Composition.test.ts greps for both rules).
//
// Ported from cairn-v1, apps/server/src/Executor.ts at 1a5cd4a (`makeConnection`, `call`, `lose`,
// `ping`, `check`, `connect`, `callback`, `CairnOAuthProvider`). Changed: one grant from the
// database (no `mcp.json` declaration, `redeclare` or `confirm`), Effect state instead of closures,
// and the scoped resource metadata URL derived from the grant's own server URL.
import type { ExecutorStatus } from "@cairn/protocol/Executor";
import {
  McpClient,
  McpError,
  McpSessionExpiredError,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type {
  McpOAuthState,
  OAuthFlowOptions,
} from "@earendil-works/pi-mcp/oauth";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
} from "@earendil-works/pi-mcp/oauth";
import type { Stream } from "effect";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  SubscriptionRef,
  Result,
} from "effect";

import { ServerConfig } from "../Config.ts";
import { ExecutorGrant } from "./ExecutorGrant.ts";
import { parseReply } from "./ExecutorReply.ts";
import type { ExecutorReply, JsonObject } from "./ExecutorReply.ts";
import { startFakeExecutor } from "./FakeExecutor.ts";

/** The path of the OAuth redirect Executor sends a sign-in back to. */
export const CALLBACK_PATH = "/oauth/executor/callback";

/** Per MCP request. An approved call runs inside `resume`, and Executor allows a program 5 minutes. */
const REQUEST_TIMEOUT_MS = 6 * 60_000;

/** A ping's own limit. */
const PING_TIMEOUT_MS = 5000;

/** Executor's MCP tools Cairn calls. `resume` is never offered to a model. */
export type ExecutorTool =
  | "skills"
  | "search"
  | "describe"
  | "call"
  | "execute"
  | "resume";

/** How the link behaves: how often it pings while calls are in flight. */
export const ExecutorLinkOptions = Context.Reference<{
  readonly pingInterval: Duration.Duration;
}>("cairn/server/executor/ExecutorLink/ExecutorLinkOptions", {
  defaultValue: () => ({ pingInterval: Duration.seconds(15) }),
});

/** One Executor call failed. `sent` is true when Executor may have received it (it may have run). */
export class ExecutorCallError extends Schema.TaggedError<ExecutorCallError>()(
  "ExecutorCallError",
  {
    message: Schema.String,
    tool: Schema.String,
    reason: Schema.Literals([
      /** The grant was refused or there is none: nothing was sent. */
      "sign_in_required",
      /** Executor could not be reached to open a session: nothing was sent. */
      "unreachable",
      /** Executor lost the session (it restarted). */
      "session_lost",
      /** Executor answered the request with a protocol error: it did not run. */
      "rejected",
      /** The request failed after it was sent. */
      "transport",
    ]),
    sent: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** A sign-in could not start or finish. */
export class ExecutorSignInError extends Schema.TaggedError<ExecutorSignInError>()(
  "ExecutorSignInError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "not_configured",
      "already_connected",
      "unknown_state",
      "refused",
      "failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** The query Executor's redirect carries back to the callback. */
export interface CallbackQuery {
  readonly state: Option.Option<string>;
  readonly code: Option.Option<string>;
  readonly iss: Option.Option<string>;
  readonly error: Option.Option<string>;
  readonly errorDescription: Option.Option<string>;
}

/** pi-mcp's provider, holding back the PKCE verifier and redirect outside a sign-in Cairn started. */
class CairnOAuthProvider extends McpOAuthProvider {
  signingIn = false;
  redirect: Option.Option<URL> = Option.none();

  // A refresh that fails mid-call runs the redirect half of the flow; saving its verifier would
  // break a sign-in the user is in the middle of.
  override async saveCodeVerifier(verifier: string) {
    if (this.signingIn) {
      await super.saveCodeVerifier(verifier);
    }
  }

  override async redirectToAuthorization(url: URL) {
    if (this.signingIn) {
      this.redirect = Option.some(url);
    }

    await Promise.resolve();
  }
}

/** One MCP session. `lost` completes when Executor turned out to have forgotten it. */
interface Session {
  readonly client: McpClient;
  readonly lost: Deferred.Deferred<boolean>;
}

/** What a failed MCP request threw, kept whole for classification. */
class RawFailure extends Schema.TaggedError<RawFailure>()("RawFailure", {
  cause: Schema.Defect(),
  lost: Schema.Boolean,
}) {}

const errorText = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);

const SIGN_IN_TEXT =
  "Executor needs sign-in: Cairn's grant was refused. Open Cairn's settings and connect Executor again.";

/** A call refused before anything was sent: there is no usable grant. */
const disabledCall = (detail: string) =>
  Effect.fail(
    new ExecutorCallError({
      message: `${detail} Nothing was sent to Executor.`,
      tool: "none",
      reason: "sign_in_required",
      sent: false,
    })
  );

const signInFailure =
  (reason: ExecutorSignInError["reason"]) => (cause: unknown) =>
    new ExecutorSignInError({
      message: `Executor sign-in failed: ${errorText(cause)}. Start it again from Cairn's settings.`,
      reason,
      cause,
    });

/** Closes a client, ignoring a failure: the session is being dropped either way. */
const closeQuietly = (client: McpClient) =>
  Effect.tryPromise(async () => {
    await client.close();
  }).pipe(Effect.ignore);

/** What a link without a usable grant answers: every call and sign-in refused, nothing sent. */
const disabledParts = (detail: string) => ({
  call: () => disabledCall(detail),
  signIn: Effect.fail(
    new ExecutorSignInError({
      message: `${detail} Sign-in needs a stored grant's server address.`,
      reason: "not_configured",
    })
  ),
  callback: () =>
    Effect.fail(
      new ExecutorSignInError({ message: detail, reason: "not_configured" })
    ),
});

/** pi-mcp's redirect hook: the consent page URL is kept by `CairnOAuthProvider` instead. */
const ignoreRedirect = async () => {
  await Promise.resolve();
};

/** The scoped resource metadata URL: Executor names the scoped resource only when it carries the query. */
const resourceMetadataUrlOf = (serverUrl: string) => {
  const parsed = new URL(serverUrl);

  return new URL(
    `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}${parsed.search}`
  );
};

/** The brain's link to Executor. */
export class ExecutorLink extends Context.Service<
  ExecutorLink,
  {
    /**
     * One Executor tool call. A session Executor no longer knows is reopened and the request resent
     * once. Interrupting the effect aborts the request. Fails with `ExecutorCallError`.
     */
    call(
      tool: ExecutorTool,
      args: JsonObject
    ): Effect.Effect<ExecutorReply, ExecutorCallError>;
    /** Where the link stands now. */
    readonly status: Effect.Effect<ExecutorStatus>;
    /** The status, then every change. */
    readonly statusChanges: Stream.Stream<ExecutorStatus>;
    /** Starts a sign-in; returns Executor's consent page. Refused while the grant still works. */
    readonly signIn: Effect.Effect<string, ExecutorSignInError>;
    /** Finishes a sign-in from the redirect's query. */
    callback(query: CallbackQuery): Effect.Effect<void, ExecutorSignInError>;
  }
>()("cairn/server/executor/ExecutorLink") {
  /** The link over the grant `ExecutorGrant` holds. Needs `ExecutorGrant` and `ServerConfig`. */
  static readonly layerNoDeps = Layer.effect(
    ExecutorLink,
    Effect.gen(function* () {
      const grant = yield* ExecutorGrant;
      const config = yield* ServerConfig;
      const options = yield* ExecutorLinkOptions;
      const run = yield* FiberSet.makeRuntimePromise();
      const layerScope = yield* Effect.scope;
      const redirectUrl = `${config.origin}${CALLBACK_PATH}`;

      const initial = yield* grant.load.pipe(
        Effect.orElseSucceed(() => Option.none<McpOAuthState>())
      );

      const status = yield* SubscriptionRef.make<ExecutorStatus>({
        state: "disabled",
        detail: Option.some("Executor has not been checked yet."),
        checkedAt: Option.none(),
      });

      const setStatus = Effect.fnUntraced(function* (
        state: ExecutorStatus["state"],
        detail: Option.Option<string>
      ) {
        const now = yield* DateTime.now;
        const before = yield* SubscriptionRef.get(status);

        yield* SubscriptionRef.set(status, {
          state,
          detail: Option.map(detail, (text) => text.slice(0, 4096)),
          checkedAt: Option.some(now),
        });

        if (state === "needs-sign-in" && before.state !== "needs-sign-in") {
          yield* Effect.logWarning("Executor needs sign-in").pipe(
            Effect.annotateLogs({ event: "executor_needs_sign_in" })
          );
          yield* grant
            .needsSignIn(Option.getOrElse(detail, () => SIGN_IN_TEXT))
            .pipe(Effect.ignore);
        }
      });

      if (!grant.held || Option.isNone(initial)) {
        const detail = grant.held
          ? "Cairn has no Executor grant. Run the phase 1 wizard's Executor step, then restart the brain."
          : "Another process holds Cairn's Executor grant, so this brain does not use Executor.";

        yield* setStatus("disabled", Option.some(detail));

        return ExecutorLink.of({
          ...disabledParts(detail),
          status: SubscriptionRef.get(status),
          statusChanges: SubscriptionRef.changes(status),
        });
      }

      const serverUrl = String(new URL(initial.value.serverUrl));
      const resourceMetadataUrl = resourceMetadataUrlOf(serverUrl);

      // The store pi-mcp reads and writes; the grant's address is normalised as pi-mcp's own is.
      const store = {
        load: async () =>
          Option.getOrUndefined(
            Option.map(await run(grant.load), (state) =>
              String(new URL(state.serverUrl)) === serverUrl
                ? { ...state, serverUrl }
                : state
            )
          ),
        save: async (state: McpOAuthState) => {
          await run(grant.save(state));
        },
      };

      const provider = new CairnOAuthProvider({
        serverUrl,
        redirectUrl,
        clientMetadata: { client_name: "Cairn", scope: "mcp offline_access" },
        store,
        onRedirect: ignoreRedirect,
      });

      // One adapter for every session: concurrent 401s share one refresh.
      const authProvider = adaptOAuthProvider(provider);

      const current = yield* Ref.make(Option.none<Session>());
      const opening = yield* Semaphore.make(1);
      const inFlight = yield* Ref.make(0);

      const closeClient = (client: McpClient) =>
        closeQuietly(client).pipe(Effect.forkIn(layerScope), Effect.asVoid);

      /** Forgets `session` (if it is still current) and tells whoever waits on it. */
      const lose = Effect.fnUntraced(function* (session: Session) {
        const now = yield* Ref.get(current);

        if (Option.isSome(now) && now.value === session) {
          yield* Ref.set(current, Option.none());
        }

        yield* Deferred.succeed(session.lost, true);
        yield* closeClient(session.client);
      });

      const open = opening.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* Ref.get(current);

          if (Option.isSome(existing)) {
            return existing.value;
          }

          const client = new McpClient({
            name: "cairn",
            version: "1",
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
          });

          const transport = new StreamableHttpTransport({
            url: serverUrl,
            authProvider,
            // Model mode puts every pause in a result: no server-to-client stream.
            openGetStream: false,
          });

          yield* Effect.tryPromise({
            try: async () => {
              await client.connect(transport);
            },
            catch: (cause) => new RawFailure({ cause, lost: false }),
          }).pipe(
            Effect.catchTag("RawFailure", ({ cause }) =>
              Effect.gen(function* () {
                yield* closeClient(client);

                if (cause instanceof McpOAuthAuthorizationRequiredError) {
                  yield* setStatus("needs-sign-in", Option.some(SIGN_IN_TEXT));

                  return yield* new ExecutorCallError({
                    message: `${SIGN_IN_TEXT} Nothing was sent to Executor.`,
                    tool: "connect",
                    reason: "sign_in_required",
                    sent: false,
                    cause,
                  });
                }

                const detail = `Executor could not be reached: ${errorText(cause)}`;

                yield* setStatus("unreachable", Option.some(detail));

                return yield* new ExecutorCallError({
                  message: `${detail}. Nothing was sent; try again once Executor is up.`,
                  tool: "connect",
                  reason: "unreachable",
                  sent: false,
                  cause,
                });
              })
            )
          );

          const session: Session = {
            client,
            lost: yield* Deferred.make<boolean>(),
          };

          yield* Ref.set(current, Option.some(session));
          yield* setStatus("connected", Option.none());

          return session;
        })
      );

      const request = (
        session: Session,
        tool: ExecutorTool,
        args: JsonObject
      ) =>
        Effect.raceFirst(
          Effect.tryPromise({
            try: async (signal) =>
              await session.client.callTool(
                tool,
                { ...args },
                {
                  signal,
                  timeoutMs: REQUEST_TIMEOUT_MS,
                }
              ),
            catch: (cause) => new RawFailure({ cause, lost: false }),
          }),
          Deferred.await(session.lost).pipe(
            Effect.andThen(
              Effect.fail(
                new RawFailure({
                  cause: new Error("Executor lost the session"),
                  lost: true,
                })
              )
            )
          )
        );

      const classify = Effect.fnUntraced(function* (
        tool: ExecutorTool,
        session: Session,
        failure: RawFailure
      ) {
        const { cause } = failure;

        if (failure.lost) {
          return new ExecutorCallError({
            message: `Executor restarted while ${tool} was in flight and lost it, so its outcome is unknown.`,
            tool,
            reason: "session_lost",
            sent: true,
          });
        }

        if (cause instanceof McpSessionExpiredError) {
          yield* lose(session);

          return new ExecutorCallError({
            message: `Executor no longer knows Cairn's session (it restarted), and refused ${tool} before running it.`,
            tool,
            reason: "session_lost",
            sent: false,
            cause,
          });
        }

        if (cause instanceof McpOAuthAuthorizationRequiredError) {
          // The session's grant is refused: drop it, so the next call or a sign-in starts clean.
          yield* lose(session);
          yield* setStatus("needs-sign-in", Option.some(SIGN_IN_TEXT));

          return new ExecutorCallError({
            message: `${SIGN_IN_TEXT} Nothing was sent to Executor.`,
            tool,
            reason: "sign_in_required",
            sent: false,
            cause,
          });
        }

        if (cause instanceof McpError) {
          return new ExecutorCallError({
            message: `Executor refused ${tool}: ${errorText(cause)}.`,
            tool,
            reason: "rejected",
            sent: false,
            cause,
          });
        }

        // The transport broke after the request left: drop the session, the next call opens one.
        yield* lose(session);

        return new ExecutorCallError({
          message: `Executor ${tool} failed after it was sent: ${errorText(cause)}.`,
          tool,
          reason: "transport",
          sent: true,
          cause,
        });
      });

      const attempt = (
        tool: ExecutorTool,
        args: JsonObject,
        resent: boolean
      ): Effect.Effect<ExecutorReply, ExecutorCallError> =>
        Effect.gen(function* () {
          const session = yield* open;

          const result = yield* request(session, tool, args).pipe(
            Effect.catchTag("RawFailure", (failure) =>
              Effect.flatMap(classify(tool, session, failure), Effect.fail)
            )
          );

          return parseReply(result);
        }).pipe(
          Effect.catchIf(
            (error) =>
              error.reason === "session_lost" && !error.sent && !resent,
            () => attempt(tool, args, true)
          )
        );

      const call = Effect.fn("ExecutorLink.call")(function* (
        tool: ExecutorTool,
        args: JsonObject
      ) {
        yield* Effect.annotateCurrentSpan({ tool });

        return yield* Effect.acquireUseRelease(
          Ref.update(inFlight, (count) => count + 1),
          () => attempt(tool, args, false),
          () => Ref.update(inFlight, (count) => count - 1)
        );
      });

      // While calls are in flight, a ping notices a restart that lost their session.
      const ping = Effect.gen(function* () {
        const waiting = yield* Ref.get(inFlight);
        const session = yield* Ref.get(current);

        if (waiting === 0 || Option.isNone(session)) {
          return;
        }

        const failure = yield* Effect.tryPromise({
          try: async () => {
            await session.value.client.ping({ timeoutMs: PING_TIMEOUT_MS });
          },
          catch: (cause) => new RawFailure({ cause, lost: false }),
        }).pipe(Effect.flip, Effect.option);

        if (
          Option.isSome(failure) &&
          failure.value.cause instanceof McpSessionExpiredError
        ) {
          yield* Effect.logWarning("Executor lost Cairn's session").pipe(
            Effect.annotateLogs({ event: "executor_session_lost" })
          );
          yield* lose(session.value);
        }
        // Unreachable: it may be restarting. The next ping that reaches it shows the loss.
      });

      yield* ping.pipe(
        Effect.repeat(Schedule.spaced(options.pingInterval)),
        Effect.forkScoped
      );

      yield* Effect.addFinalizer(() =>
        Ref.get(current).pipe(
          Effect.flatMap((session) =>
            Option.match(session, {
              onNone: () => Effect.void,
              onSome: (found) => closeQuietly(found.client),
            })
          )
        )
      );

      // Proves the grant at boot without holding boot up.
      yield* open.pipe(Effect.ignore, Effect.forkScoped);

      /** Drops the sign-in-only fields (`oauthState`, the verifier) from the stored grant. */
      const forgetSignIn = Effect.gen(function* () {
        const stored = yield* grant.load;

        if (Option.isSome(stored)) {
          const {
            oauthState: _state,
            codeVerifier: _verifier,
            ...rest
          } = stored.value;

          yield* grant.save(rest);
        }
      });

      const reset = Effect.gen(function* () {
        const session = yield* Ref.get(current);

        if (Option.isSome(session)) {
          yield* lose(session.value);
        }
      });

      const signIn = Effect.gen(function* () {
        // The grant still works: nothing to sign in to, and closing a live session would cut
        // calls in flight.
        const working = yield* open.pipe(Effect.result);

        if (Result.isSuccess(working)) {
          return yield* new ExecutorSignInError({
            message:
              "Executor is already connected with a working grant, so no sign-in is needed.",
            reason: "already_connected",
          });
        }

        if (working.failure.reason !== "sign_in_required") {
          return yield* new ExecutorSignInError({
            message: `Executor sign-in could not start: ${working.failure.message}`,
            reason: "failed",
          });
        }

        yield* reset;

        const registeredFor = yield* grant.clientRedirect.pipe(
          Effect.mapError(signInFailure("failed"))
        );

        const newClient =
          Option.isNone(registeredFor) || registeredFor.value !== redirectUrl;

        const authorizeUrl = yield* Effect.tryPromise({
          try: async () => {
            // A fresh `state` and verifier for each sign-in; a client registered for another
            // redirect (Phase 0's local one) is replaced.
            await provider.invalidateCredentials("verifier");
            await provider.invalidateCredentials("discovery");

            if (newClient) {
              await provider.invalidateCredentials("client");
            }

            const stored = await store.load();

            if (stored !== undefined) {
              const { oauthState: _state, ...rest } = stored;

              await store.save(rest);
            }

            provider.signingIn = true;
            provider.redirect = Option.none();

            try {
              const result = await authorizeMcp(provider, {
                serverUrl,
                resourceMetadataUrl,
                skipRefresh: true,
              });

              return result === "REDIRECT" ? provider.redirect : Option.none();
            } finally {
              provider.signingIn = false;
            }
          },
          catch: signInFailure("failed"),
        });

        if (Option.isNone(authorizeUrl)) {
          return yield* new ExecutorSignInError({
            message:
              "Executor sign-in did not ask for consent, so the grant may work again. Check Executor's status.",
            reason: "already_connected",
          });
        }

        if (newClient) {
          yield* grant
            .setClientRedirect(redirectUrl)
            .pipe(Effect.mapError(signInFailure("failed")));
        }

        const oauthState = yield* grant.load.pipe(
          Effect.mapError(signInFailure("failed")),
          Effect.map((stored) =>
            Option.flatMap(stored, (state) =>
              Option.fromUndefinedOr(state.oauthState)
            )
          )
        );

        if (Option.isNone(oauthState)) {
          return yield* new ExecutorSignInError({
            message:
              "Executor sign-in has no OAuth state to check the callback against. Start it again.",
            reason: "failed",
          });
        }

        yield* grant
          .beginSignIn(oauthState.value)
          .pipe(Effect.mapError(signInFailure("failed")));

        yield* Effect.logInfo("Executor sign-in started").pipe(
          Effect.annotateLogs({ event: "executor_sign_in_started" })
        );

        return authorizeUrl.value.href;
      }).pipe(Effect.withSpan("ExecutorLink.signIn"));

      const callback = Effect.fn("ExecutorLink.callback")(function* (
        query: CallbackQuery
      ) {
        const known = yield* Option.match(query.state, {
          onNone: () => Effect.succeed(false),
          onSome: (state) => grant.takeSignIn(state),
        }).pipe(Effect.mapError(signInFailure("failed")));

        if (!known) {
          return yield* new ExecutorSignInError({
            message:
              "This Executor sign-in is unknown or expired. Start it again from Cairn's settings.",
            reason: "unknown_state",
          });
        }

        if (Option.isSome(query.error) || Option.isNone(query.code)) {
          const description = Option.match(query.errorDescription, {
            onNone: () => "",
            onSome: (text) => ` (${text.slice(0, 300)})`,
          });

          return yield* new ExecutorSignInError({
            message: `Executor did not sign Cairn in: ${Option.getOrElse(query.error, () => "no code")}${description}.`,
            reason: "refused",
          });
        }

        const code = query.code.value;
        const iss = Option.getOrUndefined(query.iss);

        yield* Effect.tryPromise({
          try: async () => {
            provider.signingIn = true;

            try {
              const flow: OAuthFlowOptions = {
                serverUrl,
                resourceMetadataUrl,
                authorizationCode: code,
              };

              if (iss !== undefined) {
                flow.iss = iss;
              }

              await authorizeMcp(provider, flow);
            } finally {
              provider.signingIn = false;
            }
          },
          catch: signInFailure("failed"),
        }).pipe(
          Effect.tapError((error) =>
            setStatus("needs-sign-in", Option.some(error.message))
          )
        );

        yield* forgetSignIn.pipe(Effect.mapError(signInFailure("failed")));
        yield* grant.signedIn.pipe(Effect.ignore);
        yield* reset;

        // The grant is saved; a probe that fails for another reason leaves it, with the error
        // in the status. Only a refused grant means signing in again.
        const probe = yield* open.pipe(Effect.result);

        if (
          Result.isFailure(probe) &&
          probe.failure.reason === "sign_in_required"
        ) {
          return yield* new ExecutorSignInError({
            message: probe.failure.message,
            reason: "refused",
          });
        }

        return yield* Effect.logInfo("Executor signed in").pipe(
          Effect.annotateLogs({ event: "executor_signed_in" })
        );
      });

      return ExecutorLink.of({
        call,
        status: SubscriptionRef.get(status),
        statusChanges: SubscriptionRef.changes(status),
        signIn,
        callback,
      });
    })
  );

  /**
   * A link with no grant: status `disabled`, every call refused before anything is sent. For tests
   * and brains that compose the production extension set but are not about Executor.
   */
  static readonly layerDisabled = Layer.effect(
    ExecutorLink,
    Effect.gen(function* () {
      const detail = "This brain has no Executor link.";

      const status = yield* SubscriptionRef.make<ExecutorStatus>({
        state: "disabled",
        detail: Option.some(detail),
        checkedAt: Option.none(),
      });

      return ExecutorLink.of({
        ...disabledParts(detail),
        status: SubscriptionRef.get(status),
        statusChanges: SubscriptionRef.changes(status),
      });
    })
  );

  /**
   * The deployed link: the grant in `cairn.sqlite`, imported once and held under the lock. Only
   * `main.ts` composes it. Needs `SqlClient`, `ServerConfig` and the Node platform services.
   */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(ExecutorGrant.layer)
  );

  /**
   * A link to a fake Executor on a free loopback port, with a grant in memory: dev and judge
   * brains. Never touches the deployed grant. Needs `ServerConfig`.
   */
  static readonly layerFake = Layer.unwrap(
    Effect.gen(function* () {
      const fake = yield* startFakeExecutor;

      return ExecutorLink.layerNoDeps.pipe(
        Layer.provide(ExecutorGrant.layerMemory(Option.some(fake.issueGrant())))
      );
    })
  );
}
