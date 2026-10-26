// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/
// composerSlashCommandSearch.test.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: provider
// slash commands are gone, skills are pi `SkillSummary` values, and the `$` search has cases of its
// own. MIT License, Copyright (c) 2026 T3 Tools Inc.; the full notice is in SlashCommandSearch.ts.

import type { SkillSummary } from "@cairn/protocol/Skills";
import { assert, describe, it } from "@effect/vitest";

import {
  searchSkills,
  searchSlashItems,
  skillSlashItem,
  SlashItem,
} from "./SlashCommandSearch.ts";

const skill = (name: string, description: string): SkillSummary => ({
  name,
  description,
  source: "user",
  modelInvocable: true,
});

const ids = (items: ReadonlyArray<SlashItem>) => items.map(({ id }) => id);

const model = SlashItem.Command({
  id: "slash:model",
  command: "model",
  label: "/model",
  description: "Switch model",
});

const browser = skillSlashItem(
  skill("browser", "Open and control the in-app browser")
);

describe(searchSlashItems, () => {
  it("moves exact command matches ahead of broader description matches", () => {
    const items = [
      SlashItem.Command({
        id: "slash:default",
        command: "default",
        label: "/default",
        description: "Explore, build, and refine UI.",
      }),
      SlashItem.Command({
        id: "slash:ui",
        command: "ui",
        label: "/ui",
        description: "Switch the UI",
      }),
    ];

    assert.deepStrictEqual(ids(searchSlashItems(items, "ui")), [
      "slash:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy command matches", () => {
    const items = [
      SlashItem.Command({
        id: "slash:gh-fix-ci",
        command: "gh-fix-ci",
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      }),
      SlashItem.Command({
        id: "slash:github",
        command: "github",
        label: "/github",
        description: "General GitHub help",
      }),
    ];

    assert.deepStrictEqual(ids(searchSlashItems(items, "gfc")), [
      "slash:gh-fix-ci",
    ]);
  });

  it("includes skills by name and description", () => {
    assert.deepStrictEqual(ids(searchSlashItems([browser], "browser")), [
      "skill:browser",
    ]);
    assert.deepStrictEqual(ids(searchSlashItems([browser], "control")), [
      "skill:browser",
    ]);
  });

  it("matches skills by their rendered prefix", () => {
    assert.deepStrictEqual(ids(searchSlashItems([browser], "/skill:brow")), [
      "skill:browser",
    ]);
    assert.deepStrictEqual(ids(searchSlashItems([browser], "/sk")), [
      "skill:browser",
    ]);
    assert.deepStrictEqual(searchSlashItems([browser], "/ill"), []);
  });

  it("keeps skills alongside commands for an empty slash query", () => {
    assert.deepStrictEqual(ids(searchSlashItems([model, browser], "")), [
      "slash:model",
      "skill:browser",
    ]);
  });
});

describe(searchSkills, () => {
  const skills = [
    skill("review", "Review a change"),
    skill("unslop", "Cut AI tells from writing"),
    skill("browser", "Open and control the in-app browser"),
  ];

  it("lists every skill for a bare $", () => {
    assert.strictEqual(searchSkills(skills, "$").length, 3);
  });

  it("ranks by name before description", () => {
    assert.deepStrictEqual(
      searchSkills(skills, "$rev").map(({ name }) => name),
      ["review"]
    );
    assert.deepStrictEqual(
      searchSkills(skills, "writing").map(({ name }) => name),
      ["unslop"]
    );
  });

  it("respects the limit", () => {
    assert.strictEqual(searchSkills(skills, "", 2).length, 2);
  });
});
