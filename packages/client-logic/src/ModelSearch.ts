// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// packages/shared/src/searchRanking.ts (the scoring every composer search shares),
// apps/web/src/components/chat/modelPickerSearch.ts and modelPickerKeys.ts. Kept: exact, prefix,
// boundary, substring and subsequence scores; multi-token model search where every token must match
// some field, a favourite boost that never beats a clearly better match, and the caller's order as
// the tie-break; collision-free model keys. Changed: "no match" is `Option.none()`, a model is a pi
// provider and model id rather than a t3code driver instance, and the legacy section keys are gone.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { Array, Option, Order } from "effect";

/** Trims and lowercases a query, dropping a leading trigger (`/`, `$`) when `trimLeading` matches it. */
export const normalizeSearchQuery = (
  input: string,
  trimLeading: Option.Option<RegExp> = Option.none()
): string => {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return "";
  }

  return Option.match(trimLeading, {
    onNone: () => trimmed.toLowerCase(),
    onSome: (pattern) => trimmed.replace(pattern, "").toLowerCase(),
  });
};

/**
 * How tightly `query`'s characters appear in order inside `value`; lower is better. None when
 * they do not all appear.
 */
export const scoreSubsequenceMatch = (
  value: string,
  query: string,
  ignorePosition = false
): Option.Option<number> => {
  if (query.length === 0) {
    return Option.some(0);
  }

  let queryIndex = 0;
  let first = -1;
  let previous = -1;
  let gapPenalty = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value.charAt(index) === query.charAt(queryIndex)) {
      if (first === -1) {
        first = index;
      }

      if (previous !== -1) {
        gapPenalty += index - previous - 1;
      }

      previous = index;
      queryIndex += 1;

      if (queryIndex === query.length) {
        const spanPenalty = index - first + 1 - query.length;

        if (ignorePosition) {
          return Option.some(gapPenalty * 3 + spanPenalty);
        }

        const lengthPenalty = Math.min(64, value.length - query.length);

        return Option.some(
          first * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty
        );
      }
    }
  }

  return Option.none();
};

const lengthPenalty = (value: string, query: string): number =>
  Math.min(64, Math.max(0, value.length - query.length));

const boundaryMatchIndex = (
  value: string,
  query: string,
  markers: ReadonlyArray<string>
): Option.Option<number> =>
  Array.reduce(markers, Option.none<number>(), (best, marker) => {
    const index = value.indexOf(`${marker}${query}`);

    if (index === -1) {
      return best;
    }

    const match = index + marker.length;

    return Option.match(best, {
      onNone: () => Option.some(match),
      onSome: (current) => Option.some(Math.min(current, match)),
    });
  });

/** The bases a field's scores start from; a missing base turns that kind of match off. */
export interface QueryMatchBases {
  readonly exact: number;
  readonly prefix: Option.Option<number>;
  readonly boundary: Option.Option<number>;
  readonly includes: Option.Option<number>;
  readonly fuzzy: Option.Option<number>;
  readonly boundaryMarkers: ReadonlyArray<string>;
  readonly ignorePosition: boolean;
}

/** Bases with only an exact match on; spread over it to turn the others on. */
export const exactOnly = (exact: number): QueryMatchBases => ({
  exact,
  prefix: Option.none(),
  boundary: Option.none(),
  includes: Option.none(),
  fuzzy: Option.none(),
  boundaryMarkers: [" ", "-", "_", "/"],
  ignorePosition: false,
});

/**
 * Scores `query` against one field; lower is better, none for no match. Both must already be
 * normalized (see {@link normalizeSearchQuery}).
 */
export const scoreQueryMatch = (
  value: string,
  query: string,
  bases: QueryMatchBases
): Option.Option<number> => {
  if (value.length === 0 || query.length === 0) {
    return Option.none();
  }

  if (value === query) {
    return Option.some(bases.exact);
  }

  const penalty = bases.ignorePosition ? 0 : lengthPenalty(value, query);
  const position = (index: number) => (bases.ignorePosition ? 0 : index * 2);

  if (Option.isSome(bases.prefix) && value.startsWith(query)) {
    return Option.some(bases.prefix.value + penalty);
  }

  const boundary = Option.flatMap(bases.boundary, (base) =>
    Option.map(
      boundaryMatchIndex(value, query, bases.boundaryMarkers),
      (index) => base + position(index) + penalty
    )
  );

  if (Option.isSome(boundary)) {
    return boundary;
  }

  const includesIndex = value.indexOf(query);

  if (Option.isSome(bases.includes) && includesIndex !== -1) {
    return Option.some(
      bases.includes.value + position(includesIndex) + penalty
    );
  }

  return Option.flatMap(bases.fuzzy, (base) =>
    Option.map(
      scoreSubsequenceMatch(value, query, bases.ignorePosition),
      (score) => base + score
    )
  );
};

/** The lowest score among `scores`, none when every one missed. */
export const bestScore = (
  scores: ReadonlyArray<Option.Option<number>>
): Option.Option<number> =>
  Array.match(Array.getSomes(scores), {
    onEmpty: () => Option.none(),
    onNonEmpty: (some) => Option.some(Math.min(...some)),
  });

/** One ranked result. */
export interface RankedSearchResult<A> {
  readonly item: A;
  readonly score: number;
  readonly tieBreaker: string;
}

