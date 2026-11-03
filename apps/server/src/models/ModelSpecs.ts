// Model specs (ADR 0043): what a child runs on when a brief, a workflow script, a recipe or a goal's
// model judge names a model. A spec is `provider/modelId[:level]`; naming none means the parent's
// model and level, which the caller supplies. A named model is checked, never replaced: it must be
// in pi's catalog, have a usable credential, and be neither failing nor behind a spent plan window.
// `resolve` runs the check for the commit that creates a child, `check` previews it for the brief
// card and `models.check`, and `list` answers the `models` tool.
//
// A role name (`@worker`) is no spec any more. A new call that passes one is refused with
// `role_removed`; a record written before ADR 0043 that still holds one reads as no model named, and
// its caller decides that with `isRoleName` before it resolves anything.
//
// Every call reads the world as it is then: pi's catalog, which models have a usable credential,
// `ModelHealth`, and the Claude plan's windows. The pure half (`parseModelSpec`, `resolveIn`,
// `checkIn`, `listIn`) takes that world as a value, so tests and judges drive it without a brain.

import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import type {
  ModelCheck,
  ModelCheckFailure,
  ModelUnready,
  ResolvedModel,
} from "@cairn/protocol/ModelSpecs";
import {
  ModelCheck as ModelCheckSchema,
  ModelSpec,
} from "@cairn/protocol/ModelSpecs";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";

import { ModelSource } from "../brain/ModelSource.ts";
import { BridgeProvider } from "./BridgeProvider.ts";
import { ModelHealth, UNSTATED_LIMIT_MS } from "./ModelHealth.ts";
import type { HealthState } from "./ModelHealth.ts";
import { ModelPrice, priceLabel, priceOf } from "./ModelPrice.ts";
import {
  clampThinking,
  PiModelSource,
  thinkingLevelsOf,
} from "./PiModelSource.ts";
import { SettingsStore } from "./SettingsStore.ts";

/** The thinking levels a spec may end in (`opencode-go/gpt-6-luna:low`). */
const LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const isThinkingLevel = (word: string): word is ThinkingLevel =>
  LEVELS.has(word);

/** The Claude bridge's provider id; its plan windows can be spent before any request fails. */
const BRIDGE_PROVIDER = "claude-bridge";

/** `provider/modelId`. */
export const modelText = (model: ModelRef): string =>
  `${model.provider}/${model.modelId}`;

/** A model and level as a spec: `provider/modelId`, with `:level` when there is one. */
export const specOf = (
  model: ModelRef,
  level: Option.Option<ThinkingLevel>
): string =>
  Option.match(level, {
    onNone: () => modelText(model),
    onSome: (found) => `${modelText(model)}:${found}`,
  });

/**
 * Whether `text` is a role name (`@worker`, `@scout:high`): no spec since ADR 0043. A record written
 * before it reads one as no model named; a new call is refused. Only the first character is read,
 * since a model id may hold `@` but a provider never starts with one.
 */
export const isRoleName = (text: string): boolean =>
  text.trim().startsWith("@");

/** A spec parsed: a model with an optional level, or a role name from before ADR 0043. */
export type ParsedSpec = Data.TaggedEnum<{
  Named: {
    readonly spec: ModelSpec;
    readonly model: ModelRef;
    readonly level: Option.Option<ThinkingLevel>;
  };
  Role: { readonly spec: ModelSpec };
}>;

/** Builds and matches `ParsedSpec` values. */
export const ParsedSpec = Data.taggedEnum<ParsedSpec>();

const decodeSpec = Schema.decodeOption(ModelSpec);

/**
 * Parses what a tool, script or brief passes where a model goes: `provider/modelId[:level]`, or a
 * role name. A trailing `:level` is always read as the thinking level, so a model id that itself
 * ends in `:high` cannot be named. None for anything else.
 */
