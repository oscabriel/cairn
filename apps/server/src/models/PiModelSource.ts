// Ported in part from cairn-v1, apps/server/src/Models.ts at 1a5cd4a (the listing, pi's defaults
// against what is available, and thinking clamps). Changed: the runtime is created read-only over
// pi's `~/.pi/agent` (Cairn's credential store, no models.json, an in-memory catalog store), pi-ai's
// `anthropic` provider is replaced by the guarded one, providers arrive through `ExtraProviders`,
// listings carry availability, image input and the context window, and provider status is reported.
//
// The brain's models: pi's own model runtime (`ModelRuntime` from pi-coding-agent) over the API
// keys in pi's `auth.json`, so a key added in pi works in Cairn too. Strictly read-only towards
// `~/.pi/agent`: credentials come from `CairnCredentialStore` (never `authPath`, which locks and
// creates `auth.json`), `modelsPath` is null (no `models.json`, no `models-store.json`), and remote
// catalogs refresh into pi-ai's in-memory store (plan D11). Claude arrives as the `claude-bridge`
// provider through `ExtraProviders`; pi-ai's own `anthropic` provider is replaced by the guarded one
// and never listed (ADR 0002). pi-coding-agent is imported lazily, when the layer is built.
import path from "node:path";

import type {
  ModelCatalog,
  ModelDefaults,
  ModelListing,
  ModelRef,
  ProviderStatus,
  ThinkingLevel,
} from "@cairn/protocol/Models";
import type {
  Api,
  AssistantMessage,
  Context as ModelContext,
  Model,
  Models,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { errorText } from "../brain/Durable.ts";
import { ModelCallError, ModelSource } from "../brain/ModelSource.ts";
import {
  ANTHROPIC_PROVIDER,
  guardedAnthropicProvider,
  isRefusedProvider,
  refusedProviderMessage,
  stripAnthropicEnvironment,
} from "./AnthropicGuard.ts";
import type { CredentialEntry, CredentialRefusal } from "./CredentialStore.ts";
import { CairnCredentialStore, CODEX_PROVIDER } from "./CredentialStore.ts";
import { BRIDGE_PROVIDER, HarnessSettings } from "./HarnessSettings.ts";
import type { PiDefaults } from "./PiConfig.ts";
import { PiConfig } from "./PiConfig.ts";

/** The model runtime could not be built or answered. */
export class ModelRuntimeError extends Schema.TaggedError<ModelRuntimeError>()(
  "ModelRuntimeError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "PiModelSource.create",
      "PiModelSource.catalog",
      "PiModelSource.providers",
    ]),
    cause: Schema.Defect(),
  }
) {}

/**
 * Providers registered on top of pi's built-ins, with `registerNativeProvider`. Empty by default;
 * the Claude bridge arrives through it.
 */
export class ExtraProviders extends Context.Reference<ReadonlyArray<Provider>>(
  "cairn/server/models/PiModelSource/ExtraProviders",
  { defaultValue: () => [] }
) {}

/** pi's default thinking level when settings.json sets none (pi-coding-agent's `DEFAULT_THINKING_LEVEL`). */
export const PI_DEFAULT_THINKING: ThinkingLevel = "medium";

/** What a new thread starts on when no model at all is available and pi names none. */
export const NO_MODEL_DEFAULTS: ModelDefaults = {
  model: { provider: BRIDGE_PROVIDER, modelId: "claude-opus-5-5" },
  thinkingLevel: PI_DEFAULT_THINKING,
};

/** How long `ModelRuntime.create` may spend refreshing remote catalogs before it uses what it has. */
const MODEL_REFRESH_TIMEOUT_MS = 3000;

/** The listing options a request decides. */
export interface CatalogOptions {
  /** False hides every `claude-bridge` model (the server setting). */
  readonly bridgeEnabled: boolean;
}

/** The levels a model takes, `off` first; empty for a model without reasoning. */
export const thinkingLevelsOf = (
  model: Model<Api>
): ReadonlyArray<ThinkingLevel> =>
  model.reasoning ? getSupportedThinkingLevels(model) : [];

