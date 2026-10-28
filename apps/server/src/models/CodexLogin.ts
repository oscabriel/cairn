// The Codex sign-in (ADR 0037): pi-ai's own OpenAI Codex OAuth flow, always with its device-code
// method, so the user can finish it from any device (the browser method needs port 1455 on the
// machine the browser runs on). The flow's events become `LoginProgress` steps for the
// `providers.login.start` stream: the code and the page to enter it on, progress, then signed in or
// failed. The credential goes straight into Cairn's own store (`OAuthStore`); no token is ever in a
// step, a log line or an error message, and pi-ai's own error texts (which can quote a provider's
// response) are classified, never forwarded.
//
// One sign-in at a time. It lives as long as its stream: `cancel`, or the stream's subscriber going
// away, aborts the flow, and nothing is stored before the provider's last answer. A brain without
// the OAuth store, or one that does not hold its lock, answers `Failed` with `unavailable`.

import { LoginProgress } from "@cairn/protocol/Models";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  OAuthAuth,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Cause } from "effect";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";

import { CODEX_PROVIDER } from "./CredentialStore.ts";
import { OAuthStore } from "./OAuthStore.ts";

/** pi-ai's id of the device-code method in the Codex flow's method prompt. */
const DEVICE_CODE_METHOD = "device_code";

/** How long pi-ai keeps polling for a device code (`openai-codex.ts`). */
const DEVICE_CODE_SECONDS = 15 * 60;

/** A sign-in is already running; cancel it or wait for it to end. */
export class CodexLoginBusy extends Schema.TaggedError<CodexLoginBusy>()(
  "CodexLoginBusy",
  { message: Schema.String }
) {}