export const parseModelSpec = (text: string): Option.Option<ParsedSpec> =>
  Option.flatMap(decodeSpec(text.trim()), (spec) => {
    if (spec.startsWith("@")) {
      return Option.some(ParsedSpec.Role({ spec }));
    }

    const colon = spec.lastIndexOf(":");
    const tail = colon === -1 ? "" : spec.slice(colon + 1);

    const [head, level] = isThinkingLevel(tail)
      ? [spec.slice(0, colon), Option.some(tail)]
      : [spec, Option.none<ThinkingLevel>()];

    const slash = head.indexOf("/");
    const provider = head.slice(0, slash);
    const modelId = head.slice(slash + 1);

    return slash <= 0 || modelId === ""
      ? Option.none()
      : Option.some(
          ParsedSpec.Named({ spec, model: { provider, modelId }, level })
        );
  });

/** The model a spec names, without its level; none for a role name or no spec. */
export const modelOfSpec = (text: string): Option.Option<ModelRef> =>
  Option.flatMap(parseModelSpec(text), (parsed) =>
    ParsedSpec.$is("Named")(parsed) ? Option.some(parsed.model) : Option.none()
  );

/**
 * Everything one check reads, taken at the call: pi's catalog, whether a model's credential is
 * usable, each provider's health, and whether a plan window in front of a model is spent.
 */
export interface ModelWorld {
  /** The model's catalog entry; none when pi's catalog does not list it. */
  readonly catalog: (model: ModelRef) => Option.Option<Model<Api>>;
  /** The models offered with a usable credential, in the picker's order. */
  readonly offered: ReadonlyArray<Model<Api>>;
  /** Whether the model is offered with a usable credential (the picker's `available`). */
  readonly available: (model: ModelRef) => boolean;
  readonly health: (provider: string) => HealthState;
  /** Whether a plan window in front of the model is spent (the Claude plan's, today). */
  readonly planLimited: (model: ModelRef) => boolean;
}

/** Why a spec did not resolve: the reasons a brief card blocks Go on. */
export type Unresolved = Extract<
  ModelCheck["resolution"],
  { readonly _tag: "Unresolved" }
>;

/** The two outcomes of a spec's check, with their constructors and guards. */
const Resolution = ModelCheckSchema.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

const unresolved = (reason: ModelCheckFailure): Unresolved =>
  Resolution.cases.Unresolved.make({ reason });

/** Why `model` cannot take a child now, or none when it can. */
export const unreadyOf = (
  world: ModelWorld,
  model: ModelRef
): Option.Option<ModelUnready> => {
  if (Option.isNone(world.catalog(model))) {
    return Option.some("unknown_model");
  }

  if (!world.available(model)) {
    return Option.some("missing_credential");
  }

  const health = world.health(model.provider);

  if (health === "failing") {
    return Option.some("failing");
  }

  return health === "limited" || world.planLimited(model)
    ? Option.some("limited")
    : Option.none();
};

/**
 * `model` at `level` as a dispatch records it, the level held to the levels the model takes and
 * priced from the catalog.
 */
const resolvedOn = (
  world: ModelWorld,
  spec: ModelSpec,
  model: ModelRef,
  level: Option.Option<ThinkingLevel>
): ResolvedModel => {
  const entry = world.catalog(model);

  const thinkingLevel = Option.map(level, (wanted) =>
    Option.match(entry, {
      onNone: () => wanted,
      onSome: (found) => clampThinking(found, wanted),
    })
  );

  return {
    spec,
    model: { provider: model.provider, modelId: model.modelId },
    thinkingLevel: Option.getOrNull(thinkingLevel),
    priced: ModelPrice.$is("Priced")(priceOf(model, world.catalog)),
  };
};

/**
 * Resolves `text` against `world`: a named model that is in the catalog, has a usable credential
 * and is neither failing nor limited, at the spec's level held to the levels it takes. Fails with
 * the reason a brief card blocks Go on: not a spec, a role name, or why the model is not ready.
 */
export const resolveIn = (
  world: ModelWorld,
  text: string
): Result.Result<ResolvedModel, Unresolved> => {
  const parsed = parseModelSpec(text);

  if (Option.isNone(parsed)) {
    return Result.fail(unresolved("invalid_spec"));
  }

  return ParsedSpec.$match(parsed.value, {
    Role: () => Result.fail(unresolved("role_removed")),
    Named: ({ spec, model, level }) =>
      Option.match(unreadyOf(world, model), {
        onNone: () => Result.succeed(resolvedOn(world, spec, model, level)),
        onSome: (reason) => Result.fail(unresolved(reason)),
      }),
  });
};

