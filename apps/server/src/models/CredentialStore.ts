// Ported in part from cairn-v1, apps/server/src/providers.ts at 1a5cd4a (the refused providers);
// the store itself is new (plan D11, ADR 0009). Changed: pi's `auth.json` is read, never written or
// locked, and only literal API keys pass; Cairn's own OAuth sign-ins come from its own store.
//
// The brain's credentials. API keys are read from pi's own `~/.pi/agent/auth.json` so a key the user
// added in pi works in Cairn too. That file is read-only: it is read on each call (never locked,
// never created), and `modify` and `delete` refuse for every provider it serves, so nothing Cairn
// does can change it. Only API keys pass from it:
//
// - every OAuth credential is ignored (Cairn keeps its own OAuth sign-ins, ADR 0009 and 0037),
// - `anthropic` is hidden whatever it holds (ADR 0002: Claude runs only through the bridge),
// - `openai-codex` is never read from pi's file: its sign-in is Cairn's own, served by an
//   `OAuthCredentialSource` (`OAuthStore.ts`, in `cairn.sqlite`), which is also where pi-ai's
//   refresh writes the rotated token,
// - a key that is not a literal (pi's `!command` or `$VAR` templates) is ignored, because
//   resolving it would run a command or read the environment,
// - any value carrying an Anthropic subscription token (`sk-ant-oat`) is ignored, for every provider.
//
// What was ignored and why is reported by provider id and type only, never by value.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { Option, Schema } from "effect";

import { ANTHROPIC_PROVIDER, isOAuthToken } from "./AnthropicGuard.ts";

/** pi-ai's Codex provider id; its OAuth sign-in is Cairn's own (ADR 0037). */
export const CODEX_PROVIDER = "openai-codex";

/** Providers whose OAuth sign-in Cairn keeps itself; their entries in pi's file are never read. */
export const OAUTH_PROVIDERS: ReadonlySet<string> = new Set([CODEX_PROVIDER]);

/**
 * Cairn's own OAuth sign-ins as pi-ai's credential store methods (`OAuthStore.source`). `held` is
 * false when another process holds the OAuth lock; `read` then answers nothing and writes reject.
 */
export interface OAuthCredentialSource {
  /** The providers it serves. */
  readonly providers: ReadonlySet<string>;
  readonly held: boolean;
  read(providerId: string): Promise<OAuthCredential | undefined>;
  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}

/** Providers whose entry in pi's file is never read. */
export const HIDDEN_PROVIDERS: ReadonlySet<string> = new Set([
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
]);

/**
 * Why a credential is not offered to the model runtime: the first five for entries in pi's file,
 * `signed_out` and `not_holder` for Cairn's own OAuth sign-ins.
 */
export type CredentialRefusal =
  | "hidden_provider"
  | "signed_out"
  | "not_holder"
  | "oauth"
  | "not_literal"
  | "subscription_token"
  | "malformed";

/**
 * One credential as Cairn sees it, from pi's file or Cairn's own OAuth store: id, type and verdict,
 * never the value.
 */
export interface CredentialEntry {
  readonly provider: string;
  /** The stored type, or `unknown` when the entry is not one pi-ai knows. */
  readonly type: "api_key" | "oauth" | "unknown";
  /** None when the entry is offered; the reason otherwise. */
  readonly refusal: Option.Option<CredentialRefusal>;
}

/** An entry's verdict and, when it is offered, the credential the runtime gets. */
export interface CredentialVerdict {
  readonly entry: CredentialEntry;
  readonly credential: Option.Option<ApiKeyCredential>;
}

const ApiKeyEntry = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.String,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

type ApiKeyEntry = typeof ApiKeyEntry.Type;

const OAuthEntry = Schema.Struct({ type: Schema.Literal("oauth") });

const decodeAuthFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

/** An entry of pi's file, as far as Cairn needs to tell entries apart. */
const decodeAuthEntry = Schema.decodeUnknownOption(
  Schema.Union([ApiKeyEntry, OAuthEntry])
);

/** True when pi would use the value as written: no `!command`, no `$VAR` template. */
export const isLiteralValue = (value: string): boolean =>
  !value.startsWith("!") && !value.includes("$");

const refused = (
  provider: string,
  type: CredentialEntry["type"],
  refusal: CredentialRefusal
): CredentialVerdict => ({
  entry: { provider, type, refusal: Option.some(refusal) },
  credential: Option.none(),
});

/** The verdict on one API-key entry. */
const judgeApiKey = (
  provider: string,
  entry: ApiKeyEntry
): CredentialVerdict => {
  if (HIDDEN_PROVIDERS.has(provider)) {
    return refused(provider, "api_key", "hidden_provider");
  }

  const envValues = Object.values(entry.env ?? {});

  if (isOAuthToken(entry.key) || envValues.some(isOAuthToken)) {
    return refused(provider, "api_key", "subscription_token");
  }

  if (!isLiteralValue(entry.key) || !envValues.every(isLiteralValue)) {
    return refused(provider, "api_key", "not_literal");
  }

  const credential: ApiKeyCredential =
    entry.env === undefined
      ? { type: "api_key", key: entry.key }
      : { type: "api_key", key: entry.key, env: { ...entry.env } };

  return {
    entry: { provider, type: "api_key", refusal: Option.none() },
    credential: Option.some(credential),
  };
};

/**
 * Every entry's verdict, from the file's text. A file that is not a JSON object of entries has
 * none, so the runtime sees no credentials.
 */
