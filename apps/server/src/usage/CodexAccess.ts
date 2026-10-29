// The Codex login as the usage reader needs it: the current access token and the ChatGPT account it
// belongs to, or nothing while no login is held. Cairn owns the token (ADR 0009, ADR 0037), so the
// holder of the login refreshes it; this reader never does. The default is signed out, so a brain
// that composes no Codex login reads no Codex windows and sends nothing to chatgpt.com.

import { Context, Effect, Redacted, Schema } from "effect";
import type { Option } from "effect";

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

/** How the usage reader reaches the Codex login. */
export interface CodexAccessService {
  /** The current credential, refreshed by its holder; none while no login is held. */
  readonly credential: Effect.Effect<Option.Option<CodexCredential>>;
}

const SIGNED_OUT: CodexAccessService = {
  credential: Effect.succeedNone,
};

/**
 * The Codex login for usage reads. A reference whose default is signed out; the brain that holds the
 * Codex login provides a layer over its credential store.
 */
export class CodexAccess extends Context.Reference<CodexAccessService>(
  "cairn/server/usage/CodexAccess",
  { defaultValue: () => SIGNED_OUT }
) {}