/** Signing out failed: this brain keeps no sign-ins, or the store could not be written. */
export class CodexLogoutError extends Schema.TaggedError<CodexLogoutError>()(
  "CodexLogoutError",
  {
    message: Schema.String,
    reason: Schema.Literals(["unavailable", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

const FailedReason = Schema.Literals([
  "expired",
  "cancelled",
  "refused",
  "unavailable",
]);

/** Why a sign-in ended without one. */
type FailedReason = typeof FailedReason.Type;

/** pi-ai's flow ended without a credential, classified. */
class CodexFlowFailed extends Schema.TaggedError<CodexFlowFailed>()(
  "CodexFlowFailed",
  { reason: FailedReason }
) {}

const FAILED_TEXT: Record<FailedReason, string> = {
  expired:
    "The code expired before it was entered. Nothing was stored; start the sign-in again.",
  cancelled: "The sign-in was cancelled. Nothing was stored.",
  refused:
    "OpenAI refused the sign-in. Nothing was stored; start again, and check the ChatGPT account has Codex.",
  unavailable:
    "OpenAI's sign-in could not be reached. Nothing was stored; check the network, then start again.",
};

// The steps by tag. Values from pi-ai's events are vendor data, so each step is built with
// `makeOption`: one that does not fit the protocol (an http URL, an empty code) is dropped.
const Steps = LoginProgress.pipe(Schema.toTaggedUnion("_tag"));

const failed = (reason: FailedReason, message = FAILED_TEXT[reason]) =>
  Steps.cases.Failed.makeOption({ reason, message });

/** Offers a sign-in's last step, if any, then ends its stream. */
const endWith = (
  queue: Queue.Enqueue<LoginProgress, Cause.Done>,
  last: Option.Option<LoginProgress>
) =>
  Effect.gen(function* () {
    for (const step of Option.toArray(last)) {
      Queue.offerUnsafe(queue, step);
    }

    yield* Queue.end(queue);
  });

/** A sign-in that cannot start here: one `Failed` step. */
const unavailable = (message: string) =>
  Stream.fromIterable(
    Option.toArray(failed("unavailable", message.slice(0, 4096)))
  );

/** The step a pi-ai auth event becomes, if it is one the user needs. */
const progressOf = (event: AuthEvent): Option.Option<LoginProgress> => {
  if (event.type === "device_code") {
    return Steps.cases.DeviceCode.makeOption({
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      expiresInSeconds: event.expiresInSeconds ?? DEVICE_CODE_SECONDS,
    });
  }

  if (event.type === "auth_url") {
    return Steps.cases.AuthUrl.makeOption({ url: event.url });
  }

  return Steps.cases.Progress.makeOption({
    message: event.message.slice(0, 4096),
  });
};

/**
 * pi-ai's error, classified by its fixed wording. Only the class leaves this function: the texts
 * can carry a provider's response body.
 */
const reasonOf = (cause: unknown): FailedReason => {
  const text =
    Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
      ? cause.message
      : "";

  if (text.startsWith("Device flow timed out")) {
    return "expired";
  }

  if (text === "Login cancelled") {
    return "cancelled";
  }

  if (
    /failed with status|failed \(\d+\)|not enabled|Invalid|missing fields|accountId|State mismatch|device code only/u.test(
      text
    )
  ) {
    return "refused";
  }

  return "unavailable";
};

const JwtProfile = Schema.fromJsonString(
  Schema.Struct({
    "https://api.openai.com/profile": Schema.optional(
      Schema.Struct({ email: Schema.optional(Schema.String) })
    ),
  })
);

const decodeJwtProfile = Schema.decodeOption(JwtProfile);

/**
 * The account a Codex access token belongs to, as the settings card shows it: the email claim of
 * the token's payload, read without verifying it (it is display text, never trusted).
 */
export const accountOf = (access: string): Option.Option<string> =>
  Option.flatMap(Option.fromUndefinedOr(access.split(".")[1]), (payload) =>
    Option.flatMap(
      decodeJwtProfile(Buffer.from(payload, "base64url").toString("utf-8")),
      (claims) =>
        Option.fromUndefinedOr(
          claims["https://api.openai.com/profile"]?.email?.slice(0, 4096)
        )
    )
  );

/** The device-code answer to the flow's method prompt; any other prompt is refused. */
const answerPrompt = async (prompt: AuthPrompt): Promise<string> =>
  prompt.type === "select" &&
  prompt.options.some((option) => option.id === DEVICE_CODE_METHOD)
    ? await Promise.resolve(DEVICE_CODE_METHOD)
    : await Promise.reject(
        new Error("Cairn signs in to Codex with a device code only")
      );

/** Signs Cairn in to Codex and out again. */
export class CodexLogin extends Context.Service<
  CodexLogin,
  {
    /**
     * Runs one sign-in: the device code, progress, then `SignedIn` (stored) or `Failed`, then the
     * stream ends. Fails with `CodexLoginBusy` while another sign-in runs. Ending the stream early
     * cancels the sign-in.
     */
    readonly start: Stream.Stream<LoginProgress, CodexLoginBusy>;
    /** Cancels the running sign-in, if any. True when one was running. */
    readonly cancel: Effect.Effect<boolean>;
    /** Removes the stored sign-in. True when there was one. */
    readonly logout: Effect.Effect<boolean, CodexLogoutError>;
  }
>()("cairn/server/models/CodexLogin") {
  /**
   * The sign-in over `OAuthStore` when the brain provides one (the deployed brain), with pi-ai's
   * Codex flow. Without the store, every sign-in fails with `unavailable`.
   */
  static readonly layer = Layer.effect(
    CodexLogin,
    Effect.gen(function* () {
      const store = yield* Effect.serviceOption(OAuthStore);
      // Whether a sign-in holds the one slot, and its fiber once it runs (`cancel` interrupts it).
      const busy = yield* Ref.make(false);
      const running = yield* Ref.make(Option.none<Fiber.Fiber<void>>());

      // pi-ai's Codex provider always has OAuth auth; an Option keeps a future change visible.
      const oauth: Option.Option<OAuthAuth> = Option.fromUndefinedOr(
        openaiCodexProvider().auth.oauth
      );

      const run = (
        holder: OAuthStore["Service"],
        flow: OAuthAuth
      ): Stream.Stream<LoginProgress, CodexLoginBusy> =>
        Stream.callback<LoginProgress, CodexLoginBusy>((queue) =>
          Effect.gen(function* () {
            const claimed = yield* Ref.modify(busy, (taken) =>
              taken ? [false, taken] : [true, true]
            );

            if (!claimed) {
              return yield* new CodexLoginBusy({
                message:
                  "A Codex sign-in is already running. Cancel it, or finish it, then start again.",
              });
            }

            yield* Effect.addFinalizer(() =>
              Effect.andThen(
                Ref.set(running, Option.none()),
                Ref.set(busy, false)
              )
            );

            // pi-ai's flow, aborted through its signal when the fiber is interrupted (cancel, or
            // the subscriber going away). Nothing is stored before its last answer.
            const login = Effect.tryPromise({
              try: async (signal) => {
                const interaction: AuthInteraction = {
                  signal,
                  prompt: answerPrompt,
                  notify: (event) => {
                    for (const step of Option.toArray(progressOf(event))) {
                      Queue.offerUnsafe(queue, step);
                    }
                  },
                };

                return await flow.login({ ...interaction, signal });
              },
              catch: (cause) =>
                new CodexFlowFailed({ reason: reasonOf(cause) }),
            }).pipe(
              Effect.flatMap((credential) =>
                holder.signIn(CODEX_PROVIDER, credential).pipe(
                  Effect.as(
                    Steps.cases.SignedIn.makeOption({
                      account: accountOf(credential.access),
                    })
                  ),
                  Effect.catchTag("OAuthStoreError", (failure) =>
                    Effect.succeed(
                      failed(
                        "unavailable",
                        `The sign-in succeeded but could not be stored (${failure.reason}). Start it again.`
                      )
                    )
                  )
                )
              ),
              Effect.catchTag("CodexFlowFailed", ({ reason }) =>
                Effect.logWarning("codex sign-in failed").pipe(
                  Effect.annotateLogs({ event: "codex_login_failed", reason }),
                  Effect.as(failed(reason))
                )
              ),
              Effect.flatMap((last) => endWith(queue, last)),
              Effect.onInterrupt(() => endWith(queue, failed("cancelled")))
            );

            const fiber = yield* Effect.forkScoped(login);

            return yield* Ref.set(running, Option.some(fiber));
          })
        );

      const start = Stream.unwrap(
        Effect.sync(() => {
          if (Option.isNone(store) || Option.isNone(oauth)) {
            return unavailable(
              "This brain keeps no Codex sign-in. Sign in on the deployed brain."
            );
          }

          if (!store.value.held) {
            return unavailable(
              "Another Cairn brain holds the OAuth lock, so this one cannot sign in. Sign in on that brain."
            );
          }

          return run(store.value, oauth.value);
        })
      );

      const cancel = Effect.gen(function* () {
        const current = yield* Ref.get(running);

        for (const fiber of Option.toArray(current)) {
          yield* Fiber.interrupt(fiber);
        }

        return Option.isSome(current);
      }).pipe(Effect.withSpan("CodexLogin.cancel"));

      const logout = Effect.gen(function* () {
        if (Option.isNone(store)) {
          return yield* new CodexLogoutError({
            message:
              "This brain keeps no Codex sign-in. Sign out on the deployed brain.",
            reason: "unavailable",
          });
        }

        return yield* store.value.remove(CODEX_PROVIDER).pipe(
          Effect.mapError(
            (failure) =>
              new CodexLogoutError({
                message: failure.message,
                reason:
                  failure.reason === "not_holder" ? "unavailable" : "storage",
                cause: failure,
              })
          )
        );
      }).pipe(Effect.withSpan("CodexLogin.logout"));

      return CodexLogin.of({ start, cancel, logout });
    })
  );
}