/** One model as the picker shows it. */
export const listingOf = (
  model: Model<Api>,
  available: boolean
): ModelListing => ({
  provider: model.provider,
  modelId: model.id,
  name: model.name.slice(0, 4096),
  thinkingLevels: thinkingLevelsOf(model),
  acceptsImages: model.input.includes("image"),
  contextWindow:
    Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0
      ? Option.some(model.contextWindow)
      : Option.none(),
  available,
});

const modelKey = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/**
 * The picker's models: every available chat model, plus every model of the extra providers
 * (available or not, so a signed-out bridge shows disabled), less refused providers and, when the
 * bridge is off, the bridge's models.
 */
export const listing = (
  input: {
    readonly available: ReadonlyArray<Model<Api>>;
    readonly extra: ReadonlyArray<Model<Api>>;
  },
  options: CatalogOptions
): ReadonlyArray<ModelListing> => {
  const availableKeys = new Set(input.available.map(modelKey));
  const seen = new Set<string>();
  const out: Array<ModelListing> = [];

  for (const model of [...input.available, ...input.extra]) {
    const id = modelKey(model);

    const hidden =
      isRefusedProvider(model.provider) ||
      (!options.bridgeEnabled && model.provider === BRIDGE_PROVIDER);

    if (!seen.has(id) && !hidden) {
      seen.add(id);
      out.push(listingOf(model, availableKeys.has(id)));
    }
  }

  return out;
};

/** `wanted` held to the levels `model` takes (pi-ai's `clampThinkingLevel`). */
export const clampThinking = (
  model: Model<Api>,
  wanted: ThinkingLevel
): ThinkingLevel => clampThinkingLevel(model, wanted);

/**
 * pi's defaults against the listing: pi's model when it is listed and available, else the first
 * available model, else pi's model as written (or `NO_MODEL_DEFAULTS`); pi's level (default
 * `medium`) held to the chosen model.
 */
export const defaultsOf = (
  listed: ReadonlyArray<ModelListing>,
  pi: PiDefaults,
  lookup: (ref: ModelRef) => Option.Option<Model<Api>>
): ModelDefaults => {
  const wanted = Option.getOrElse(pi.thinkingLevel, () => PI_DEFAULT_THINKING);
  const usable = listed.filter((model) => model.available);
  const piModel = Option.all({ provider: pi.provider, modelId: pi.model });

  const chosen = Option.orElse(
    Option.flatMap(piModel, (ref) =>
      Option.fromNullishOr(
        usable.find(
          (model) =>
            model.provider === ref.provider && model.modelId === ref.modelId
        )
      )
    ),
    () => Option.fromNullishOr(usable[0])
  ).pipe(
    Option.map((model): ModelRef => ({
      provider: model.provider,
      modelId: model.modelId,
    }))
  );

  return Option.match(chosen, {
    onNone: () => ({
      model: Option.getOrElse(piModel, () => NO_MODEL_DEFAULTS.model),
      thinkingLevel: wanted,
    }),
    onSome: (model) => ({
      model,
      thinkingLevel: Option.match(lookup(model), {
        onNone: () => wanted,
        onSome: (found) => clampThinking(found, wanted),
      }),
    }),
  });
};

const providerName = (models: Models, id: string): string =>
  (models.getProvider(id)?.name ?? id).slice(0, 4096);

/** The state and sentence for each reason an auth.json entry is not offered. */
const REFUSAL_STATUS: Record<
  CredentialRefusal,
  {
    readonly state: ProviderStatus["state"];
    readonly detail: (provider: string) => string;
  }
