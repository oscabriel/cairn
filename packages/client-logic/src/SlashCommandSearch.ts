// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/chat/composerSlashCommandSearch.ts and the skill scoring of
// apps/web/src/providerSkillSearch.ts. Kept: an empty query lists everything, commands match by name
// then description, skills match by name, `skill:` prefix or description, and `/sk` still finds
// skills by their rendered `/skill:` prefix. Changed: Cairn's commands are its own (`/model`), skills
// come from pi's catalog (`SkillSummary`), and provider slash commands are gone because pi has none.
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

import type { SkillSummary } from "@cairn/protocol/Skills";
import { Array, Data, Option } from "effect";

import {
  bestScore,
  exactOnly,
  normalizeSearchQuery,
  rankSearchResults,
  scoreQueryMatch,
} from "./ModelSearch.ts";

/** One entry of the `/` menu: a Cairn command or a skill. */
export type SlashItem = Data.TaggedEnum<{
  Command: {
    readonly id: string;
    readonly command: string;
    readonly label: string;
    readonly description: string;
  };
  Skill: {
    readonly id: string;
    readonly skill: SkillSummary;
    readonly label: string;
    readonly description: string;
  };
}>;

/** Constructors and matchers for {@link SlashItem}. */
export const SlashItem = Data.taggedEnum<SlashItem>();

/** The `/` menu's entry for a skill: `/skill:<name>`, as pi spells it. */
export const skillSlashItem = (skill: SkillSummary): SlashItem =>
  SlashItem.Skill({
    id: `skill:${skill.name}`,
    skill,
    label: `/skill:${skill.name}`,
    description: skill.description,
  });

/** How well `query` names `skill`; lower is better, none for no match. */
export const scoreSkill = (
  skill: SkillSummary,
  query: string
): Option.Option<number> =>
  bestScore([
    scoreQueryMatch(skill.name.toLowerCase(), query, {
      ...exactOnly(0),
      prefix: Option.some(2),
      boundary: Option.some(4),
      includes: Option.some(6),
      fuzzy: Option.some(100),
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch(skill.description.toLowerCase(), query, {
      ...exactOnly(20),
      prefix: Option.some(22),
      boundary: Option.some(24),
      includes: Option.some(26),
    }),
  ]);

const scoreSlashItem = (
  item: SlashItem,
  query: string
): Option.Option<number> =>
  SlashItem.$match(item, {
    Skill: ({ skill }) => {
      if (query === "skill") {
        return Option.some(0);
      }

      const skillQuery = query.startsWith("skill:")
        ? query.slice("skill:".length)
        : query;

      const score =
        skillQuery.length === 0
          ? Option.some(0)
          : scoreSkill(skill, skillQuery);

      return Option.isSome(score) || !"skill".startsWith(query)
        ? score
        : Option.some(Number.MAX_SAFE_INTEGER);
    },
    Command: ({ command, description }) =>
      bestScore([
        scoreQueryMatch(command.toLowerCase(), query, {
          ...exactOnly(0),
          prefix: Option.some(2),
          boundary: Option.some(4),
          includes: Option.some(6),
          fuzzy: Option.some(100),
          boundaryMarkers: ["-", "_", "/"],
        }),
        scoreQueryMatch(description.toLowerCase(), query, {
          ...exactOnly(20),
          prefix: Option.some(22),
          boundary: Option.some(24),
          includes: Option.some(26),
        }),
      ]),
  });

const tieBreaker = (item: SlashItem): string =>
  SlashItem.$match(item, {
    Command: ({ command }) => `0\u0000${command}`,
    Skill: ({ skill }) => `1\u0000${skill.name}`,
  });

/** The `/` menu for `query` (with or without its leading slashes), best first. */
export const searchSlashItems = (
  items: ReadonlyArray<SlashItem>,
  query: string
): ReadonlyArray<SlashItem> => {
  const normalized = normalizeSearchQuery(query, Option.some(/^\/+/u));

  if (normalized.length === 0) {
    return items;
  }

  return rankSearchResults(
    Array.getSomes(
      items.map((item) =>
        Option.map(scoreSlashItem(item, normalized), (score) => ({
          item,
          score,
          tieBreaker: tieBreaker(item),
        }))
      )
    )
  ).map((entry) => entry.item);
};

/** The `$` menu for `query`: skills by name and description, best first. */
export const searchSkills = (
  skills: ReadonlyArray<SkillSummary>,
  query: string,
  limit = Number.POSITIVE_INFINITY
): ReadonlyArray<SkillSummary> => {
  const normalized = normalizeSearchQuery(query, Option.some(/^\$+/u));

  if (normalized.length === 0) {
    return skills.slice(0, limit);
  }

  return rankSearchResults(
    Array.getSomes(
      skills.map((skill) =>
        Option.map(scoreSkill(skill, normalized), (score) => ({
          item: skill,
          score,
          tieBreaker: skill.name.toLowerCase(),
        }))
      )
    ),
    limit
  ).map((entry) => entry.item);
};
