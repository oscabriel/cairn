// Ported in part from cairn-v1, apps/server/src/providers.ts at 1a5cd4a (the refused providers);
// the store itself is new (plan D11, ADR 0009). Changed: pi's `auth.json` is read, never written or
// locked, and only literal API keys pass.
//
// The brain's credentials, read from pi's own `~/.pi/agent/auth.json` so a key the user added in pi
// works in Cairn too. Read-only: the file is read on each call (never locked, never created) and
// `modify` and `delete` refuse, so nothing Cairn does can change it. Only API keys pass:
//
// - every OAuth credential is ignored (Cairn keeps its own OAuth store, ADR 0009, from Phase 2),
// - `anthropic` is hidden whatever it holds (ADR 0002: Claude runs only through the bridge),
// - `openai-codex` is never read from pi's file (its login is Cairn's own, Phase 2),
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
} from "@earendil-works/pi-ai";
import { Option, Schema } from "effect";

import { ANTHROPIC_PROVIDER, isOAuthToken } from "./AnthropicGuard.ts";

/** pi-ai's Codex provider id; its OAuth login is Cairn's own from Phase 2. */
export const CODEX_PROVIDER = "openai-codex";

/** Providers whose entry in pi's file is never read. */
export const HIDDEN_PROVIDERS: ReadonlySet<string> = new Set([
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
]);

/** Why an entry in pi's file is not offered to the model runtime. */
export type CredentialRefusal =
  | "hidden_provider"
  | "oauth"
  | "not_literal"
  | "subscription_token"
  | "malformed";

/** One entry of pi's file as Cairn sees it: id, type and verdict, never the value. */
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
 * pi-ai's `CredentialStore` over pi's `auth.json`, read-only, offering only literal API keys of
 * providers Cairn allows. A missing file reads as empty; an unreadable one rejects, which pi-ai
 * reports as an auth failure.
 */
export class CairnCredentialStore implements CredentialStore {
  /** The `auth.json` this store reads. */
  readonly authPath: string;

  constructor(authPath: string) {
    this.authPath = authPath;
  }

  /** Every entry's verdict: provider id, type and why it is not offered. Never a value. */
  async entries(): Promise<ReadonlyArray<CredentialEntry>> {
    const verdicts = await this.verdicts();

    return verdicts.map((verdict) => verdict.entry);
  }

  /** The offered API key of `providerId`, if there is one. */
  async read(providerId: string): Promise<Credential | undefined> {
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

    return verdicts
      .filter((verdict) => Option.isSome(verdict.credential))
      .map((verdict): CredentialInfo => ({
        providerId: verdict.entry.provider,
        type: "api_key",
      }));
  }

  /** Refuses: Cairn never writes pi's file. */
  async modify(): Promise<Credential | undefined> {
    return await Promise.reject(new Error(this.readOnlyText()));
  }

  /** Refuses: Cairn never writes pi's file. */
  async delete(): Promise<void> {
    await Promise.reject(new Error(this.readOnlyText()));
  }

  private readOnlyText(): string {
    return `CairnCredentialStore is read-only: Cairn never writes ${this.authPath}. Add or change the key in pi (/login), then reload the brain's models.`;
  }

  private async verdicts(): Promise<ReadonlyArray<CredentialVerdict>> {
    // A missing file is no credentials; any other read failure rejects (pi-ai reports it).
    if (!existsSync(this.authPath)) {
      return [];
    }

    return judgeAuthFile(await readFile(this.authPath, "utf-8"));
  }
}