> = {
  hidden_provider: {
    state: "missing",
    detail: (provider) =>
      provider === CODEX_PROVIDER
        ? "Cairn does not use pi's Codex login; its own Codex sign-in is not available yet."
        : `Cairn does not read pi's ${provider} credential.`,
  },
  oauth: {
    state: "refused",
    detail: (provider) =>
      `pi's ${provider} login is an OAuth credential, which Cairn does not use. Add an API key in pi to use this provider.`,
  },
  not_literal: {
    state: "refused",
    detail: (provider) =>
      `pi's ${provider} key is a command or variable template. Cairn reads literal keys only.`,
  },
  subscription_token: {
    state: "refused",
    detail: (provider) =>
      `pi's ${provider} key is a Claude subscription token, which Cairn never sends.`,
  },
  malformed: {
    state: "unknown",
    detail: (provider) =>
      `pi's auth.json entry for ${provider} is not a credential Cairn understands.`,
  },
};

/** A status for one entry pi's auth.json holds, by id and type only. */
const entryStatus = (
  models: Models,
  entry: CredentialEntry,
  availableProviders: ReadonlySet<string>
): ProviderStatus => {
  const { provider } = entry;
  const name = providerName(models, provider);

  if (isRefusedProvider(provider)) {
    return {
      provider,
      name,
      credential: "none",
      state: "refused",
      detail: Option.some(refusedProviderMessage(provider)),
    };
  }

  return Option.match(entry.refusal, {
    onNone: (): ProviderStatus =>
      availableProviders.has(provider)
        ? {
            provider,
            name,
            credential: "api-key",
            state: "ready",
            detail: Option.none(),
          }
        : {
            provider,
            name,
            credential: "api-key",
            state: "unknown",
            detail: Option.some(
              `pi's auth.json has a key for ${provider}, but the provider offers no model with it.`
            ),
          },
    onSome: (refusal): ProviderStatus => ({
      provider,
      name,
      credential: "none",
      state: REFUSAL_STATUS[refusal].state,
      detail: Option.some(REFUSAL_STATUS[refusal].detail(provider)),
    }),
  });
};

interface CatalogSource {
  readonly models: Models;
  /** Ids of providers registered on top of pi's built-ins. */
  readonly extraProviderIds: ReadonlyArray<string>;
  readonly piDefaults: () => PiDefaults;
  /** The verdicts on pi's auth.json, when the runtime reads it. */
  readonly credentialEntries: () => Promise<ReadonlyArray<CredentialEntry>>;
}

/**
 * The available chat models, asked provider by provider. `ModelRuntime.getAvailable()` without a
 * provider answers from a snapshot that a concurrent refresh (one starts on every
 * `registerNativeProvider`) can leave stale; a per-provider ask resolves auth there and then.
 */
const availableModels = (models: Models) =>
  Effect.tryPromise({
    try: async (signal) => {
      const perProvider = await Promise.all(
        models
          .getProviders()
          .map(
            async (provider) =>
              await models.getAvailable(provider.id, { signal })
          )
      );

      return perProvider.flat();
    },
    catch: (cause) =>
      new ModelRuntimeError({
        message: `PiModelSource could not read which models are available: ${errorText(cause)}. Retry; if it persists, check the brain's log.`,
        operation: "PiModelSource.catalog",
        cause,
      }),
  });

/** The provider statuses: available providers, extra providers, auth.json's entries, refused ones. */
const providerStatuses = (
  source: CatalogSource,
  available: ReadonlyArray<Model<Api>>,
  entries: ReadonlyArray<CredentialEntry>
): ReadonlyArray<ProviderStatus> => {
  const { models } = source;
  const availableProviders = new Set(available.map((model) => model.provider));
  const statuses = new Map<string, ProviderStatus>();

  for (const provider of availableProviders) {
    statuses.set(provider, {
      provider,
      name: providerName(models, provider),
      credential: provider === BRIDGE_PROVIDER ? "subscription" : "api-key",
      state: "ready",
      detail: Option.none(),
    });
  }

  for (const id of source.extraProviderIds) {
    if (!statuses.has(id)) {
      const name = providerName(models, id);

      statuses.set(id, {
        provider: id,
        name,
        credential: "none",
        state: "missing",
        detail: Option.some(`${name} is not signed in on this machine.`),
      });
    }
  }

  for (const entry of entries) {
    if (!statuses.has(entry.provider) || Option.isSome(entry.refusal)) {
      statuses.set(
        entry.provider,
        entryStatus(models, entry, availableProviders)
      );
    }
  }

  statuses.set(ANTHROPIC_PROVIDER, {
    provider: ANTHROPIC_PROVIDER,
    name: providerName(models, ANTHROPIC_PROVIDER),
    credential: "none",
    state: "refused",
    detail: Option.some(refusedProviderMessage(ANTHROPIC_PROVIDER)),
  });

  return [...statuses.values()];
};