const rankedOrder = <A>(): Order.Order<RankedSearchResult<A>> =>
  Order.combine(
    Order.mapInput(Order.Number, (entry: RankedSearchResult<A>) => entry.score),
    Order.mapInput(
      Order.String,
      (entry: RankedSearchResult<A>) => entry.tieBreaker
    )
  );

/** Results ordered by score then tie-breaker, at most `limit` of them. */
export const rankSearchResults = <A>(
  results: ReadonlyArray<RankedSearchResult<A>>,
  limit = Number.POSITIVE_INFINITY
): ReadonlyArray<RankedSearchResult<A>> =>
  Array.sort(results, rankedOrder<A>()).slice(0, limit);

/** A model as the picker searches it. */
export interface SearchableModel {
  readonly provider: string;
  readonly providerName: string;
  readonly name: string;
  readonly modelId: string;
  readonly isFavorite: boolean;
}

const FAVORITE_BOOST = 24;

const EXACT_NAME_SCORE = -1000;

const normalizeModelName = (name: string): string =>
  normalizeSearchQuery(name).replaceAll(/\s+/gu, " ");

/** The text a model is found by: name, id and provider, normalized. */
export const buildModelSearchText = (model: SearchableModel): string =>
  normalizeSearchQuery(
    [model.name, model.modelId, model.provider, model.providerName]
      .filter((value) => value.length > 0)
      .join(" ")
  );

const searchFields = (model: SearchableModel): ReadonlyArray<string> => [
  normalizeSearchQuery(model.name),
  normalizeSearchQuery(model.modelId),
  normalizeSearchQuery(model.provider),
  normalizeSearchQuery(model.providerName),
  buildModelSearchText(model),
];

const scoreToken = (
  field: string,
  token: string,
  base: number
): Option.Option<number> =>
  scoreQueryMatch(field, token, {
    exact: base,
    prefix: Option.some(base + 2),
    boundary: Option.some(base + 4),
    includes: Option.some(base + 6),
    fuzzy: token.length >= 3 ? Option.some(base + 100) : Option.none(),
    boundaryMarkers: [" ", "-", "_", "/"],
    ignorePosition: true,
  });

/**
 * Scores a model against a query of space-separated tokens; lower is better, none when a token
 * matches no field. An exact name always wins; a favourite gets a boost.
 */
export const scoreModelSearch = (
  model: SearchableModel,
  query: string
): Option.Option<number> => {
  const tokens = Array.filter(
    normalizeSearchQuery(query).split(/\s+/u),
    (token) => token.length > 0
  );

  if (tokens.length === 0) {
    return Option.some(0);
  }

  const joined = tokens.join(" ");

  if (
    joined === normalizeModelName(model.name) ||
    joined === normalizeModelName(model.modelId)
  ) {
    return Option.some(EXACT_NAME_SCORE);
  }

  const fields = searchFields(model);

  const tokenScores = tokens.map((token) =>
    bestScore(
      fields.map((field, index) => scoreToken(field, token, index * 10))
    )
  );

  return Option.map(Option.all(tokenScores), (scores) => {
    const total = scores.reduce((sum, score) => sum + score, 0);

    return model.isFavorite ? total - FAVORITE_BOOST : total;
  });
};

/** The models matching `query`, best first; ties keep favourites first, then the given order. */
export const rankModelSearch = <A>(
  items: ReadonlyArray<A>,
  query: string,
  toSearchable: (item: A) => SearchableModel
): ReadonlyArray<A> => {
  const ranked = Array.getSomes(
    items.map((item, order) => {
      const searchable = toSearchable(item);

      return Option.map(scoreModelSearch(searchable, query), (score) => ({
        item,
        score,
        isFavorite: searchable.isFavorite,
        order,
      }));
    })
  );

  return Array.sort(
    ranked,
    Order.combineAll([
      Order.mapInput(
        Order.Number,
        (entry: (typeof ranked)[number]) => entry.score
      ),
      Order.mapInput(
        Order.flip(Order.Boolean),
        (entry: (typeof ranked)[number]) => entry.isFavorite
      ),
      Order.mapInput(
        Order.Number,
        (entry: (typeof ranked)[number]) => entry.order
      ),
    ])
  ).map((entry) => entry.item);
};

const MODEL_KEY_PREFIX = "model:";

/** A key naming one model that no provider and model id pair can collide with. */
export const modelPickerModelKey = (
  provider: string,
  modelId: string
): string => `${MODEL_KEY_PREFIX}${provider.length}:${provider}${modelId}`;

/** The provider and model id a {@link modelPickerModelKey} names; none for any other string. */
export const parseModelPickerModelKey = (
  key: string
): Option.Option<{ readonly provider: string; readonly modelId: string }> => {
  if (!key.startsWith(MODEL_KEY_PREFIX)) {
    return Option.none();
  }

  const encoded = key.slice(MODEL_KEY_PREFIX.length);
  const separator = encoded.indexOf(":");
  const lengthText = encoded.slice(0, Math.max(0, separator));

  if (separator === -1 || !/^\d+$/u.test(lengthText)) {
    return Option.none();
  }

  const providerLength = Number(lengthText);
  const value = encoded.slice(separator + 1);

  if (!Number.isSafeInteger(providerLength) || providerLength > value.length) {
    return Option.none();
  }

  return Option.some({
    provider: value.slice(0, providerLength),
    modelId: value.slice(providerLength),
  });
};