/** Each spec's preview for the brief card, without side effects: resolved, or why Go is blocked. */
export const checkIn = (
  world: ModelWorld,
  specs: ReadonlyArray<string>
): ReadonlyArray<ModelCheck> =>
  specs.map((text): ModelCheck => ({
    spec: text.trim() === "" ? "(empty)" : text.trim(),
    resolution: Result.match(resolveIn(world, text), {
      onFailure: (failure): ModelCheck["resolution"] => failure,
      onSuccess: (resolved): ModelCheck["resolution"] =>
        Resolution.cases.Resolved.make({ resolved }),
    }),
  }));

/** The words for each reason a spec did not resolve, for errors and the brief card. */
export const FAILURE_WORDS: Readonly<Record<ModelCheckFailure, string>> = {
  invalid_spec: "it is not provider/modelId[:level]",
  role_removed:
    "roles (@worker, @scout, @judge, @verifier) were removed; name a model as provider/modelId[:level], or leave it out to run on your own model",
  unknown_model: "it is not in the model catalog",
  missing_credential: "its provider has no usable credential",
  limited: "its plan limit is reached",
  failing: "its provider is failing",
};

/** The caller of the `models` tool: the model and level it runs on, when it has one. */
export interface ModelsCaller {
  readonly model: Option.Option<ModelRef>;
  readonly thinkingLevel: Option.Option<ThinkingLevel>;
}

/** One model a child can run on, as the `models` tool lists it. */
export interface ListedModel {
  readonly model: ModelRef;
  /** The catalog's name; none when it only restates the id. */
  readonly label: Option.Option<string>;
  /** The levels it takes, `off` first; empty for a model without reasoning. */
  readonly levels: ReadonlyArray<ThinkingLevel>;
  /** Its list price, as `priceLabel` words it. */
  readonly price: string;
  /** Whether it is the caller's own model. */
  readonly own: boolean;
}

/** One provider's part of the listing. */
export interface ProviderModels {
  readonly provider: string;
  /** Why no child can start on its models now; none when they are ready. */
  readonly unready: Option.Option<ModelUnready>;
  readonly models: ReadonlyArray<ListedModel>;
  /** Models of the provider left out: past the short list, or matches past it with a search. */
  readonly omitted: number;
}

/** What the `models` tool answers. */
export interface ModelListing {
  readonly caller: ModelsCaller;
  readonly providers: ReadonlyArray<ProviderModels>;
  /** The search terms the listing was filtered by; empty for the short list. */
  readonly search: ReadonlyArray<string>;
}

/**
 * How many models a provider lists without a search, and how many matches with one. A catalog can
 * hold hundreds of models (OpenCode Go, OpenRouter), so the agent gets a short list and searches
 * for the rest; the caller's own model is always listed.
 */
export const LISTED_MODEL_LIMIT = 8;

/** The text a search matches a model on: its provider, id and name. */
const searchTextOf = (model: Model<Api>) =>
  `${model.provider}/${model.id} ${model.name}`.toLowerCase();

/** One provider's models as the listing cuts them. */
interface ProviderCut {
  readonly listed: ReadonlyArray<Model<Api>>;
  readonly omitted: number;
}

/**
 * One provider's models, short or searched. Without model terms: its first `LISTED_MODEL_LIMIT`
 * models plus the caller's own. With them: the models whose text holds every term, cut to the
 * limit.
 */
const listProvider = (
  models: ReadonlyArray<Model<Api>>,
  modelTerms: ReadonlyArray<string>,
  isOwn: (model: Model<Api>) => boolean
): ProviderCut => {
  if (modelTerms.length > 0) {
    const matches = models.filter((model) =>
      modelTerms.every((term) => searchTextOf(model).includes(term))
    );

    const listed = matches.slice(0, LISTED_MODEL_LIMIT);

    return { listed, omitted: matches.length - listed.length };
  }

  const shown = new Set(models.slice(0, LISTED_MODEL_LIMIT));
  const listed = models.filter((model) => shown.has(model) || isOwn(model));

  return { listed, omitted: models.length - listed.length };
};