/** The picker's view of one models collection. */
const makeCatalog = (source: CatalogSource) => {
  const { models } = source;

  const lookup = (ref: ModelRef) =>
    Option.fromNullishOr(models.getModel(ref.provider, ref.modelId));

  const catalog = Effect.fn("PiModelSource.catalog")(function* (
    options: CatalogOptions
  ) {
    const available = yield* availableModels(models);

    const listed = listing(
      {
        available,
        extra: source.extraProviderIds.flatMap((id) => models.getModels(id)),
      },
      options
    );

    const result: ModelCatalog = {
      models: listed,
      defaults: defaultsOf(listed, source.piDefaults(), lookup),
    };

    return result;
  });

  const providers = Effect.gen(function* () {
    const available = yield* availableModels(models);

    const entries = yield* Effect.tryPromise({
      try: async () => await source.credentialEntries(),
      catch: (cause) =>
        new ModelRuntimeError({
          message: `PiModelSource could not read pi's auth.json: ${errorText(cause)}. Check the file's permissions, then retry.`,
          operation: "PiModelSource.providers",
          cause,
        }),
    });

    return providerStatuses(source, available, entries);
  }).pipe(Effect.withSpan("PiModelSource.providers"));

  const thinkingFor = (
    model: ModelRef,
    wanted: Option.Option<ThinkingLevel>
  ): ThinkingLevel => {
    const level = Option.getOrElse(wanted, () =>
      Option.getOrElse(
        source.piDefaults().thinkingLevel,
        () => PI_DEFAULT_THINKING
      )
    );

    return Option.match(lookup(model), {
      onNone: () => level,
      onSome: (found) => clampThinking(found, level),
    });
  };

  return { catalog, providers, thinkingFor };
};

/** One request outside any conversation; refused providers' models are not offered. */
const completeSimpleOn = (models: Models) =>
  Effect.fn("ModelSource.completeSimple")(function* (
    model: ModelRef,
    context: ModelContext,
    options: SimpleStreamOptions
  ) {
    const found = Option.filter(
      Option.fromNullishOr(models.getModel(model.provider, model.modelId)),
      (candidate) => !isRefusedProvider(candidate.provider)
    );

    if (Option.isNone(found)) {
      return yield* new ModelCallError({
        message: `The model ${model.provider}/${model.modelId} is not offered here. Pick another model.`,
        provider: model.provider,
        modelId: model.modelId,
        reason: "unknown_model",
      });
    }

    const answer: AssistantMessage = yield* Effect.tryPromise({
      try: async (signal) =>
        await models.completeSimple(found.value, context, {
          ...options,
          signal,
        }),
      catch: (cause) =>
        new ModelCallError({
          message: `The request to ${model.provider}/${model.modelId} failed: ${errorText(cause)}`,
          provider: model.provider,
          modelId: model.modelId,
          reason: "request_failed",
        }),
    });

    if (answer.stopReason === "error" || answer.stopReason === "aborted") {
      return yield* new ModelCallError({
        message: `The request to ${model.provider}/${model.modelId} failed: ${answer.errorMessage ?? answer.stopReason}`,
        provider: model.provider,
        modelId: model.modelId,
        reason: "request_failed",
      });
    }

    return answer;
  });

