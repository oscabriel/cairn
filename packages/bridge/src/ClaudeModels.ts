// Ported from elidickinson/pi-claude-bridge, src/models.ts at
// 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1 apps/server/src/claude/models.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0, and the effort mapping of cairn-v1
// apps/server/src/claude/summary.ts. Behaviour kept: pi-ai's anthropic catalog drives the picker,
// dated snapshots are hidden, flagship families sort first, cost is zero (the plan is the meter),
// and only measured ids get `[1m]`. Changed: the catalog comes from `getBuiltinModels("anthropic")`
// (pi-ai 1.4.0, no `compat` import), and every model is stamped with the bridge's provider and api.
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { Option } from "effect";

import type { Effort } from "./ClaudeGuards.ts";

/** The pi-ai provider id, api and base URL of every bridge model. Never aliased onto `anthropic`. */
export const PROVIDER_ID = "claude-bridge";

const TWO_HUNDRED_K = 200_000;

const ONE_M = 1_000_000;

/** The plan the Claude login is on, and whether extra usage is enabled, as far as `[1m]` ids depend on it. */
export interface LongContextSettings {
  readonly plan: "pro" | "max";
  readonly extraUsage: boolean;
}

/** Until the usage probe says otherwise: the conservative plan, which never sends an unentitled `[1m]` id. */
export const DEFAULT_LONG_CONTEXT: LongContextSettings = {
  plan: "pro",
  extraUsage: false,
};

/**
 * Ids measured to serve 1M through the SDK with `[1m]` on every plan. A new model serves 200K until
 * someone measures it: an unentitled `[1m]` id fails every turn, which is worse than a smaller window.
 */
const MEASURED_ONE_M: ReadonlySet<string> = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/** Ids whose `[1m]` form works only on some plans. */
const planGatedOneM = (
  id: string,
  settings: LongContextSettings
): Option.Option<boolean> => {
  switch (id) {
    case "claude-opus-4-6": {
      return Option.some(settings.plan === "max" || settings.extraUsage);
    }

    case "claude-sonnet-4-6": {
      return Option.some(settings.extraUsage);
    }

    default: {
      return Option.none();
    }
  }
};

/** What the bridge asks Claude Code for, for one model. */
export interface ServedModel {
  /** The id sent to Claude Code, `[1m]` included. */
  readonly cliModel: string;
  /** The window that id serves; registered so pi's compaction threshold matches it. */
  readonly contextWindow: number;
}

/** The id and window the bridge requests for `modelId`. */
export const servedModel = (
  modelId: string,
  settings: LongContextSettings
): ServedModel => {
  const oneM = MEASURED_ONE_M.has(modelId)
    ? true
    : Option.getOrElse(planGatedOneM(modelId, settings), () => false);

  return oneM
    ? { cliModel: `${modelId}[1m]`, contextWindow: ONE_M }
    : { cliModel: modelId, contextWindow: TWO_HUNDRED_K };
};

const isDatedSnapshot = (id: string): boolean => /-20\d{6}$/u.test(id);

const FAMILY_ORDER: ReadonlyArray<string> = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];

interface VersionRank {
  readonly family: number;
  readonly major: number;
  readonly minor: number;
}

const versionRank = (id: string): VersionRank => {
  const [, family = "", major = "", minor = ""] = id.split("-");
  const familyIndex = FAMILY_ORDER.indexOf(family);

  return {
    family: familyIndex === -1 ? FAMILY_ORDER.length : familyIndex,
    major: Math.trunc(Number(major)) || 0,
    minor: Math.trunc(Number(minor)) || 0,
  };
};

const byDisplayOrder = (left: Model<Api>, right: Model<Api>): number => {
  const a = versionRank(left.id);
  const b = versionRank(right.id);

  return (
    a.family - b.family ||
    b.major - a.major ||
    b.minor - a.minor ||
    left.id.localeCompare(right.id)
  );
};

/**
 * The models the bridge offers: pi-ai's anthropic catalog without dated snapshots, newest flagship
 * first, at zero cost, with the window the bridge really requests, under the bridge's provider id.
 */
export const claudeModels = (
  settings: LongContextSettings
): ReadonlyArray<Model<Api>> =>
  getBuiltinModels("anthropic")
    .filter((model) => !isDatedSnapshot(model.id))
    .toSorted(byDisplayOrder)
    .map((model) => {
      const { contextWindow } = servedModel(model.id, settings);

      const name =
        contextWindow > TWO_HUNDRED_K && !/\b1M\b/iu.test(model.name)
          ? `${model.name} 1M`
          : model.name;

      return {
        id: model.id,
        name,
        api: PROVIDER_ID,
        provider: PROVIDER_ID,
        baseUrl: PROVIDER_ID,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow,
        maxTokens: model.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...Option.match(Option.fromNullishOr(model.thinkingLevelMap), {
          onNone: () => ({}),
          onSome: (thinkingLevelMap) => ({ thinkingLevelMap }),
        }),
      };
    });

/** The bridge model `id`, or none when pi-ai's catalog has no such model. */
export const claudeModel = (
  id: string,
  settings: LongContextSettings
): Option.Option<Model<Api>> =>
  Option.fromNullishOr(claudeModels(settings).find((model) => model.id === id));

const genericEffort = (level: ThinkingLevel): Effort => {
  switch (level) {
    case "minimal":
    case "low": {
      return "low";
    }

    case "medium": {
      return "medium";
    }

    case "high": {
      return "high";
    }

    case "xhigh":
    case "max": {
      return "max";
    }

    default: {
      return "high";
    }
  }
};

const isEffort = (value: string): value is Effort =>
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh" ||
  value === "max";

/**
 * Claude Code's effort for pi's thinking level on `model`. The model's own `thinkingLevelMap` wins
 * (a `null` entry means unsupported, so no effort is sent); levels it leaves unnamed use the generic
 * table. None when pi sent no level (thinking off).
 */
export const effortFor = (
  model: Model<Api>,
  reasoning: Option.Option<ThinkingLevel>
): Option.Option<Effort> =>
  Option.flatMap(reasoning, (level) => {
    const mapped = model.thinkingLevelMap?.[level];

    if (mapped === undefined) {
      return Option.some(genericEffort(level));
    }

    return mapped !== null && isEffort(mapped)
      ? Option.some(mapped)
      : Option.none();
  });
