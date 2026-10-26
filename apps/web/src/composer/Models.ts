// Which model and thinking level the composer shows and sends. A thread runs on what its shell row
// says; a draft runs on what the user picked, else its project's default, else the server's.
// Thinking is clamped to the levels the chosen model accepts.

import {
  modelPickerModelKey,
  rankModelSearch,
} from "@cairn/client-logic/ModelSearch";
import type { SearchableModel } from "@cairn/client-logic/ModelSearch";
import type {
  ModelListing,
  ModelRef,
  ThinkingLevel,
} from "@cairn/protocol/Models";
import { Array, Option } from "effect";

import { activeDraft, draftProject, isDraftTarget } from "./Drafts.ts";
import type { Model } from "./Model.ts";

/** The listing of `ref` in the loaded catalog. */
export const findListing = (
  model: Model,
  ref: ModelRef
): Option.Option<ModelListing> =>
  Option.flatMap(model.catalog, (catalog) =>
    Array.findFirst(
      catalog.models,
      (listing) =>
        listing.provider === ref.provider && listing.modelId === ref.modelId
    )
  );

const serverDefaults = (model: Model) =>
  Option.orElse(
    Option.map(model.catalog, (catalog) => catalog.defaults),
    () => model.context.defaults
  );

/** The model the composer would send on. None until a default is known. */
export const resolvedModel = (model: Model): Option.Option<ModelRef> => {
  if (!isDraftTarget(model)) {
    return Option.map(model.context.thread, (thread) => ({
      provider: thread.provider,
      modelId: thread.modelId,
    }));
  }

  const draft = activeDraft(model);

  return Option.firstSomeOf([
    draft.model,
    Option.flatMap(draftProject(model), (project) => project.defaultModel),
    Option.map(serverDefaults(model), (defaults) => defaults.model),
  ]);
};

/** The levels the resolved model accepts; empty for a model without reasoning or not listed. */
export const thinkingLevels = (model: Model): ReadonlyArray<ThinkingLevel> =>
  Option.match(
    Option.flatMap(resolvedModel(model), (ref) => findListing(model, ref)),
    {
      onNone: () => [],
      onSome: (listing) => listing.thinkingLevels,
    }
  );

/** `level` when the model accepts it, else the nearest level it does accept. */
export const clampThinking = (
  level: ThinkingLevel,
  levels: ReadonlyArray<ThinkingLevel>
): ThinkingLevel => {
  if (levels.length === 0 || levels.includes(level)) {
    return level;
  }

  return levels.includes("medium") ? "medium" : (levels.at(-1) ?? level);
};

/** The thinking level the composer would send with. */
export const resolvedThinking = (
  model: Model
): Option.Option<ThinkingLevel> => {
  if (!isDraftTarget(model)) {
    return Option.map(model.context.thread, (thread) => thread.thinkingLevel);
  }

  return Option.map(
    Option.orElse(activeDraft(model).thinking, () =>
      Option.map(serverDefaults(model), (defaults) => defaults.thinkingLevel)
    ),
    (level) => clampThinking(level, thinkingLevels(model))
  );
};

/** The picker trigger's label: the listing's name, else the model id, else a placeholder. */
export const modelLabel = (model: Model): string =>
  Option.match(resolvedModel(model), {
    onNone: () => "Choose a model",
    onSome: (ref) =>
      Option.match(findListing(model, ref), {
        onNone: () => ref.modelId,
        onSome: (listing) => listing.name,
      }),
  });

/** A thinking level as the trait control names it. */
export const thinkingLabel = (level: ThinkingLevel): string =>
  level === "xhigh"
    ? "Extra high"
    : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

/** A provider id as the picker names its group. */
export const providerLabel = (provider: string): string =>
  provider
    .split(/[-_]/u)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");

const searchable =
  (favorites: ReadonlyArray<string>) =>
  (listing: ModelListing): SearchableModel => ({
    provider: listing.provider,
    providerName: providerLabel(listing.provider),
    name: listing.name,
    modelId: listing.modelId,
    isFavorite: favorites.includes(
      modelPickerModelKey(listing.provider, listing.modelId)
    ),
  });

/** One group of the picker: a provider (or the favourites) and its models in order. */
export interface ModelGroup {
  readonly id: string;
  readonly label: string;
  readonly models: ReadonlyArray<ModelListing>;
}

/**
 * The picker's groups for `query`: favourites first, then one group per provider in catalog order.
 * With a query, one ranked list of every match.
 */
export const modelGroups = (
  model: Model,
  query: string
): ReadonlyArray<ModelGroup> => {
  const listings = Option.match(model.catalog, {
    onNone: () => [],
    onSome: (catalog) => catalog.models,
  });

  const { favoriteModels } = model.settings;

  if (query.trim().length > 0) {
    return [
      {
        id: "results",
        label: "Results",
        models: rankModelSearch(listings, query, searchable(favoriteModels)),
      },
    ];
  }

  const favorites = Array.filter(listings, (listing) =>
    favoriteModels.includes(
      modelPickerModelKey(listing.provider, listing.modelId)
    )
  );

  const providers = Array.dedupe(listings.map((listing) => listing.provider));

  const groups = providers.map((provider) => ({
    id: provider,
    label: providerLabel(provider),
    models: Array.filter(listings, (listing) => listing.provider === provider),
  }));

  return favorites.length === 0
    ? groups
    : [{ id: "favorites", label: "Favorites", models: favorites }, ...groups];
};