/** Why no child starts on a provider's models now, from its health; none when they are ready. */
const unreadyProvider = (health: HealthState): Option.Option<ModelUnready> => {
  if (health === "failing") {
    return Option.some("failing");
  }

  return health === "limited" ? Option.some("limited") : Option.none();
};

/** One model as the listing shows it. */
const listedOf = (
  world: ModelWorld,
  model: Model<Api>,
  own: boolean
): ListedModel => {
  const ref = { provider: model.provider, modelId: model.id };

  return {
    model: ref,
    label:
      model.name.toLowerCase() === model.id.toLowerCase()
        ? Option.none()
        : Option.some(model.name),
    levels: thinkingLevelsOf(model),
    price: priceLabel(priceOf(ref, world.catalog)),
    own,
  };
};

/**
 * The models a child can be named onto now, by provider, after t3code's `orchestrator_capabilities`:
 * every model offered with a usable credential, short by default and searched with `search`. A
 * search term that is a whole provider id picks that provider; the other terms filter models by
 * provider, id and name, and a provider with no match is left out. Each provider says when it is
 * failing or limited, since no child starts there then.
 */
export const listIn = (
  world: ModelWorld,
  caller: ModelsCaller,
  search: Option.Option<string>
): ModelListing => {
  const terms = Option.match(search, {
    onNone: () => [],
    onSome: (text) => text.toLowerCase().split(/\s+/u).filter(Boolean),
  });

  const isOwn = (model: Model<Api>) =>
    Option.exists(
      caller.model,
      (own) => own.provider === model.provider && own.modelId === model.id
    );

  const byProvider = new Map<string, Array<Model<Api>>>();

  for (const model of world.offered) {
    const models = byProvider.get(model.provider) ?? [];

    models.push(model);
    byProvider.set(model.provider, models);
  }

  const ids = new Set([...byProvider.keys()].map((id) => id.toLowerCase()));
  const providerTerms = terms.filter((term) => ids.has(term));
  const modelTerms = terms.filter((term) => !ids.has(term));

  const providers = [...byProvider].flatMap(
    ([provider, models]): Array<ProviderModels> => {
      if (
        providerTerms.length > 0 &&
        !providerTerms.includes(provider.toLowerCase())
      ) {
        return [];
      }

      const { listed, omitted } = listProvider(models, modelTerms, isOwn);

      if (modelTerms.length > 0 && listed.length === 0) {
        return [];
      }

      return [
        {
          provider,
          unready: unreadyProvider(world.health(provider)),
          models: listed.map((model) => listedOf(world, model, isOwn(model))),
          omitted,
        },
      ];
    }
  );

  return { caller, providers, search: terms };
};

/** A model's thinking levels in a line: `levels off to high`, or that it does not reason. */
const levelsText = (levels: ReadonlyArray<ThinkingLevel>) => {
  const [first] = levels;
  const last = levels.at(-1);

  if (first === undefined || last === undefined) {
    return "no thinking levels";
  }

  return first === last ? `level ${first}` : `levels ${levels.join(", ")}`;
};

