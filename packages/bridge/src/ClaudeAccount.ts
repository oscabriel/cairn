// What the bridge knows about the Claude Code login, read by the provider's side-effect-free
// `auth.apiKey.check` and `resolve`. Cairn never reads Claude Code's token: the login is whatever the
// `claude` binary has. The usage probe (2F, `ClaudeUsage`) provides the real layer; until then the
// login is unknown, which counts as available, so a missing login surfaces as Claude Code's own error.
import { Context, Effect, Layer } from "effect";

/** The Claude Code login as the bridge last learned it. */
export type ClaudeLogin = "loggedIn" | "loggedOut" | "unknown";

/** Whether turns may run under `login`: refused only on a definite logged-out answer. */
export const loginAllowsTurns = (login: ClaudeLogin): boolean =>
  login !== "loggedOut";

/** The current Claude Code login. */
export class ClaudeAccount extends Context.Service<
  ClaudeAccount,
  {
    /** The login as last learned; never spawns a child. */
    readonly login: Effect.Effect<ClaudeLogin>;
  }
>()("cairn/bridge/ClaudeAccount") {
  /** No probe: the login is unknown, and turns may run. */
  static readonly layer: Layer.Layer<ClaudeAccount> = Layer.succeed(
    ClaudeAccount,
    ClaudeAccount.of({ login: Effect.succeed("unknown") })
  );

  /** A login fixed to `login`, for tests and judges. */
  static readonly fixed = (login: ClaudeLogin): Layer.Layer<ClaudeAccount> =>
    Layer.succeed(
      ClaudeAccount,
      ClaudeAccount.of({ login: Effect.succeed(login) })
    );
}