export const judgeAuthFile = (text: string): ReadonlyArray<CredentialVerdict> =>
  Option.match(decodeAuthFile(text), {
    onNone: () => [],
    onSome: (entries) =>
      Object.entries(entries).map(([provider, raw]) => {
        const decoded = decodeAuthEntry(raw);

        if (Option.isNone(decoded)) {
          return refused(provider, "unknown", "malformed");
        }

        const entry = decoded.value;

        if (entry.type === "oauth") {
          return refused(
            provider,
            "oauth",
            HIDDEN_PROVIDERS.has(provider) ? "hidden_provider" : "oauth"
          );
        }

        return judgeApiKey(provider, entry);
      }),
  });

/**
 * pi-ai's `CredentialStore`: pi's `auth.json`, read-only, offering only literal API keys of
 * providers Cairn allows, and Cairn's own OAuth sign-ins for `OAUTH_PROVIDERS` when `oauth` is
 * given. A missing file reads as empty; an unreadable one rejects, which pi-ai reports as an auth
 * failure. Without `oauth` (a judge or dev brain), the OAuth providers are not offered.
 */
export class CairnCredentialStore implements CredentialStore {
  /** The `auth.json` this store reads. */
  readonly authPath: string;

  /** Cairn's own OAuth sign-ins, when this brain keeps them. */
  readonly oauth: Option.Option<OAuthCredentialSource>;

  constructor(
    authPath: string,
    oauth: Option.Option<OAuthCredentialSource> = Option.none()
  ) {
    this.authPath = authPath;
    this.oauth = oauth;
  }

  /**
   * Every entry's verdict: provider id, type and why it is not offered. pi's file's entries
   * (without the OAuth providers, which it never serves), then one entry per OAuth provider from
   * Cairn's own store. Never a value.
   */
  async entries(): Promise<ReadonlyArray<CredentialEntry>> {
    const verdicts = await this.verdicts();

    const fromFile = verdicts
      .map((verdict) => verdict.entry)
      .filter((entry) => !OAUTH_PROVIDERS.has(entry.provider));

    const own = await Promise.all(
      [...OAUTH_PROVIDERS].map(async (provider): Promise<CredentialEntry> => ({
        provider,
        type: "oauth",
        refusal: await this.oauthRefusal(provider),
      }))
    );

    return [...fromFile, ...own];
  }

  /** The offered credential of `providerId`, if there is one. */
  async read(providerId: string): Promise<Credential | undefined> {
    if (OAUTH_PROVIDERS.has(providerId)) {
      return Option.isSome(this.oauth)
        ? await this.oauth.value.read(providerId)
        : undefined;
    }

    const verdicts = await this.verdicts();

    return Option.getOrUndefined(
      Option.flatMap(
        Option.fromNullishOr(
          verdicts.find((verdict) => verdict.entry.provider === providerId)
        ),
        (verdict) => verdict.credential
      )
    );
  }

  /** The offered entries' ids and types. */
  async list(): Promise<ReadonlyArray<CredentialInfo>> {
    const verdicts = await this.verdicts();

    const keys = verdicts
      .filter((verdict) => Option.isSome(verdict.credential))
      .map((verdict): CredentialInfo => ({
        providerId: verdict.entry.provider,
        type: "api_key",
      }));

    const own = await Promise.all(
      [...OAUTH_PROVIDERS].map(async (provider) => ({
        provider,
        signedIn: (await this.read(provider)) !== undefined,
      }))
    );

    return [
      ...keys,
      ...own
        .filter((found) => found.signedIn)
        .map((found): CredentialInfo => ({
          providerId: found.provider,
          type: "oauth",
        })),
    ];
  }

  /**
   * Updates an OAuth provider's sign-in in Cairn's own store: pi-ai's refresh writes the rotated
   * token here before it releases the store. Refuses for every other provider: Cairn never writes
   * pi's file.
   */
  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    if (OAUTH_PROVIDERS.has(providerId) && Option.isSome(this.oauth)) {
      return await this.oauth.value.modify(providerId, update);
    }

    return await Promise.reject(new Error(this.readOnlyText(providerId)));
  }

  /** Signs an OAuth provider out of Cairn's own store; refuses for every other provider. */
  async delete(providerId: string): Promise<void> {
    if (OAUTH_PROVIDERS.has(providerId) && Option.isSome(this.oauth)) {
      await this.oauth.value.delete(providerId);

      return;
    }

    await Promise.reject(new Error(this.readOnlyText(providerId)));
  }

  private readOnlyText(providerId: string): string {
    return OAUTH_PROVIDERS.has(providerId)
      ? `CairnCredentialStore keeps no ${providerId} sign-in on this brain; only the brain that holds Cairn's OAuth lock does. Sign in from that brain's Settings.`
      : `CairnCredentialStore is read-only: Cairn never writes ${this.authPath}. Add or change the key in pi (/login), then reload the brain's models.`;
  }

  /** Why an OAuth provider is not offered: none when it is signed in on this brain. */
  private async oauthRefusal(
    provider: string
  ): Promise<Option.Option<CredentialRefusal>> {
    if (Option.isNone(this.oauth) || !this.oauth.value.held) {
      return Option.some("not_holder");
    }

    const credential = await this.oauth.value.read(provider);

    return credential === undefined ? Option.some("signed_out") : Option.none();
  }

  private async verdicts(): Promise<ReadonlyArray<CredentialVerdict>> {
    // A missing file is no credentials; any other read failure rejects (pi-ai reports it).
    if (!existsSync(this.authPath)) {
      return [];
    }

    return judgeAuthFile(await readFile(this.authPath, "utf-8"));
  }
}