/** The `models` tool's text: the caller's model, then each provider's models, then how to name one. */
export const modelsText = (listing: ModelListing): string => {
  const own = Option.match(listing.caller.model, {
    onNone: () =>
      "You run on no model Cairn can name. Name a model where a tool takes one.",
    onSome: (model) =>
      `You run on ${specOf(model, listing.caller.thinkingLevel)}. A child that names no model runs on that too.`,
  });

  const sections = listing.providers.map((provider) => {
    const head = Option.match(provider.unready, {
      onNone: () => `${provider.provider}:`,
      onSome: (reason) =>
        `${provider.provider} (no child starts here now: ${FAILURE_WORDS[reason]}):`,
    });

    const lines = provider.models.map((listed) => {
      const label = Option.match(listed.label, {
        onNone: () => "",
        onSome: (name) => ` (${name})`,
      });

      return `- ${modelText(listed.model)}${label}${listed.own ? ", yours" : ""}; ${levelsText(listed.levels)}; ${listed.price}`;
    });

    const more =
      provider.omitted === 0
        ? []
        : [`  ${String(provider.omitted)} more; pass search to find them.`];

    return [head, ...lines, ...more].join("\n");
  });

  const none =
    listing.providers.length === 0
      ? [
          listing.search.length === 0
            ? "No model has a usable credential now."
            : `No model matches "${listing.search.join(" ")}".`,
        ]
      : [];

  return [
    own,
    "",
    ...sections.flatMap((section) => [section, ""]),
    ...none,
    "Where a tool takes a model, name one as provider/modelId, with :level for a thinking level (opencode-go/gpt-6-luna:high), or leave it out to run on your own model. Change the model only when the user asks for one.",
  ].join("\n");
};

/** A named spec could not be resolved; the message says why and what to do. */
export class ModelSpecError extends Schema.TaggedError<ModelSpecError>()(
  "ModelSpecError",
  {
    message: Schema.String,
    spec: Schema.String,
    reason: Schema.Literals([
      "invalid_spec",
      "role_removed",
      "unknown_model",
      "missing_credential",
      "limited",
      "failing",
    ]),
  }
) {}

/** The error for `text` that failed with `failure`. */
const specErrorOf = (text: string, failure: Unresolved): ModelSpecError =>
  new ModelSpecError({
    message: `ModelSpecs.resolve refused "${text}": ${FAILURE_WORDS[failure.reason]}. Call models to see what a child can run on now, or leave the model out to run on your own.`,
    spec: text,
    reason: failure.reason,
  });

/** The catalog or the provider list could not be read. Nothing was resolved; retry. */
export class ModelSpecsUnavailable extends Schema.TaggedError<ModelSpecsUnavailable>()(
  "ModelSpecsUnavailable",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "ModelSpecs.resolve",
      "ModelSpecs.check",
      "ModelSpecs.list",
    ]),
    cause: Schema.Defect(),
  }
) {}

/** The failure of a read `operation` needed. */
const unavailable =
  (operation: ModelSpecsUnavailable["operation"]) =>
  (cause: { readonly message: string }) =>
    new ModelSpecsUnavailable({
      message: `${operation} could not read the catalog or the providers: ${cause.message}. Nothing was resolved; retry.`,
      operation,
      cause,
    });

/** The parts of a Claude plan window that say whether it is spent now. */
export interface PlanWindowReading {
  readonly id: string;
  readonly usedPercent: number;
  readonly exhausted: boolean;
  /** When the window resets, in epoch milliseconds; none when Claude did not say. */
  readonly resetsAt: Option.Option<number>;
  /** When the reading that set this window was taken, in epoch milliseconds. */
  readonly observedAt: number;
}

/**
 * Whether a Claude plan window that applies to `modelId` is spent at `now`. A spent window counts
 * only until its `resetsAt`, or, when Claude named no reset, for `UNSTATED_LIMIT_MS` after it was
 * observed, as `ModelHealth` holds an unstated limit: the usage service probes only while someone
 * watches or a bridge turn runs, so a reading taken before the reset would otherwise hold every
 * bridge model limited, and keep the turns that would refresh it from running.
 */
export const windowSpentFor = (
  windows: ReadonlyArray<PlanWindowReading>,
  modelId: string,
  now: number
): boolean =>
  windows.some((window) => {
    const spent = window.exhausted || window.usedPercent >= 100;

    // `monthly_spend` is extra usage past the plan; spending it does not stop the plan's windows.
    if (!spent || window.id === "monthly_spend") {
      return false;
    }

    const until = Option.getOrElse(
      window.resetsAt,
      () => window.observedAt + UNSTATED_LIMIT_MS
    );

    if (now >= until) {
      return false;
    }

    const scoped = /^seven_day_(?<model>.+)$/u.exec(window.id);

    return (
      scoped === null ||
      modelId
        .toLowerCase()
        .replaceAll("-", "_")
        .includes(scoped.groups?.model ?? "")
    );
  });