/** Creates pi's model runtime, read-only over `agentDir`. */
const createRuntime = (credentials: CairnCredentialStore) =>
  Effect.tryPromise({
    try: async () => {
      const agent: typeof PiCodingAgent =
        await import("@earendil-works/pi-coding-agent");

      return await agent.ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStore: new InMemoryModelsStore(),
        allowModelNetwork: true,
        modelRefreshTimeoutMs: MODEL_REFRESH_TIMEOUT_MS,
      });
    },
    catch: (cause) =>
      new ModelRuntimeError({
        message: `PiModelSource could not create pi's model runtime: ${errorText(cause)}. Reinstall the brain's dependencies, then restart.`,
        operation: "PiModelSource.create",
        cause,
      }),
  });

/** The picker's view of the brain's models: listing, defaults, provider status and clamps. */
export class PiModelSource extends Context.Service<
  PiModelSource,
  {
    /** The picker's models and the defaults a new thread starts with. */
    catalog(
      options: CatalogOptions
    ): Effect.Effect<ModelCatalog, ModelRuntimeError>;
    /** Each provider Cairn knows of, whether it can be used, and why not. Never a credential value. */
    readonly providers: Effect.Effect<
      ReadonlyArray<ProviderStatus>,
      ModelRuntimeError
    >;
    /** `wanted` (default pi's level) held to the levels `model` takes; unknown models keep it. */
    thinkingFor(
      model: ModelRef,
      wanted: Option.Option<ThinkingLevel>
    ): ThinkingLevel;
  }
>()("cairn/server/models/PiModelSource") {
  /** The catalog over the ambient `ModelSource`'s models, with no pi setup: faux and scripted brains. */
  static readonly layerFromModelSource = Layer.effect(
    PiModelSource,
    Effect.gen(function* () {
      const source = yield* ModelSource;

      return PiModelSource.of(
        makeCatalog({
          models: source.models(),
          extraProviderIds: [],
          piDefaults: () => ({
            provider: Option.none(),
            model: Option.none(),
            thinkingLevel: Option.none(),
          }),
          credentialEntries: async () => await Promise.resolve([]),
        })
      );
    })
  );

  /**
   * pi's model runtime, read-only over `~/.pi/agent`, as both the brain's `ModelSource` and the
   * picker's `PiModelSource`. Strips the Anthropic auth variables from `process.env` first, then
   * registers the guarded `anthropic` provider and every `ExtraProviders` entry. Needs `PiConfig`
   * and `HarnessSettings`; fails with `ModelRuntimeError` when pi-coding-agent cannot be loaded.
   */
  static readonly layerNoDeps = Layer.effectContext(
    Effect.gen(function* () {
      const pi = yield* PiConfig;
      const harness = yield* HarnessSettings;
      const extra = yield* ExtraProviders;

      const stripped = yield* stripAnthropicEnvironment(process.env);

      if (stripped.length > 0) {
        yield* Effect.logWarning("anthropic auth variables removed").pipe(
          Effect.annotateLogs({
            event: "anthropic_env_stripped",
            names: stripped.join(" "),
          })
        );
      }

      const credentials = new CairnCredentialStore(
        path.join(pi.agentDir, "auth.json")
      );

      const runtime = yield* createRuntime(credentials);

      runtime.registerNativeProvider(guardedAnthropicProvider());

      for (const provider of extra) {
        runtime.registerNativeProvider(provider);
      }

      const bridgeModelIds = () =>
        runtime.getModels(BRIDGE_PROVIDER).map((model) => model.id);

      const catalog = makeCatalog({
        models: runtime,
        extraProviderIds: extra.map((provider) => provider.id),
        piDefaults: () => pi.current().defaults,
        credentialEntries: async () => await credentials.entries(),
      });

      return Context.make(PiModelSource, PiModelSource.of(catalog)).pipe(
        Context.add(
          ModelSource,
          ModelSource.of({
            models: () => runtime,
            settings: () => harness.settings(bridgeModelIds()),
            completeSimple: completeSimpleOn(runtime),
          })
        )
      );
    })
  );

  /** `layerNoDeps` over the brain's `PiConfig` and `HarnessSettings`. */
  static readonly layer = PiModelSource.layerNoDeps.pipe(
    Layer.provide(HarnessSettings.layerNoDeps),
    Layer.provide(PiConfig.layer)
  );
}
