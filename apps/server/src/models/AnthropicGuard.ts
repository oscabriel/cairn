// Refuses pi-ai's built-in Anthropic OAuth (ADR 0002). Claude reaches Cairn only through the
// `claude-bridge` provider, which runs the user's own `claude` binary; pi-ai's `anthropic` provider
// would otherwise send a subscription token with Claude Code's identity headers. Four layers, each
// failing closed:
//
// 1. Credentials: `CairnCredentialStore` hides the `anthropic` entry and any `sk-ant-oat` value.
// 2. Environment: the brain strips the variables pi-ai's Anthropic auth reads from its own
//    `process.env` at boot, and the replacement provider resolves auth through a context that never
//    returns them.
// 3. Provider: the `anthropic` provider registered in the runtime is a replacement built from
//    `anthropicProvider()` with `auth.oauth` removed, a resolver that accepts only a metered
//    `sk-ant-api` key, and streams that refuse an OAuth token or a Bearer header before any request.
// 4. Picker: `isRefusedProvider` keeps every `anthropic` model out of the listing.
//
// This is the only module that imports `@earendil-works/pi-ai/providers/anthropic` (lint enforced).

import type {
  ApiKeyAuth,
  AssistantMessageEventStream,
  AuthContext,
  Model,
  Provider,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Effect, Option, Predicate } from "effect";

/** pi-ai's built-in Anthropic provider id. */
export const ANTHROPIC_PROVIDER = "anthropic";

/** Providers Cairn never offers, whatever their credentials say. */
export const REFUSED_PROVIDERS: ReadonlySet<string> = new Set([
  ANTHROPIC_PROVIDER,
]);

/** True for a provider Cairn never offers (pi-ai's own `anthropic`). */
export const isRefusedProvider = (provider: string): boolean =>
  REFUSED_PROVIDERS.has(provider);

/** Why a refused provider's model is not offered, for a person or a model to read. */
export const refusedProviderMessage = (provider: string): string =>
  `The ${provider} provider is refused here: Claude runs only through the claude-bridge provider, never pi-ai's built-in Anthropic login.`;

/**
 * The variables pi-ai's Anthropic auth reads (its `env-api-keys`), plus Claude Code's own OAuth
 * token. The brain never holds them: they are stripped at boot and hidden from auth resolution.
 */
export const ANTHROPIC_AUTH_ENV: ReadonlyArray<string> = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_WORKSPACE_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

const refusedEnv: ReadonlySet<string> = new Set(ANTHROPIC_AUTH_ENV);

/** True when a key is an Anthropic subscription (OAuth) token; pi-ai spoofs Claude Code for these. */
export const isOAuthToken = (value: string): boolean =>
  value.includes("sk-ant-oat");

/** True for a metered Anthropic Console key, the only Anthropic key the guard would accept. */
export const isMeteredAnthropicKey = (value: string): boolean =>
  value.startsWith("sk-ant-api") && !isOAuthToken(value);

/** `ctx` with every Anthropic auth variable reading as unset. */
export const guardedAuthContext = (ctx: AuthContext): AuthContext => ({
  env: async (name) => {
    const value = refusedEnv.has(name)
      ? Option.none<string>()
      : Option.fromNullishOr(await ctx.env(name));

    return Option.getOrUndefined(value);
  },
  fileExists: async (path) => await ctx.fileExists(path),
});

/**
 * Removes the Anthropic auth variables from `env` (the brain's `process.env` at boot) and returns
 * the names it removed, never their values.
 */
export const stripAnthropicEnvironment = (env: NodeJS.ProcessEnv) =>
  Effect.sync(() => {
    const removed = ANTHROPIC_AUTH_ENV.filter((name) => name in env);

    for (const name of removed) {
      Reflect.deleteProperty(env, name);
    }

    return removed;
  });

/** The fixed text of a refused request: what pi-ai reports as the stream's error. */
export const REFUSED_REQUEST_TEXT =
  "AnthropicGuard refused the request: pi-ai's anthropic provider may not send a Claude subscription token or a Bearer header. Use the claude-bridge provider for Claude.";

const isBearer = (value: string | null): boolean =>
  Predicate.isString(value) && /^\s*bearer\s/iu.test(value);

/** True when a request carries a subscription token or a Bearer header and must not leave. */
const mustRefuse = (options: StreamOptions | undefined): boolean => {
  if (options === undefined) {
    return false;
  }

  if (Predicate.isString(options.apiKey) && isOAuthToken(options.apiKey)) {
    return true;
  }

  return Object.entries(options.headers ?? {}).some(
    ([name, value]) => name.toLowerCase() === "authorization" && isBearer(value)
  );
};

/** A stream that ends at once with the refusal as its error event; nothing is sent. */
const refusedStream = <TApi extends string>(
  model: Model<TApi>
): AssistantMessageEventStream =>
  lazyStream(
    model,
    async () => await Promise.reject(new Error(REFUSED_REQUEST_TEXT))
  );

/** The built-in API-key resolver, behind the guarded context and with only metered keys. */
const guardedApiKey = (base: ApiKeyAuth): ApiKeyAuth => ({
  name: "Anthropic API key (metered sk-ant-api keys only)",
  resolve: async ({ ctx, credential, signal }) => {
    const guarded = guardedAuthContext(ctx);

    const metered =
      credential !== undefined &&
      Predicate.isString(credential.key) &&
      isMeteredAnthropicKey(credential.key);

    return metered
      ? await base.resolve({ ctx: guarded, credential, signal })
      : await base.resolve({ ctx: guarded, signal });
  },
});

/** The keys a guarded provider carries; a pi-ai bump that adds one must be checked here. */
export const GUARDED_PROVIDER_KEYS: ReadonlyArray<string> = [
  "id",
  "name",
  "baseUrl",
  "headers",
  "auth",
  "getModels",
  "getAllModels",
  "refreshModels",
  "filterModels",
  "filterAllModels",
  "stream",
  "streamSimple",
];

/**
 * pi-ai's `anthropic` provider with its OAuth login removed, its key resolver guarded and its
 * streams refusing a subscription token or a Bearer header. Registering it under the same id
 * replaces the built-in one in the model runtime.
 */
export const guardedAnthropicProvider = (): Provider<"anthropic-messages"> => {
  const base = anthropicProvider();
  const { apiKey } = base.auth;

  return {
    ...base,
    // With no API-key auth at all the provider is unconfigured, which also fails closed.
    auth: apiKey === undefined ? {} : { apiKey: guardedApiKey(apiKey) },
    stream: (model, context, options) =>
      mustRefuse(options)
        ? refusedStream(model)
        : base.stream(model, context, options),
    streamSimple: (model, context, options) =>
      mustRefuse(options)
        ? refusedStream(model)
        : base.streamSimple(model, context, options),
  };
};