/**
 * Model specs over the brain's catalog, provider health and plan windows. Each call reads them
 * afresh, so a check always sees the world as it is at that moment.
 */
export class ModelSpecs extends Context.Service<
  ModelSpecs,
  {
    /**
     * Resolves a named spec for the commit that creates a child. Fails with `ModelSpecError` when
     * the spec is not one, is a role name, or names a model that is not ready.
     */
    resolve(
      spec: string
    ): Effect.Effect<ResolvedModel, ModelSpecError | ModelSpecsUnavailable>;
    /** Each spec's preview for the brief card and `models.check`; writes nothing. */
    check(
      specs: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<ModelCheck>, ModelSpecsUnavailable>;
    /** The models a child can run on now, short or searched, for the `models` tool. */
    list(
      caller: ModelsCaller,
      search: Option.Option<string>
    ): Effect.Effect<ModelListing, ModelSpecsUnavailable>;
  }
>()("cairn/server/models/ModelSpecs") {
  /**
   * Over `SettingsStore`, `PiModelSource`, the brain's `ModelSource` and `ModelHealth`. Reads the
   * Claude plan's windows from `BridgeProvider`, a reference that defaults to no bridge: build it
   * where the root's `BridgeProvider.layer` is in context, or only `ModelHealth` marks the bridge
   * limited.
   */
  static readonly layerNoDeps = Layer.effect(
    ModelSpecs,
    Effect.gen(function* () {
      const settings = yield* SettingsStore;
      const catalog = yield* PiModelSource;
      const source = yield* ModelSource;
      const health = yield* ModelHealth;
      // A reference whose default is off: a root that composes no bridge sees no plan windows, so
      // the root that runs the bridge must build this layer where `BridgeProvider.layer` is given.
      const claudeUsage = (yield* BridgeProvider).usage;

      const world = Effect.gen(function* () {
        const current = yield* settings.get;

        const listed = yield* catalog.catalog({
          bridgeEnabled: current.bridgeEnabled,
        });

        const states = new Map(
          (yield* health.all).map((report) => [report.provider, report.state])
        );

        const now = yield* Clock.currentTimeMillis;

        const windows = yield* Option.match(claudeUsage, {
          onNone: () => Effect.succeed([]),
          onSome: (usage) =>
            Effect.map(usage.current, (reading) => reading.windows),
        });

        const models = source.models();

        const lookup = (model: ModelRef) =>
          Option.fromUndefinedOr(
            models.getModel(model.provider, model.modelId)
          );

        const offered = listed.models
          .filter((model) => model.available)
          .flatMap((model) => Option.toArray(lookup(model)));

        const available = new Set(
          offered.map((model) => `${model.provider}/${model.id}`)
        );

        const found: ModelWorld = {
          catalog: lookup,
          offered,
          available: (model) => available.has(modelText(model)),
          health: (provider) => states.get(provider) ?? "unknown",
          planLimited: (model) =>
            model.provider === BRIDGE_PROVIDER &&
            windowSpentFor(windows, model.modelId, now),
        };

        return found;
      });

      const resolve = Effect.fn("ModelSpecs.resolve")(function* (spec: string) {
        const now = yield* world.pipe(
          Effect.mapError(unavailable("ModelSpecs.resolve"))
        );

        const result = resolveIn(now, spec);

        if (Result.isFailure(result)) {
          return yield* specErrorOf(spec, result.failure);
        }

        return result.success;
      });

      const check = Effect.fn("ModelSpecs.check")(
        function* (specs: ReadonlyArray<string>) {
          const now = yield* world;

          return checkIn(now, specs);
        },
        Effect.mapError(unavailable("ModelSpecs.check"))
      );

      const list = Effect.fn("ModelSpecs.list")(
        function* (caller: ModelsCaller, search: Option.Option<string>) {
          const now = yield* world;

          return listIn(now, caller, search);
        },
        Effect.mapError(unavailable("ModelSpecs.list"))
      );

      return ModelSpecs.of({ resolve, check, list });
    })
  );
}
